import { randomUUID } from "node:crypto";
import {
  envelope,
  assertInvokeRequest,
  modelPartsFromInput,
  failurePayload,
  contextHash,
  isTerminal,
  type ContextEnvelope,
  type CanonicalEvent,
  type EventEnvelope,
  type InvokeRequest
} from "@mininglamp-oss/octo-harness-protocol";
import { composeContext } from "./prompt.js";
import {
  assertLocalAgentConfig,
  assertLocalContext,
  assertRunSnapshot,
  hashLocalValue,
  localRuntimeLimits,
  resolveLocalContext,
  type LocalAgentConfig
} from "./context.js";
import type { Agent, AgentRun, AgentRunTrigger, AgentSession, Store } from "./store.js";

const id = (prefix: string): string => `${prefix}_${randomUUID()}`;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export interface HarnessHost {
  list(): Array<{ type: string }> | Promise<Array<{ type: string }>>;
  invoke(
    adapterType: string,
    request: InvokeRequest,
    options: { protocolMode: "canonical" }
  ): AsyncIterable<CanonicalEvent>;
  cancel(
    invocationId: string,
    reason?: string
  ): boolean | { cancelled: boolean } | Promise<boolean | { cancelled: boolean }>;
}

export interface RegisterAgentInput {
  id?: string;
  name: string;
  agentSource: "preset" | "provisioned";
  defaultContext: ContextEnvelope;
  config?: LocalAgentConfig;
}

export interface ReplaceDefaultContextInput {
  agentId: string;
  expectedVersion: number;
  context: ContextEnvelope;
}

export interface SubmitAgentRunInput {
  namespace: string;
  agentId: string;
  sessionId?: string;
  conversationId?: string;
  trigger: AgentRunTrigger;
  input: Record<string, unknown>;
  context: ContextEnvelope;
}

export interface SubmitAgentRunResult {
  agentSession: AgentSession;
  agentRun: AgentRun;
  deduplicated: boolean;
}

/**
 * Provider-neutral reference executor for the unified Session/Run contract.
 * Business schedulers create occurrences outside Harness; this class only
 * validates, deduplicates, queues and executes the supplied AgentRun.
 */
export class HarnessEngine {
  readonly store: Store;
  readonly host: HarnessHost;

  constructor({ store, host }: { store: Store; host: HarnessHost }) {
    this.store = store;
    this.host = host;
  }

  async registerAgent(input: RegisterAgentInput): Promise<Agent> {
    if (
      !input ||
      Object.keys(input).some(
        (name) => !["id", "name", "agentSource", "defaultContext", "config"].includes(name)
      )
    )
      throw new TypeError("LEGACY_AGENT_CONTRACT_REJECTED");
    input = structuredClone(input);
    if (!input.name) throw new Error("agent name is required");
    assertLocalAgentConfig(input.config === undefined ? {} : input.config);
    const resolved = resolveLocalContext(
      input.defaultContext,
      { schema: "octo.context-envelope/v3", items: [] },
      input.agentSource
    );
    const adapters = await this.host.list();
    assertLoadedAdapter(adapters, resolved.resolvedExecutionPlan.adapter_type);
    const agent: Agent = {
      id: input.id ?? id("agent"),
      name: input.name,
      agentSource: input.agentSource,
      capabilities: ["react"],
      adapterType: resolved.resolvedExecutionPlan.adapter_type,
      config: structuredClone(input.config ?? {}),
      defaultContext: resolved.effectiveContext,
      contextDefaultsVersion: 1
    };
    await this.store.transaction(() => {
      if (this.store.hasAgent(agent.id)) throw new Error("AGENT_ALREADY_REGISTERED");
      this.store.putAgent(agent);
    });
    return agent;
  }

  async replaceDefaultContext(input: ReplaceDefaultContextInput): Promise<Agent> {
    input = structuredClone(input);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
      throw new TypeError("CONTEXT_DEFAULTS_VERSION_REQUIRED");
    const current = this.store.getAgent(input.agentId);
    if (!current) throw new Error(`agent not found: ${input.agentId}`);
    const resolved = resolveLocalContext(
      input.context,
      { schema: "octo.context-envelope/v3", items: [] },
      current.agentSource
    );
    const adapters = await this.host.list();
    assertLoadedAdapter(adapters, resolved.resolvedExecutionPlan.adapter_type);
    let updated!: Agent;
    await this.store.transaction(() => {
      const agent = this.store.getAgent(input.agentId);
      if (!agent) throw new Error(`agent not found: ${input.agentId}`);
      if (agent.contextDefaultsVersion !== input.expectedVersion)
        throw new Error("CONTEXT_DEFAULTS_VERSION_CONFLICT");
      assertMaterializationAdapter(agent, resolved.resolvedExecutionPlan.adapter_type);
      updated = {
        ...agent,
        defaultContext: resolved.effectiveContext,
        contextDefaultsVersion: agent.contextDefaultsVersion + 1
      };
      this.store.putAgent(updated);
    });
    return updated;
  }

  async submitAgentRun(input: SubmitAgentRunInput): Promise<SubmitAgentRunResult> {
    if (input)
      input = {
        ...input,
        sessionId: input.sessionId === undefined ? input.conversationId : input.sessionId
      };
    validateSubmission(input);
    input = structuredClone(input);
    const requestHash = hashLocalValue({ ...input, context: contextHash(input.context) });
    const duplicate = await this.store.transaction(() =>
      existingSubmission(this.store, input, requestHash)
    );
    if (duplicate) return duplicate;
    const registered = this.store.getAgent(input.agentId);
    if (!registered) throw new Error(`agent not found: ${input.agentId}`);
    const selectedAdapter = resolveLocalContext(
      registered.defaultContext,
      input.context,
      registered.agentSource
    ).resolvedExecutionPlan.adapter_type;
    const adapters =
      selectedAdapter === registered.adapterType ? undefined : await this.host.list();
    let result!: SubmitAgentRunResult;
    await this.store.transaction(() => {
      let session = this.store.getAgentSessionByKey(
        input.namespace,
        input.agentId,
        input.sessionId!
      );
      const existing = existingSubmission(this.store, input, requestHash);
      if (existing) {
        result = existing;
        return;
      }
      const agent = this.store.getAgent(input.agentId);
      if (!agent) throw new Error(`agent not found: ${input.agentId}`);
      if (!Number.isSafeInteger(agent.contextDefaultsVersion) || agent.contextDefaultsVersion < 1)
        throw new TypeError("CONTEXT_DEFAULTS_VERSION_REQUIRED");
      assertLocalAgentConfig(agent.config);
      const resolved = resolveLocalContext(agent.defaultContext, input.context, agent.agentSource);
      if (resolved.resolvedExecutionPlan.adapter_type !== agent.adapterType)
        assertLoadedAdapter(adapters ?? [], resolved.resolvedExecutionPlan.adapter_type);
      assertMaterializationAdapter(agent, resolved.resolvedExecutionPlan.adapter_type);
      if (!session) {
        session = {
          id: id("asess"),
          namespace: input.namespace,
          agentId: input.agentId,
          sessionKey: input.sessionId!,
          status: "active",
          generation: 1,
          nextRunNo: 1,
          createdAt: Date.now()
        };
        this.store.putAgentSession(session);
      }
      const run: AgentRun = {
        id: id("arun"),
        agentSessionId: session.id,
        runNo: session.nextRunNo++,
        status: "queued",
        nextSeq: 1,
        trigger: { ...input.trigger, occurredAt: input.trigger.occurredAt ?? Date.now() },
        input: structuredClone(input.input),
        requestHash,
        context: structuredClone(input.context),
        contextDefaultsVersion: agent.contextDefaultsVersion,
        contextHash: contextHash(resolved.effectiveContext),
        ...resolved,
        materialization: {
          id: agent.id,
          name: agent.name,
          adapterType: agent.adapterType,
          config: structuredClone(agent.config)
        }
      };
      this.store.appendEvent(
        envelope(run, run.nextSeq++, {
          protocolVersion: 2,
          type: "run.queued",
          payload: {
            trigger_kind: run.trigger.kind,
            trigger_occurrence_id: run.trigger.occurrenceId
          }
        })
      );
      this.store.putAgentRun(run);
      this.store.putAgentSession(session);
      result = { agentSession: session, agentRun: run, deduplicated: false };
    });
    return result;
  }

  canExecute(runId: string): boolean {
    const run = this.store.getAgentRun(runId);
    if (!run || run.status !== "queued") return false;
    const session = this.store.getAgentSession(run.agentSessionId);
    if (!session || (session.activeRunId && session.activeRunId !== run.id)) return false;
    return !this.store
      .listAgentRuns()
      .some(
        (candidate) =>
          candidate.agentSessionId === run.agentSessionId &&
          candidate.runNo < run.runNo &&
          !TERMINAL.has(candidate.status)
      );
  }

  async executeRun(runId: string): Promise<{ run: AgentRun; events: EventEnvelope[] }> {
    let run!: AgentRun;
    let session!: AgentSession;
    // Claiming is one synchronous Store transaction. Do not move lookup or
    // eligibility checks outside this critical section or make the callback async.
    await this.store.transaction(() => {
      const candidate = this.store.getAgentRun(runId);
      if (!candidate) throw new Error(`agent run not found: ${runId}`);
      if (!this.canExecute(candidate.id)) {
        throw new Error(`agent run is not the executable session head: ${candidate.id}`);
      }
      const candidateSession = this.store.getAgentSession(candidate.agentSessionId);
      if (!candidateSession)
        throw new Error(`agent session not found: ${candidate.agentSessionId}`);
      assertRunSnapshot(candidate);

      candidate.status = "running";
      candidateSession.activeRunId = candidate.id;
      run = candidate;
      session = candidateSession;
      this.store.appendEvent(
        envelope(run, run.nextSeq++, { protocolVersion: 2, type: "run.started", payload: {} })
      );
      this.store.putAgentRun(run);
      this.store.putAgentSession(session);
    });

    try {
      return await this.#executeClaimedRun(run, session);
    } catch (error) {
      await this.terminalizeRun(run.id, {
        protocolVersion: 2,
        type: "run.failed",
        payload: failurePayload(error, {
          stage: "input_dispatch",
          defaultDomain: "runtime",
          runId: run.id
        })
      });
      throw error;
    }
  }

  async #executeClaimedRun(
    run: AgentRun,
    session: AgentSession
  ): Promise<{ run: AgentRun; events: EventEnvelope[] }> {
    const context = composeContext({
      agent: run.materialization,
      agentSession: session,
      agentRun: run
    });
    const plan = run.resolvedExecutionPlan;
    const configurationHash = hashLocalValue({ plan, config: run.materialization.config });
    const prompt = promptFromInput(run.input);
    const modelInputParts = modelPartsFromInput(run.input);
    const request: InvokeRequest = {
      protocolVersion: 2,
      agentSource: plan.agent_source,
      invocationId: id("invoke"),
      agentSessionId: session.id,
      runId: run.id,
      prompt,
      modelInput: prompt,
      ...(modelInputParts ? { modelInputParts } : {}),
      workdir: plan.workdir,
      context: structuredClone(run.effectiveContext),
      runMetadata: context,
      approvalMode: plan.approval_mode,
      controlInstructions: "",
      ...(session.providerSessionConfigurationHash === configurationHash
        ? { providerSession: structuredClone(session.providerSession) }
        : {}),
      runtimeLimits: localRuntimeLimits(plan),
      agentConfig: {
        ...structuredClone(run.materialization.config),
        ...(plan.provider_agent_id ? { providerAgentId: plan.provider_agent_id } : {}),
        workdir: plan.workdir,
        ...(plan.model ? { model: plan.model } : {}),
        ...(plan.effort ? { effort: plan.effort } : {})
      }
    };
    assertInvokeRequest(request);
    run.invocationId = request.invocationId;
    this.store.putAgentRun(run);
    for await (const event of this.host.invoke(plan.adapter_type, request, {
      protocolMode: "canonical"
    })) {
      await this.store.transaction(() => {
        this.store.appendEvent(envelope(run, run.nextSeq++, event));
        if (event.type === "session.update" && event.payload.providerSession) {
          session.providerSession = event.payload.providerSession;
          session.providerSessionConfigurationHash = configurationHash;
          this.store.putAgentSession(session);
        }
        if (isTerminal(event)) {
          run.status =
            event.type === "run.completed"
              ? "completed"
              : event.type === "run.cancelled"
                ? "cancelled"
                : "failed";
          delete session.activeRunId;
          this.store.putAgentSession(session);
        }
        if (isTerminal(event) || event.type === "session.update") this.store.putAgentRun(run);
      });
    }
    return { run, events: this.store.getEvents(run.id) };
  }

  async terminalizeRun(runId: string, event: CanonicalEvent): Promise<AgentRun | undefined> {
    if (!isTerminal(event)) throw new TypeError("terminal event required");
    const run = this.store.getAgentRun(runId);
    if (!run || TERMINAL.has(run.status)) return run;
    const session = this.store.getAgentSession(run.agentSessionId);
    run.status =
      event.type === "run.completed"
        ? "completed"
        : event.type === "run.cancelled"
          ? "cancelled"
          : "failed";
    await this.store.transaction(() => {
      this.store.appendEvent(envelope(run, run.nextSeq++, event));
      if (session?.activeRunId === run.id) {
        delete session.activeRunId;
        this.store.putAgentSession(session);
      }
      this.store.putAgentRun(run);
    });
    return run;
  }

  async cancelRun(
    runId: string,
    reason = "cancelled"
  ): Promise<{ cancelled: boolean; status: AgentRun["status"] }> {
    const run = this.store.getAgentRun(runId);
    if (!run) throw new Error(`agent run not found: ${runId}`);
    if (TERMINAL.has(run.status)) return { cancelled: false, status: run.status };
    if (run.status === "queued") {
      await this.terminalizeRun(run.id, {
        protocolVersion: 2,
        type: "run.cancelled",
        payload: { reason }
      });
      return { cancelled: true, status: "cancelled" };
    }
    if (!run.invocationId) throw new Error(`running agent run has no invocationId: ${run.id}`);
    const outcome = await this.host.cancel(run.invocationId, reason);
    return {
      cancelled: typeof outcome === "boolean" ? outcome : outcome.cancelled === true,
      status: run.status
    };
  }
}

function validateSubmission(input: SubmitAgentRunInput): void {
  if (
    !input ||
    Object.keys(input).some(
      (name) =>
        ![
          "namespace",
          "agentId",
          "sessionId",
          "conversationId",
          "trigger",
          "input",
          "context"
        ].includes(name)
    )
  )
    throw new TypeError("LEGACY_RUN_CONTRACT_REJECTED");
  assertLocalContext(input.context);
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(input.namespace)) throw new Error("invalid namespace");
  if (
    !input.agentId ||
    typeof input.sessionId !== "string" ||
    !input.sessionId ||
    Buffer.byteLength(input.sessionId) > 512 ||
    input.sessionId.trim() !== input.sessionId ||
    /[\u0000-\u001f\u007f-\u009f]/.test(input.sessionId)
  )
    throw new Error("agentId and opaque sessionId are required");
  if (
    input.conversationId !== undefined &&
    (typeof input.conversationId !== "string" ||
      !input.conversationId ||
      Buffer.byteLength(input.conversationId) > 512 ||
      input.conversationId.trim() !== input.conversationId ||
      /[\u0000-\u001f\u007f-\u009f]/.test(input.conversationId))
  )
    throw new Error("INVALID_CONVERSATION_ID");
  if (!input.trigger?.kind || !input.trigger.occurrenceId)
    throw new Error("trigger kind and occurrenceId are required");
  if (!input.input || typeof input.input !== "object" || Array.isArray(input.input))
    throw new Error("input must be an object");
  if (
    ["channel_context", "context_refs", "appendInstructions", "agentConfig", "approvalMode"].some(
      (name) => name in input.input
    )
  )
    throw new TypeError("LEGACY_RUN_CONTRACT_REJECTED");
}

function assertLoadedAdapter(adapters: Array<{ type: string }>, adapterType: string): void {
  if (!adapters.some((adapter) => adapter.type === adapterType))
    throw new Error(`adapter not loaded: ${adapterType}`);
}

function existingSubmission(
  store: Store,
  input: SubmitAgentRunInput,
  requestHash: string
): SubmitAgentRunResult | undefined {
  const session = store.getAgentSessionByKey(input.namespace, input.agentId, input.sessionId!);
  if (!session) return undefined;
  const run = store.getAgentRunByOccurrence(session.id, input.trigger.occurrenceId);
  if (!run) return undefined;
  assertRunSnapshot(run);
  if (run.requestHash !== requestHash)
    throw new Error("trigger occurrence was reused with a different AgentRun request");
  return { agentSession: session, agentRun: run, deduplicated: true };
}

function assertMaterializationAdapter(agent: Agent, adapterType: string): void {
  if (adapterType !== agent.adapterType && Object.keys(agent.config).length > 0)
    throw new TypeError("LOCAL_MATERIALIZATION_ADAPTER_MISMATCH");
}

function promptFromInput(input: Record<string, unknown>): string {
  if (Array.isArray(input.parts)) {
    const text = input.parts
      .flatMap((part: unknown) => {
        if (!part || typeof part !== "object" || Array.isArray(part)) return [];
        const value = part as Record<string, unknown>;
        return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
      })
      .join("\n");
    if (text) return text;
    if (
      input.parts.some(
        (part: unknown) =>
          part && typeof part === "object" && (part as Record<string, unknown>).type === "image"
      )
    )
      return "[Image input]";
  }
  for (const key of ["prompt", "instruction", "description"]) {
    if (typeof input[key] === "string" && input[key].trim()) return input[key].trim();
  }
  return JSON.stringify(input);
}

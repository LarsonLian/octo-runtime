import { createHash, randomUUID } from "node:crypto";
import {
  envelope,
  isTerminal,
  type AgentConfig,
  type CanonicalEvent,
  type EventEnvelope,
  type InvokeRequest
} from "@mininglamp-oss/octo-harness-protocol";
import { composeContext, renderPortableInstructions } from "./prompt.js";
import type { Agent, AgentRun, AgentRunTrigger, AgentSession, Store } from "./store.js";

const id = (prefix: string): string => `${prefix}_${randomUUID()}`;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export interface HarnessHost {
  list(): Array<{ type: string }> | Promise<Array<{ type: string }>>;
  invoke(adapterType: string, request: InvokeRequest): AsyncIterable<CanonicalEvent>;
  cancel(invocationId: string, reason?: string): boolean | { cancelled: boolean } | Promise<boolean | { cancelled: boolean }>;
}

export interface RegisterAgentInput {
  id?: string;
  name: string;
  adapterType: string;
  config?: AgentConfig;
}

export interface SubmitAgentRunInput {
  namespace: string;
  agentId: string;
  sessionKey: string;
  trigger: AgentRunTrigger;
  input: Record<string, unknown>;
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
    if (!input.name || !input.adapterType) throw new Error("agent name and adapterType are required");
    const adapters = await this.host.list();
    if (!adapters.some(item => item.type === input.adapterType)) {
      throw new Error(`adapter not loaded: ${input.adapterType}`);
    }
    const agent: Agent = {
      id: input.id ?? id("agent"),
      name: input.name,
      adapterType: input.adapterType,
      config: input.config ?? {}
    };
    await this.store.transaction(() => this.store.putAgent(agent));
    return agent;
  }

  async submitAgentRun(input: SubmitAgentRunInput): Promise<SubmitAgentRunResult> {
    validateSubmission(input);
    if (!this.store.hasAgent(input.agentId)) throw new Error(`agent not found: ${input.agentId}`);
    const requestHash = hashCanonical(input);
    let result!: SubmitAgentRunResult;
    await this.store.transaction(() => {
      let session = this.store.getAgentSessionByKey(input.namespace, input.agentId, input.sessionKey);
      if (!session) {
        session = {
          id: id("asess"),
          namespace: input.namespace,
          agentId: input.agentId,
          sessionKey: input.sessionKey,
          status: "active",
          generation: 1,
          nextRunNo: 1,
          createdAt: Date.now()
        };
        this.store.putAgentSession(session);
      }
      const existing = this.store.getAgentRunByOccurrence(session.id, input.trigger.occurrenceId);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new Error("trigger occurrence was reused with a different AgentRun request");
        }
        result = { agentSession: session, agentRun: existing, deduplicated: true };
        return;
      }
      const run: AgentRun = {
        id: id("arun"),
        agentSessionId: session.id,
        runNo: session.nextRunNo++,
        status: "queued",
        nextSeq: 1,
        trigger: { ...input.trigger, occurredAt: input.trigger.occurredAt ?? Date.now() },
        input: structuredClone(input.input),
        requestHash
      };
      this.store.appendEvent(envelope(run, run.nextSeq++, { protocolVersion: 2,
        type: "run.queued",
        payload: { trigger_kind: run.trigger.kind, trigger_occurrence_id: run.trigger.occurrenceId }
      }));
      this.store.putAgentRun(run);
      this.store.putAgentSession(session);
      result = { agentSession: session, agentRun: run, deduplicated: false };
    });
    return result;
  }

  canExecute(agentRunId: string): boolean {
    const run = this.store.getAgentRun(agentRunId);
    if (!run || run.status !== "queued") return false;
    const session = this.store.getAgentSession(run.agentSessionId);
    if (!session || (session.activeRunId && session.activeRunId !== run.id)) return false;
    return !this.store.listAgentRuns().some(candidate =>
      candidate.agentSessionId === run.agentSessionId &&
      candidate.runNo < run.runNo &&
      !TERMINAL.has(candidate.status)
    );
  }

  async executeRun(agentRunId: string): Promise<{ run: AgentRun; events: EventEnvelope[] }> {
    let run!: AgentRun;
    let session!: AgentSession;
    let agent!: Agent;
    // Claiming is one synchronous Store transaction. Do not move lookup or
    // eligibility checks outside this critical section or make the callback async.
    await this.store.transaction(() => {
      const candidate = this.store.getAgentRun(agentRunId);
      if (!candidate) throw new Error(`agent run not found: ${agentRunId}`);
      if (!this.canExecute(candidate.id)) {
        throw new Error(`agent run is not the executable session head: ${candidate.id}`);
      }
      const candidateSession = this.store.getAgentSession(candidate.agentSessionId);
      if (!candidateSession) throw new Error(`agent session not found: ${candidate.agentSessionId}`);
      const candidateAgent = this.store.getAgent(candidateSession.agentId);
      if (!candidateAgent) throw new Error(`agent not found: ${candidateSession.agentId}`);

      candidate.status = "running";
      candidateSession.activeRunId = candidate.id;
      run = candidate;
      session = candidateSession;
      agent = candidateAgent;
      this.store.appendEvent(envelope(run, run.nextSeq++, { protocolVersion: 2, type: "run.started", payload: {} }));
      this.store.putAgentRun(run);
      this.store.putAgentSession(session);
    });

    const context = composeContext({ agent, agentSession: session, agentRun: run });
    const prompt = promptFromInput(run.input);
    const request: InvokeRequest = { protocolVersion: 2,
      invocationId: id("invoke"),
      agentSessionId: session.id,
      runId: run.id,
      prompt,
      workdir: agent.config.workdir ?? process.cwd(),
      context,
      appendInstructions: renderPortableInstructions(context),
      providerSession: session.providerSession,
      agentConfig: agent.config
    };
    run.invocationId = request.invocationId;
    this.store.putAgentRun(run);
    for await (const event of this.host.invoke(agent.adapterType, request)) {
      await this.store.transaction(() => {
        this.store.appendEvent(envelope(run, run.nextSeq++, event));
        if (event.type === "session.update" && event.payload.providerSession) {
          session.providerSession = event.payload.providerSession;
          this.store.putAgentSession(session);
        }
        if (isTerminal(event)) {
          run.status = event.type === "run.completed" ? "completed" : event.type === "run.cancelled" ? "cancelled" : "failed";
          delete session.activeRunId;
          this.store.putAgentSession(session);
        }
        this.store.putAgentRun(run);
      });
    }
    return { run, events: this.store.getEvents(run.id) };
  }

  async terminalizeRun(agentRunId: string, event: CanonicalEvent): Promise<AgentRun | undefined> {
    if (!isTerminal(event)) throw new TypeError("terminal event required");
    const run = this.store.getAgentRun(agentRunId);
    if (!run || TERMINAL.has(run.status)) return run;
    const session = this.store.getAgentSession(run.agentSessionId);
    run.status = event.type === "run.completed" ? "completed" : event.type === "run.cancelled" ? "cancelled" : "failed";
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

  async cancelRun(agentRunId: string, reason = "cancelled"): Promise<{ cancelled: boolean; status: AgentRun["status"] }> {
    const run = this.store.getAgentRun(agentRunId);
    if (!run) throw new Error(`agent run not found: ${agentRunId}`);
    if (TERMINAL.has(run.status)) return { cancelled: false, status: run.status };
    if (run.status === "queued") {
      await this.terminalizeRun(run.id, { protocolVersion: 2, type: "run.cancelled", payload: { reason } });
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
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(input.namespace)) throw new Error("invalid namespace");
  if (!input.agentId || !input.sessionKey.startsWith("v1/")) throw new Error("agentId and canonical sessionKey are required");
  if (!input.trigger?.kind || !input.trigger.occurrenceId) throw new Error("trigger kind and occurrenceId are required");
  if (!input.input || Array.isArray(input.input)) throw new Error("input must be an object");
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)]));
  }
  return value;
}

function promptFromInput(input: Record<string, unknown>): string {
  for (const key of ["prompt", "instruction", "description"]) {
    if (typeof input[key] === "string" && input[key].trim()) return input[key].trim();
  }
  return JSON.stringify(input);
}

import {
  envelope,
  isTerminal,
  type AgentConfig,
  type CanonicalEvent,
  type InvokeRequest
} from "@orbtex-ai/orbtex-protocol";
import { randomUUID } from "node:crypto";
import { composeContext, renderPortableInstructions } from "./prompt.js";
import type {
  Agent,
  Attempt,
  Run,
  Session,
  Store,
  Task,
  Trigger,
  TriggerKind,
  TriggerOccurrence,
  TriggerTaskTemplate
} from "./store.js";

const id = (prefix: string): string => `${prefix}_${randomUUID()}`;

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

export interface CreateTriggerInput {
  id?: string;
  name: string;
  kind: TriggerKind;
  agentId: string;
  task: TriggerTaskTemplate;
  eventType?: string;
  filter?: Record<string, unknown>;
  everyMs?: number;
}

export interface TriggerInput {
  externalEventId: string;
  payload?: Record<string, unknown>;
}

export interface QueueTaskInput {
  occurrenceId?: string;
  sourceType?: string;
  sourceId?: string;
}

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
    if (!adapters.some(item => item.type === input.adapterType)) throw new Error(`adapter not loaded: ${input.adapterType}`);
    const agent: Agent = {
      id: input.id ?? id("agent"),
      name: input.name,
      adapterType: input.adapterType,
      config: input.config ?? {}
    };
    this.store.agents.set(agent.id, agent);
    await this.store.commit();
    return agent;
  }

  async createTrigger(input: CreateTriggerInput): Promise<Trigger> {
    if (!this.store.agents.has(input.agentId)) throw new Error(`agent not found: ${input.agentId}`);
    if (!input.task?.title || !input.task?.description) throw new Error("trigger.task title and description are required");
    if (!new Set<TriggerKind>(["manual", "event", "interval"]).has(input.kind)) throw new Error(`unsupported trigger kind: ${input.kind}`);
    if (input.kind === "event" && !input.eventType) throw new Error("event trigger requires eventType");
    if (input.kind === "interval" && (!Number.isFinite(input.everyMs) || (input.everyMs ?? 0) < 1000)) {
      throw new Error("interval trigger requires everyMs >= 1000");
    }
    const trigger: Trigger = { ...input, id: input.id ?? id("trigger"), enabled: true };
    this.store.triggers.set(trigger.id, trigger);
    await this.store.commit();
    return trigger;
  }

  async materializeTrigger(
    triggerId: string,
    { externalEventId, payload = {} }: TriggerInput
  ): Promise<{ deduplicated: boolean; occurrence: TriggerOccurrence; task: Task }> {
    const trigger = this.store.triggers.get(triggerId);
    if (!trigger?.enabled) throw new Error("trigger is missing or disabled");
    if (typeof externalEventId !== "string" || !externalEventId) throw new Error("externalEventId is required");
    const dedupeKey = `${triggerId}:${externalEventId}`;
    const existing = this.store.occurrences.get(dedupeKey);
    // 同一个外部事件只能物化一次，重试时返回原 task，避免重复执行副作用。
    if (existing) {
      const task = this.store.tasks.get(existing.taskId);
      if (!task) throw new Error(`deduplicated occurrence has no task: ${existing.id}`);
      return { deduplicated: true, occurrence: existing, task };
    }

    const taskId = id("task");
    const sessionId = id("session");
    const occurrence: TriggerOccurrence = {
      id: id("occ"),
      triggerId,
      externalEventId,
      kind: trigger.kind,
      payload,
      createdAt: Date.now(),
      taskId
    };
    const task: Task = {
      id: taskId,
      title: trigger.task.title,
      description: trigger.task.description,
      agentId: trigger.agentId,
      status: "queued",
      sessionId,
      createdAt: Date.now()
    };
    const session: Session = { id: sessionId, type: "task", status: "active" };
    this.store.occurrences.set(dedupeKey, occurrence);
    this.store.tasks.set(task.id, task);
    this.store.sessions.set(session.id, session);
    await this.store.commit();
    return { deduplicated: false, occurrence, task };
  }

  async createChatSession({
    agentId,
    title = "New chat",
    channel = "local"
  }: {
    agentId: string;
    title?: string;
    channel?: string;
  }): Promise<Session> {
    if (!this.store.agents.has(agentId)) throw new Error(`agent not found: ${agentId}`);
    const session: Session = {
      id: id("session"),
      type: "chat",
      agentId,
      title,
      channel,
      status: "active",
      createdAt: Date.now()
    };
    this.store.sessions.set(session.id, session);
    await this.store.commit();
    return session;
  }

  async queueChatTurn(sessionId: string, prompt: string): Promise<{ session: Session; run: Run }> {
    const session = this.store.sessions.get(sessionId);
    if (!session || session.type !== "chat") throw new Error(`chat session not found: ${sessionId}`);
    if (session.activeRunId) throw new Error(`chat already has an active run: ${session.activeRunId}`);
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("chat prompt is required");
    const run: Run = { id: id("run"), sessionId, status: "queued", nextSeq: 1, prompt };
    session.activeRunId = run.id;
    this.store.runs.set(run.id, run);
    this.store.appendEvent(envelope(run, run.nextSeq++, { type: "run.queued", payload: { sourceType: "chat" } }));
    await this.store.commit();
    return { session, run };
  }

  async queueTask(taskId: string, input: QueueTaskInput = {}): Promise<{ task: Task; attempt: Attempt; run: Run }> {
    const { occurrenceId, sourceType = "manual", sourceId } = input;
    const task = this.store.tasks.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.activeRunId) throw new Error(`task already has an active run: ${task.activeRunId}`);
    const prior = [...this.store.attempts.values()].filter(item => item.taskId === taskId);
    const attemptId = id("attempt");
    const runId = id("run");
    const attempt: Attempt = {
      id: attemptId,
      taskId,
      number: prior.length + 1,
      status: "queued",
      runId,
      triggerOccurrenceId: occurrenceId,
      sourceType,
      sourceId
    };
    const run: Run = { id: runId, sessionId: task.sessionId, attemptId, status: "queued", nextSeq: 1 };
    task.activeRunId = run.id;
    task.status = "queued";
    this.store.attempts.set(attempt.id, attempt);
    this.store.runs.set(run.id, run);
    this.store.appendEvent(envelope(run, run.nextSeq++, { type: "run.queued", payload: { attemptId: attempt.id } }));
    await this.store.commit();
    return { task, attempt, run };
  }

  async executeRun(
    runId: string,
    perTurn = ""
  ): Promise<{ task?: Task; attempt?: Attempt; run: Run; events: ReturnType<Store["events"]["get"]> }> {
    const run = this.store.runs.get(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    if (run.status !== "queued") throw new Error(`run is not queued: ${run.status}`);
    const attempt = run.attemptId ? this.store.attempts.get(run.attemptId) : undefined;
    const task = attempt ? this.store.tasks.get(attempt.taskId) : undefined;
    const session = this.store.sessions.get(run.sessionId);
    if (!session) throw new Error(`session not found for run: ${run.id}`);
    if (attempt && !task) throw new Error(`task not found for attempt: ${attempt.id}`);
    const agent = this.store.agents.get(task?.agentId ?? session.agentId ?? "");
    if (!agent) throw new Error(`agent not found for run: ${run.id}`);
    run.status = "running";
    if (attempt && task) {
      attempt.status = "running";
      task.status = "running";
    }
    this.store.appendEvent(envelope(run, run.nextSeq++, { type: "run.running", payload: {} }));
    await this.store.commit();

    // Chat 和 Task 到这里已经收敛成同一种 Run；差异只存在于上下文和提示词来源。
    const occurrence = attempt?.triggerOccurrenceId
      ? [...this.store.occurrences.values()].find(item => item.id === attempt.triggerOccurrenceId)
      : undefined;
    const context = composeContext({ agent, session, task, attempt, occurrence });
    const request: InvokeRequest = {
      invocationId: id("invoke"),
      sessionId: session.id,
      runId: run.id,
      prompt: task?.description ?? run.prompt ?? "",
      workdir: agent.config.workdir ?? process.cwd(),
      context,
      appendInstructions: renderPortableInstructions(context, perTurn),
      providerSession: session.providerSession,
      agentConfig: agent.config
    };
    run.invocationId = request.invocationId;
    for await (const event of this.host.invoke(agent.adapterType, request)) {
      this.store.appendEvent(envelope(run, run.nextSeq++, event));
      if (event.type === "session.update" && event.payload.providerSession) {
        // provider session 是恢复执行的旁路状态，不混进用户可见消息文本。
        session.providerSession = event.payload.providerSession;
      }
      if (isTerminal(event)) {
        run.status = event.type === "run.finished" ? "completed" : event.type === "run.stopped" ? "cancelled" : "failed";
        if (attempt && task) {
          attempt.status = run.status;
          task.status = run.status;
          delete task.activeRunId;
        } else {
          delete session.activeRunId;
        }
      }
      await this.store.commit();
    }
    return { task, attempt, run, events: this.store.events.get(run.id) };
  }

  async fire(triggerId: string, input: TriggerInput): Promise<unknown> {
    const created = await this.materializeTrigger(triggerId, input);
    if (created.deduplicated) return created;
    const queued = await this.queueTask(created.task.id, {
      occurrenceId: created.occurrence.id,
      sourceType: created.occurrence.kind,
      sourceId: created.occurrence.externalEventId
    });
    return { ...created, result: await this.executeRun(queued.run.id) };
  }

  async continueTask(
    taskId: string,
    { sourceType = "comment", sourceId, instructions = "" }: QueueTaskInput & { instructions?: string } = {}
  ): Promise<unknown> {
    const queued = await this.queueTask(taskId, { sourceType, sourceId });
    return this.executeRun(queued.run.id, instructions);
  }

  async sendChat(sessionId: string, prompt: string, instructions = ""): Promise<unknown> {
    const queued = await this.queueChatTurn(sessionId, prompt);
    return this.executeRun(queued.run.id, instructions);
  }

  async terminalizeRun(runId: string, event: CanonicalEvent): Promise<Run | undefined> {
    if (!isTerminal(event)) throw new TypeError("terminal event required");
    const run = this.store.runs.get(runId);
    if (!run || ["completed", "failed", "cancelled"].includes(run.status)) return run;
    const attempt = run.attemptId ? this.store.attempts.get(run.attemptId) : undefined;
    const task = attempt ? this.store.tasks.get(attempt.taskId) : undefined;
    const session = this.store.sessions.get(run.sessionId);
    this.store.appendEvent(envelope(run, run.nextSeq++, event));
    run.status = event.type === "run.finished" ? "completed" : event.type === "run.stopped" ? "cancelled" : "failed";
    if (attempt && task) {
      attempt.status = run.status;
      task.status = run.status;
      delete task.activeRunId;
    } else if (session) {
      delete session.activeRunId;
    }
    await this.store.commit();
    return run;
  }

  async cancelRun(runId: string, reason = "cancelled"): Promise<{ cancelled: boolean; status: Run["status"] }> {
    const run = this.store.runs.get(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    if (["completed", "failed", "cancelled"].includes(run.status)) return { cancelled: false, status: run.status };
    if (run.status === "queued") {
      await this.terminalizeRun(runId, { type: "run.stopped", payload: { reason } });
      return { cancelled: true, status: "cancelled" };
    }
    if (!run.invocationId) throw new Error(`running run has no invocationId: ${run.id}`);
    const outcome = await this.host.cancel(run.invocationId, reason);
    return {
      cancelled: typeof outcome === "boolean" ? outcome : outcome.cancelled === true,
      status: run.status
    };
  }
}

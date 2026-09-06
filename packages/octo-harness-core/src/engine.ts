import {
  envelope,
  isTerminal,
  type AgentConfig,
  type CanonicalEvent,
  type EventEnvelope,
  type InvokeRequest
} from "@mininglamp-oss/octo-harness-protocol";
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

/**
 * The provider execution port the Core depends on.
 * Both the in-process AdapterHost and the NDJSON RPC client implement these
 * methods, so the Core stays unaware of the transport.
 */
export interface HarnessHost {
  /** Return a minimal view of the loaded adapter metadata, used to validate an adapter type before registering an Agent. */
  list(): Array<{ type: string }> | Promise<Array<{ type: string }>>;
  /** Start a provider invocation and stream canonical events back in order. */
  invoke(adapterType: string, request: InvokeRequest): AsyncIterable<CanonicalEvent>;
  /** Request cancellation of an active invocation; the return value is only a cancel ACK, not a Run terminal. */
  cancel(invocationId: string, reason?: string): boolean | { cancelled: boolean } | Promise<boolean | { cancelled: boolean }>;
}

/** Input for registering a durable Agent; the Core generates an id when omitted. */
export interface RegisterAgentInput {
  id?: string;
  name: string;
  adapterType: string;
  config?: AgentConfig;
}

/** Input for creating a Trigger rule together with its Task template. */
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

/**
 * External input for one Trigger hit.
 * `externalEventId` must be stable within a single Trigger so webhook/scheduler
 * retries can be deduplicated.
 */
export interface TriggerInput {
  externalEventId: string;
  payload?: Record<string, unknown>;
}

/** Provenance recorded when creating a Task Attempt. */
export interface QueueTaskInput {
  occurrenceId?: string;
  sourceType?: string;
  sourceId?: string;
}

/**
 * The domain orchestration core of Octo Harness.
 *
 * It owns object relationships, state transitions, prompt/context assembly and
 * event persistence; background scheduling, socket/API and provider process
 * management belong to the daemon, the app and the Adapter Host respectively.
 */
export class HarnessEngine {
  readonly store: Store;
  readonly host: HarnessHost;

  constructor({ store, host }: { store: Store; host: HarnessHost }) {
    this.store = store;
    this.host = host;
  }

  /** Register an Agent; this only writes config and does not invoke the provider. */
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
    await this.store.transaction(() => this.store.putAgent(agent));
    return agent;
  }

  /** Create and enable a Trigger rule; no Task is materialized at creation time. */
  async createTrigger(input: CreateTriggerInput): Promise<Trigger> {
    if (!this.store.hasAgent(input.agentId)) throw new Error(`agent not found: ${input.agentId}`);
    if (!input.task?.title || !input.task?.description) throw new Error("trigger.task title and description are required");
    if (!new Set<TriggerKind>(["manual", "event", "interval"]).has(input.kind)) throw new Error(`unsupported trigger kind: ${input.kind}`);
    if (input.kind === "event" && !input.eventType) throw new Error("event trigger requires eventType");
    if (input.kind === "interval" && (!Number.isFinite(input.everyMs) || (input.everyMs ?? 0) < 1000)) {
      throw new Error("interval trigger requires everyMs >= 1000");
    }
    const trigger: Trigger = { ...input, id: input.id ?? id("trigger"), enabled: true };
    await this.store.transaction(() => this.store.putTrigger(trigger));
    return trigger;
  }

  /**
   * Idempotently materialize one Trigger hit into an Occurrence, a Task and a
   * task Session. This method only creates domain objects; it does not create
   * an Attempt/Run and does not execute the provider.
   */
  async materializeTrigger(
    triggerId: string,
    { externalEventId, payload = {} }: TriggerInput
  ): Promise<{ deduplicated: boolean; occurrence: TriggerOccurrence; task: Task }> {
    const trigger = this.store.getTrigger(triggerId);
    if (!trigger?.enabled) throw new Error("trigger is missing or disabled");
    if (typeof externalEventId !== "string" || !externalEventId) throw new Error("externalEventId is required");
    const existing = this.store.getOccurrenceByKey(triggerId, externalEventId);
    // An external event may only be materialized once; on retry we return the original task to avoid duplicate side effects.
    if (existing) {
      const task = this.store.getTask(existing.taskId);
      if (!task) throw new Error(`deduplicated occurrence has no task: ${existing.id}`);
      return { deduplicated: true, occurrence: existing, task };
    }

    const taskId = id("task");
    const sessionId = id("session");
    // The three objects are linked in one transaction, so we never leave a half-built Occurrence whose Task/Session is missing.
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
    await this.store.transaction(() => {
      this.store.putOccurrence(occurrence);
      this.store.putTask(task);
      this.store.putSession(session);
    });
    return { deduplicated: false, occurrence, task };
  }

  /** Create a long-lived Chat Session; each later `queueChatTurn` reuses this session and its provider session. */
  async createChatSession({
    agentId,
    title = "New chat",
    channel = "local"
  }: {
    agentId: string;
    title?: string;
    channel?: string;
  }): Promise<Session> {
    if (!this.store.hasAgent(agentId)) throw new Error(`agent not found: ${agentId}`);
    const session: Session = {
      id: id("session"),
      type: "chat",
      agentId,
      title,
      channel,
      status: "active",
      createdAt: Date.now()
    };
    await this.store.transaction(() => this.store.putSession(session));
    return session;
  }

  /**
   * Create a queued Run for one Chat turn and write `run.queued`.
   * It does not execute the provider, which lets the daemon persist first and ACK quickly.
   */
  async queueChatTurn(sessionId: string, prompt: string): Promise<{ session: Session; run: Run }> {
    const session = this.store.getSession(sessionId);
    if (!session || session.type !== "chat") throw new Error(`chat session not found: ${sessionId}`);
    // Concurrent calls on the same session would contend over the provider session/history, so the reference model serializes them.
    if (session.activeRunId) throw new Error(`chat already has an active run: ${session.activeRunId}`);
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("chat prompt is required");
    const run: Run = { id: id("run"), sessionId, status: "queued", nextSeq: 1, prompt };
    session.activeRunId = run.id;
    await this.store.transaction(() => {
      this.store.appendEvent(envelope(run, run.nextSeq++, { type: "run.queued", payload: { sourceType: "chat" } }));
      this.store.putRun(run);
      this.store.putSession(session);
    });
    return { session, run };
  }

  /**
   * Create the next Attempt and a queued Run for a Task.
   * Task continuation also calls this, but keeps reusing the original
   * Task.description as the stable user request.
   */
  async queueTask(taskId: string, input: QueueTaskInput = {}): Promise<{ task: Task; attempt: Attempt; run: Run }> {
    const { occurrenceId, sourceType = "manual", sourceId } = input;
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.activeRunId) throw new Error(`task already has an active run: ${task.activeRunId}`);
    const prior = this.store.listAttemptsByTask(taskId);
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
    await this.store.transaction(() => {
      this.store.appendEvent(envelope(run, run.nextSeq++, { type: "run.queued", payload: { attemptId: attempt.id } }));
      this.store.putAttempt(attempt);
      this.store.putRun(run);
      this.store.putTask(task);
    });
    return { task, attempt, run };
  }

  /**
   * Execute a queued Run: keep consuming Host events and commit to the Store
   * after every state change. `perTurn` is this turn's supplementary control
   * instruction and never overrides the Chat prompt or Task.description.
   */
  async executeRun(
    runId: string,
    perTurn = ""
  ): Promise<{ task?: Task; attempt?: Attempt; run: Run; events: EventEnvelope[] }> {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    if (run.status !== "queued") throw new Error(`run is not queued: ${run.status}`);
    const attempt = run.attemptId ? this.store.getAttempt(run.attemptId) : undefined;
    const task = attempt ? this.store.getTask(attempt.taskId) : undefined;
    const session = this.store.getSession(run.sessionId);
    if (!session) throw new Error(`session not found for run: ${run.id}`);
    if (attempt && !task) throw new Error(`task not found for attempt: ${attempt.id}`);
    const agent = this.store.getAgent(task?.agentId ?? session.agentId ?? "");
    if (!agent) throw new Error(`agent not found for run: ${run.id}`);
    // The running state must be persisted before the provider call; crash recovery can then tell a queued Run from one that started but lost contact.
    run.status = "running";
    if (attempt && task) {
      attempt.status = "running";
      task.status = "running";
    }
    await this.store.transaction(() => {
      this.store.appendEvent(envelope(run, run.nextSeq++, { type: "run.running", payload: {} }));
      this.store.putRun(run);
      if (attempt && task) {
        this.store.putAttempt(attempt);
        this.store.putTask(task);
      }
    });

    // By this point Chat and Task have converged into the same kind of Run; the difference is only the source of context and prompt.
    const occurrence = attempt?.triggerOccurrenceId
      ? this.store.findOccurrenceById(attempt.triggerOccurrenceId)
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
    // The Host guarantees the message lifecycle and exactly-once terminal; the Core only projects and persists domain state.
    for await (const event of this.host.invoke(agent.adapterType, request)) {
      await this.store.transaction(() => {
        this.store.appendEvent(envelope(run, run.nextSeq++, event));
        if (event.type === "session.update" && event.payload.providerSession) {
          // The provider session is side-channel state for resuming execution; it must not be mixed into user-visible message text.
          session.providerSession = event.payload.providerSession;
          this.store.putSession(session);
        }
        if (isTerminal(event)) {
          // A Run terminal projects onto the Attempt/Task at the same time and releases the session's single-active-Run lock.
          run.status = event.type === "run.finished" ? "completed" : event.type === "run.stopped" ? "cancelled" : "failed";
          if (attempt && task) {
            attempt.status = run.status;
            task.status = run.status;
            delete task.activeRunId;
            this.store.putAttempt(attempt);
            this.store.putTask(task);
          } else {
            delete session.activeRunId;
            this.store.putSession(session);
          }
        }
        this.store.putRun(run);
      });
    }
    return { task, attempt, run, events: this.store.getEvents(run.id) };
  }

  /** Convenience API: materialize a Trigger, create the Attempt/Run, and wait for the provider to finish. */
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

  /** Convenience API: create a new Attempt for an existing Task and run this turn's supplement as control instructions. */
  async continueTask(
    taskId: string,
    { sourceType = "comment", sourceId, instructions = "" }: QueueTaskInput & { instructions?: string } = {}
  ): Promise<unknown> {
    const queued = await this.queueTask(taskId, { sourceType, sourceId });
    return this.executeRun(queued.run.id, instructions);
  }

  /** Convenience API: queue and immediately execute a Chat turn. The daemon usually splits this into separate queue/execute calls. */
  async sendChat(sessionId: string, prompt: string, instructions = ""): Promise<unknown> {
    const queued = await this.queueChatTurn(sessionId, prompt);
    return this.executeRun(queued.run.id, instructions);
  }

  /**
   * Force a Run into a terminal state outside the provider stream, e.g. on
   * daemon restart or a background execution failure. A Run already in a
   * terminal state is left unchanged, so recovery can safely call this again.
   */
  async terminalizeRun(runId: string, event: CanonicalEvent): Promise<Run | undefined> {
    if (!isTerminal(event)) throw new TypeError("terminal event required");
    const run = this.store.getRun(runId);
    if (!run || ["completed", "failed", "cancelled"].includes(run.status)) return run;
    const attempt = run.attemptId ? this.store.getAttempt(run.attemptId) : undefined;
    const task = attempt ? this.store.getTask(attempt.taskId) : undefined;
    const session = this.store.getSession(run.sessionId);
    run.status = event.type === "run.finished" ? "completed" : event.type === "run.stopped" ? "cancelled" : "failed";
    await this.store.transaction(() => {
      this.store.appendEvent(envelope(run, run.nextSeq++, event));
      if (attempt && task) {
        attempt.status = run.status;
        task.status = run.status;
        delete task.activeRunId;
        this.store.putAttempt(attempt);
        this.store.putTask(task);
      } else if (session) {
        delete session.activeRunId;
        this.store.putSession(session);
      }
      this.store.putRun(run);
    });
    return run;
  }

  /**
   * Request cancellation of a Run. A queued Run can be terminalized directly; a
   * running Run only gets a cancel request sent to the Host, and its final state
   * still follows the `run.stopped/error/finished` event that arrives afterwards.
   */
  async cancelRun(runId: string, reason = "cancelled"): Promise<{ cancelled: boolean; status: Run["status"] }> {
    const run = this.store.getRun(runId);
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

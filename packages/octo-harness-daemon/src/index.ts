import { EventEmitter } from "node:events";
import type {
  HarnessEngine,
  QueueTaskInput,
  RunStatus,
  Store,
  TriggerInput
} from "@mininglamp-oss/octo-harness-core";

const TERMINAL: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled"]);

interface IngestEventInput {
  eventType: string;
  externalEventId: string;
  payload?: Record<string, unknown>;
}

interface ContinueTaskInput extends QueueTaskInput {
  instructions?: string;
}

/**
 * The single-node background orchestrator: it pushes already-persisted queued
 * Runs onto the event loop for background execution, and provides Trigger
 * scheduling, crash recovery, terminal waiting and cancellation entry points.
 */
export class HarnessDaemon extends EventEmitter {
  readonly #engine: HarnessEngine;
  readonly #store: Store;
  readonly #pending = new Map<string, Promise<unknown>>();
  readonly #waiters = new Map<string, Array<(result: unknown) => void>>();
  readonly #timers = new Map<string, NodeJS.Timeout>();

  constructor({ engine, store }: { engine: HarnessEngine; store: Store }) {
    super();
    this.#engine = engine;
    this.#store = store;
  }

  /** Resume queued work and explicitly mark as failed any running Run that cannot be re-attached. */
  async recover(): Promise<void> {
    // After a daemon restart we cannot pretend the old provider process is still alive; a running run must first be explicitly terminated.
    for (const run of this.#store.listRuns()) {
      if (run.status === "running") {
        await this.#engine.terminalizeRun(run.id, {
          type: "run.error",
          payload: { code: "daemon_restarted", message: "daemon restarted while provider was active" }
        });
      } else if (run.status === "queued") {
        this.#schedule(run.id);
      }
    }
    for (const task of this.#store.listTasks()) {
      if (task.status !== "queued" || task.activeRunId) continue;
      const occurrence = this.#store.findOccurrenceByTaskId(task.id);
      const queued = await this.#engine.queueTask(task.id, {
        occurrenceId: occurrence?.id,
        sourceType: occurrence?.kind ?? "recovery",
        sourceId: occurrence?.externalEventId
      });
      this.#schedule(queued.run.id);
    }
    this.startSchedulers();
  }

  /** Create this-process timers for enabled interval Triggers; calling again does not re-register. */
  startSchedulers(): void {
    for (const trigger of this.#store.listTriggers()) {
      const everyMs = trigger.everyMs;
      if (!trigger.enabled || trigger.kind !== "interval" || !everyMs || this.#timers.has(trigger.id)) continue;
      const timer = setInterval(() => {
        const bucket = Math.floor(Date.now() / everyMs);
        this.submitTrigger(trigger.id, {
          externalEventId: `interval:${bucket}`,
          payload: { scheduledAt: bucket * everyMs }
        }).catch((error: unknown) => this.emit("scheduler.error", { triggerId: trigger.id, error }));
      }, everyMs);
      this.#timers.set(trigger.id, timer);
    }
  }

  /** Stop the local interval timers; this does not forcibly kill provider invocations that have already started. */
  stop(): void {
    for (const timer of this.#timers.values()) clearInterval(timer);
    this.#timers.clear();
  }

  /** Match event Triggers and submit one idempotent execution per matched rule. */
  async ingestEvent({ eventType, externalEventId, payload = {} }: IngestEventInput): Promise<unknown[]> {
    if (!eventType || !externalEventId) throw new Error("eventType and externalEventId are required");
    const matched = this.#store.listTriggers().filter(trigger =>
      trigger.enabled &&
      trigger.kind === "event" &&
      trigger.eventType === eventType &&
      matchesFilter(payload, trigger.filter)
    );
    return Promise.all(matched.map(trigger => this.submitTrigger(trigger.id, { externalEventId, payload })));
  }

  /** Materialize a Trigger, queue the Run and return quickly; the provider runs in the background. */
  async submitTrigger(triggerId: string, input: TriggerInput): Promise<{
    accepted: boolean;
    deduplicated: boolean;
    taskId: string;
    runId?: string;
  }> {
    const created = await this.#engine.materializeTrigger(triggerId, input);
    if (created.deduplicated) {
      const run = this.#store.listRuns().find(item => {
        const attempt = item.attemptId ? this.#store.getAttempt(item.attemptId) : undefined;
        return attempt?.taskId === created.task.id;
      });
      return { accepted: false, deduplicated: true, taskId: created.task.id, runId: run?.id };
    }
    const queued = await this.#engine.queueTask(created.task.id, {
      occurrenceId: created.occurrence.id,
      sourceType: created.occurrence.kind,
      sourceId: created.occurrence.externalEventId
    });
    this.#schedule(queued.run.id);
    return { accepted: true, deduplicated: false, taskId: created.task.id, runId: queued.run.id };
  }

  /** Create a follow-up Attempt for an existing Task and hand this turn's instructions to background execution. */
  async continueTask(taskId: string, input: ContinueTaskInput = {}): Promise<{ accepted: true; taskId: string; runId: string }> {
    const queued = await this.#engine.queueTask(taskId, input);
    this.#schedule(queued.run.id, input.instructions ?? "");
    return { accepted: true, taskId, runId: queued.run.id };
  }

  /** Queue one Chat turn and return quickly, without waiting for the model result. */
  async submitChat(sessionId: string, prompt: string, instructions = ""): Promise<{
    accepted: true;
    sessionId: string;
    runId: string;
    agent: { id: string; name: string; adapterType: string };
  }> {
    const session = this.#store.getSession(sessionId);
    if (!session || session.type !== "chat") throw new Error(`chat session not found: ${sessionId}`);
    const agent = this.#store.getAgent(session.agentId ?? "");
    if (!agent) throw new Error(`agent not found for chat session: ${sessionId}`);
    const queued = await this.#engine.queueChatTurn(sessionId, prompt);
    this.#schedule(queued.run.id, instructions);
    return {
      accepted: true,
      sessionId,
      runId: queued.run.id,
      agent: { id: agent.id, name: agent.name, adapterType: agent.adapterType }
    };
  }

  #schedule(runId: string, instructions = ""): void {
    if (this.#pending.has(runId)) return;
    // ACK first, then enter the event loop to run the provider, so a long task does not block control requests.
    const job = new Promise<void>(resolve => setImmediate(resolve))
      .then(() => this.#engine.executeRun(runId, instructions))
      .catch(async (error: unknown) => {
        await this.#engine.terminalizeRun(runId, {
          type: "run.error",
          payload: { code: "daemon_execution_error", message: errorMessage(error) }
        });
        return { run: this.#store.getRun(runId), error };
      })
      .then(result => {
        this.emit("run.terminal", { runId, status: this.#store.getRun(runId)?.status });
        for (const resolve of this.#waiters.get(runId) ?? []) resolve(result);
        this.#waiters.delete(runId);
        return result;
      })
      .finally(() => this.#pending.delete(runId));
    this.#pending.set(runId, job);
  }

  /** Return immediately when the Run is already terminal, otherwise wait for the execution scheduled in this process to finish. */
  async waitForRun(runId: string): Promise<unknown> {
    const run = this.#store.getRun(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    if (TERMINAL.has(run.status)) return { run, events: this.#store.getEvents(runId) };
    return new Promise(resolve => {
      const waiters = this.#waiters.get(runId) ?? [];
      waiters.push(resolve);
      this.#waiters.set(runId, waiters);
    });
  }

  /** Hand the cancel request to Core/Host; a cancel ACK does not mean the Run is already terminal. */
  cancelRun(runId: string, reason?: string): ReturnType<HarnessEngine["cancelRun"]> {
    return this.#engine.cancelRun(runId, reason);
  }
}

function matchesFilter(payload: Record<string, unknown>, filter?: Record<string, unknown>): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([key, expected]) => payload[key] === expected);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

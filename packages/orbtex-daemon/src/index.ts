import { EventEmitter } from "node:events";
import type {
  HarnessEngine,
  QueueTaskInput,
  RunStatus,
  Store,
  TriggerInput
} from "@orbtex-ai/orbtex-core";

const TERMINAL: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled"]);

interface IngestEventInput {
  eventType: string;
  externalEventId: string;
  payload?: Record<string, unknown>;
}

interface ContinueTaskInput extends QueueTaskInput {
  instructions?: string;
}

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

  async recover(): Promise<void> {
    // daemon 重启后不能假装旧 provider 进程仍然存活；running run 必须先明确终止。
    for (const run of this.#store.runs.values()) {
      if (run.status === "running") {
        await this.#engine.terminalizeRun(run.id, {
          type: "run.error",
          payload: { code: "daemon_restarted", message: "daemon restarted while provider was active" }
        });
      } else if (run.status === "queued") {
        this.#schedule(run.id);
      }
    }
    for (const task of this.#store.tasks.values()) {
      if (task.status !== "queued" || task.activeRunId) continue;
      const occurrence = [...this.#store.occurrences.values()].find(item => item.taskId === task.id);
      const queued = await this.#engine.queueTask(task.id, {
        occurrenceId: occurrence?.id,
        sourceType: occurrence?.kind ?? "recovery",
        sourceId: occurrence?.externalEventId
      });
      this.#schedule(queued.run.id);
    }
    this.startSchedulers();
  }

  startSchedulers(): void {
    for (const trigger of this.#store.triggers.values()) {
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

  stop(): void {
    for (const timer of this.#timers.values()) clearInterval(timer);
    this.#timers.clear();
  }

  async ingestEvent({ eventType, externalEventId, payload = {} }: IngestEventInput): Promise<unknown[]> {
    if (!eventType || !externalEventId) throw new Error("eventType and externalEventId are required");
    const matched = [...this.#store.triggers.values()].filter(trigger =>
      trigger.enabled &&
      trigger.kind === "event" &&
      trigger.eventType === eventType &&
      matchesFilter(payload, trigger.filter)
    );
    return Promise.all(matched.map(trigger => this.submitTrigger(trigger.id, { externalEventId, payload })));
  }

  async submitTrigger(triggerId: string, input: TriggerInput): Promise<{
    accepted: boolean;
    deduplicated: boolean;
    taskId: string;
    runId?: string;
  }> {
    const created = await this.#engine.materializeTrigger(triggerId, input);
    if (created.deduplicated) {
      const run = [...this.#store.runs.values()].find(item => {
        const attempt = item.attemptId ? this.#store.attempts.get(item.attemptId) : undefined;
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

  async continueTask(taskId: string, input: ContinueTaskInput = {}): Promise<{ accepted: true; taskId: string; runId: string }> {
    const queued = await this.#engine.queueTask(taskId, input);
    this.#schedule(queued.run.id, input.instructions ?? "");
    return { accepted: true, taskId, runId: queued.run.id };
  }

  async submitChat(sessionId: string, prompt: string, instructions = ""): Promise<{ accepted: true; sessionId: string; runId: string }> {
    const queued = await this.#engine.queueChatTurn(sessionId, prompt);
    this.#schedule(queued.run.id, instructions);
    return { accepted: true, sessionId, runId: queued.run.id };
  }

  #schedule(runId: string, instructions = ""): void {
    if (this.#pending.has(runId)) return;
    // 先返回 ACK，再进入事件循环执行 provider，避免长任务阻塞控制请求。
    const job = new Promise<void>(resolve => setImmediate(resolve))
      .then(() => this.#engine.executeRun(runId, instructions))
      .catch(async (error: unknown) => {
        await this.#engine.terminalizeRun(runId, {
          type: "run.error",
          payload: { code: "daemon_execution_error", message: errorMessage(error) }
        });
        return { run: this.#store.runs.get(runId), error };
      })
      .then(result => {
        this.emit("run.terminal", { runId, status: this.#store.runs.get(runId)?.status });
        for (const resolve of this.#waiters.get(runId) ?? []) resolve(result);
        this.#waiters.delete(runId);
        return result;
      })
      .finally(() => this.#pending.delete(runId));
    this.#pending.set(runId, job);
  }

  async waitForRun(runId: string): Promise<unknown> {
    const run = this.#store.runs.get(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    if (TERMINAL.has(run.status)) return { run, events: this.#store.events.get(runId) ?? [] };
    return new Promise(resolve => {
      const waiters = this.#waiters.get(runId) ?? [];
      waiters.push(resolve);
      this.#waiters.set(runId, waiters);
    });
  }

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

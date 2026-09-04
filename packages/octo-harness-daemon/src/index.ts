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
 * 单节点后台编排器：把已持久化的 queued Run 放到事件循环后台执行，
 * 同时提供 Trigger 调度、崩溃恢复、终态等待和取消入口。
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

  /** 恢复 queued 工作，并把无法重新附着的 running Run 明确标记为失败。 */
  async recover(): Promise<void> {
    // daemon 重启后不能假装旧 provider 进程仍然存活；running run 必须先明确终止。
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

  /** 为 enabled interval Triggers 创建本进程定时器；重复调用不会重复注册。 */
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

  /** 停止本地 interval timers；不会强制终止已经启动的 provider invocation。 */
  stop(): void {
    for (const timer of this.#timers.values()) clearInterval(timer);
    this.#timers.clear();
  }

  /** 匹配 event Trigger，并为每个命中规则提交一次幂等执行。 */
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

  /** 物化 Trigger、排队 Run 并快速返回；provider 在后台执行。 */
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

  /** 为已有 Task 创建后续 Attempt，并把本轮 instructions 交给后台执行。 */
  async continueTask(taskId: string, input: ContinueTaskInput = {}): Promise<{ accepted: true; taskId: string; runId: string }> {
    const queued = await this.#engine.queueTask(taskId, input);
    this.#schedule(queued.run.id, input.instructions ?? "");
    return { accepted: true, taskId, runId: queued.run.id };
  }

  /** 为 Chat 排队一个 turn 并快速返回，不等待模型结果。 */
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
    // 先返回 ACK，再进入事件循环执行 provider，避免长任务阻塞控制请求。
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

  /** Run 已终态时立即返回，否则等待本进程调度的执行完成。 */
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

  /** 把取消请求转交 Core/Host；取消 ACK 不等于 Run 已经终态。 */
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

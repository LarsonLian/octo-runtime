import {
  envelope,
  isTerminal,
  type AgentConfig,
  type CanonicalEvent,
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
 * Core 依赖的 provider 执行端口。
 * 进程内 AdapterHost 和 NDJSON RPC client 都实现这组方法，因此 Core 不感知 Transport。
 */
export interface HarnessHost {
  /** 返回已经加载的 adapter metadata 最小视图，用于注册 Agent 前校验。 */
  list(): Array<{ type: string }> | Promise<Array<{ type: string }>>;
  /** 启动一次 provider invocation，并按顺序流式返回 canonical events。 */
  invoke(adapterType: string, request: InvokeRequest): AsyncIterable<CanonicalEvent>;
  /** 请求取消活动 invocation；返回值仅是取消 ACK，不是 Run 终态。 */
  cancel(invocationId: string, reason?: string): boolean | { cancelled: boolean } | Promise<boolean | { cancelled: boolean }>;
}

/** 注册持久 Agent 的输入；省略 id 时由 Core 生成。 */
export interface RegisterAgentInput {
  id?: string;
  name: string;
  adapterType: string;
  config?: AgentConfig;
}

/** 创建 Trigger 规则及其 Task 模板的输入。 */
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
 * 一次 Trigger 命中的外部输入。
 * `externalEventId` 必须在同一 Trigger 内稳定，供 webhook/调度重试去重。
 */
export interface TriggerInput {
  externalEventId: string;
  payload?: Record<string, unknown>;
}

/** 创建 Task Attempt 时记录的来源信息。 */
export interface QueueTaskInput {
  occurrenceId?: string;
  sourceType?: string;
  sourceId?: string;
}

/**
 * Octo Harness 的领域编排核心。
 *
 * 它负责对象关系、状态迁移、prompt/context 组装和事件持久化；后台调度、socket/API、
 * provider 进程管理分别属于 daemon、app 和 Adapter Host。
 */
export class HarnessEngine {
  readonly store: Store;
  readonly host: HarnessHost;

  constructor({ store, host }: { store: Store; host: HarnessHost }) {
    this.store = store;
    this.host = host;
  }

  /** 注册 Agent；只写配置，不会立即调用 provider。 */
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

  /** 创建并启用 Trigger 规则；不会在创建时物化 Task。 */
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

  /**
   * 把一次 Trigger 命中幂等地物化为 Occurrence、Task 和 task Session。
   * 该方法只创建领域对象，不创建 Attempt/Run，也不执行 provider。
   */
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
    // 三个对象在一次 commit 中建立关系，避免出现有 Occurrence 却找不到 Task/Session 的半成品。
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

  /** 创建长期 Chat Session；后续每次 `queueChatTurn` 都复用该 session/provider session。 */
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

  /**
   * 为 Chat 的一个 turn 创建 queued Run 并写入 `run.queued`。
   * 它不执行 provider，适合 daemon 先持久化再快速 ACK。
   */
  async queueChatTurn(sessionId: string, prompt: string): Promise<{ session: Session; run: Run }> {
    const session = this.store.sessions.get(sessionId);
    if (!session || session.type !== "chat") throw new Error(`chat session not found: ${sessionId}`);
    // 同一 session 并发调用会争用 provider session/history，因此 reference model 强制串行。
    if (session.activeRunId) throw new Error(`chat already has an active run: ${session.activeRunId}`);
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("chat prompt is required");
    const run: Run = { id: id("run"), sessionId, status: "queued", nextSeq: 1, prompt };
    session.activeRunId = run.id;
    this.store.runs.set(run.id, run);
    this.store.appendEvent(envelope(run, run.nextSeq++, { type: "run.queued", payload: { sourceType: "chat" } }));
    await this.store.commit();
    return { session, run };
  }

  /**
   * 为 Task 创建下一次 Attempt 与 queued Run。
   * Task continuation 会调用本方法，但继续沿用原 Task.description 作为稳定用户请求。
   */
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

  /**
   * 执行一个 queued Run，持续消费 Host 事件并在每次状态变化后提交 Store。
   * `perTurn` 是本次补充控制指令，不会覆盖 Chat prompt 或 Task.description。
   */
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
    // running 状态必须先于 provider 调用落盘；崩溃恢复才能区分 queued 与已启动但失联的 Run。
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
    // Host 保证消息生命周期和 terminal exactly-once；Core 只负责领域状态投影与持久化。
    for await (const event of this.host.invoke(agent.adapterType, request)) {
      this.store.appendEvent(envelope(run, run.nextSeq++, event));
      if (event.type === "session.update" && event.payload.providerSession) {
        // provider session 是恢复执行的旁路状态，不混进用户可见消息文本。
        session.providerSession = event.payload.providerSession;
      }
      if (isTerminal(event)) {
        // Run 终态同时投影到 Attempt/Task，并释放 session 的单活动 Run 锁。
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

  /** 同步便利 API：物化 Trigger、创建 Attempt/Run，并等待 provider 执行完成。 */
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

  /** 同步便利 API：为已有 Task 创建新 Attempt，并把本轮补充作为 control instructions 执行。 */
  async continueTask(
    taskId: string,
    { sourceType = "comment", sourceId, instructions = "" }: QueueTaskInput & { instructions?: string } = {}
  ): Promise<unknown> {
    const queued = await this.queueTask(taskId, { sourceType, sourceId });
    return this.executeRun(queued.run.id, instructions);
  }

  /** 同步便利 API：排队并立即执行一个 Chat turn。daemon 场景通常拆开调用 queue/execute。 */
  async sendChat(sessionId: string, prompt: string, instructions = ""): Promise<unknown> {
    const queued = await this.queueChatTurn(sessionId, prompt);
    return this.executeRun(queued.run.id, instructions);
  }

  /**
   * 在 provider stream 之外强制终态化 Run，例如 daemon 重启或后台执行异常。
   * 已处于终态的 Run 保持不变，因此恢复流程可以安全重复调用。
   */
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

  /**
   * 请求取消 Run。queued Run 可直接终态化；running Run 只向 Host 发取消请求，
   * 最终状态仍以随后到达的 `run.stopped/error/finished` 事件为准。
   */
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

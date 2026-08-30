import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentConfig, EventEnvelope, ProviderSession } from "@orbtex-ai/orbtex-protocol";

/** Trigger 的来源类型：人工触发、外部事件或本地间隔调度。 */
export type TriggerKind = "manual" | "event" | "interval";

/** Run 的完整状态机；terminal 状态为 completed、failed、cancelled。 */
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** 当前 reference model 让 Task 状态跟随最近一次 Attempt/Run。 */
export type TaskStatus = RunStatus;

/**
 * 可被 Chat 或 Task 选用的 Agent 配置。
 * Agent 只绑定 adapter 类型与配置，不代表一次执行，也不保存对话历史。
 */
export interface Agent {
  id: string;
  name: string;
  /** 对应 Adapter Host 中 `metadata.type`，不是 npm 包名。 */
  adapterType: string;
  config: AgentConfig;
}

/** Trigger 每次物化 Task 时复制的业务模板。 */
export interface TriggerTaskTemplate {
  title: string;
  /** Task 的稳定用户请求；Task continuation 不会改写它。 */
  description: string;
}

/**
 * 一个可重复触发的任务定义。
 * Trigger 是规则，不是执行记录；每次命中由 TriggerOccurrence 记录。
 */
export interface Trigger {
  id: string;
  name: string;
  enabled: boolean;
  kind: TriggerKind;
  agentId: string;
  task: TriggerTaskTemplate;
  eventType?: string;
  filter?: Record<string, unknown>;
  everyMs?: number;
}

/**
 * Trigger 对某个外部事件的一次命中记录。
 * Store 使用 `(triggerId, externalEventId)` 作为幂等键，避免 webhook/调度重试重复创建 Task。
 */
export interface TriggerOccurrence {
  id: string;
  triggerId: string;
  externalEventId: string;
  kind: TriggerKind;
  payload: Record<string, unknown>;
  createdAt: number;
  taskId: string;
}

/**
 * 持久业务任务。一个 Task 拥有一个长期 Session，可通过多个 Attempt 反复继续。
 */
export interface Task {
  id: string;
  title: string;
  description: string;
  agentId: string;
  status: TaskStatus;
  sessionId: string;
  createdAt: number;
  /** 非空时拒绝并发 Attempt，保证同一 Task 的 provider session 串行使用。 */
  activeRunId?: string;
}

/**
 * Task 的一次尝试。
 * Attempt 保存来源与编号；实际事件、取消和终态属于其一一对应的 Run。
 */
export interface Attempt {
  id: string;
  taskId: string;
  number: number;
  status: RunStatus;
  runId: string;
  triggerOccurrenceId?: string;
  sourceType: string;
  sourceId?: string;
}

/**
 * Chat 或 Task 的长期会话容器。
 * Chat 直接绑定 Agent；Task 通过 Task.agentId 解析 Agent，因此 task session 不重复保存 agentId。
 */
export interface Session {
  id: string;
  type: "chat" | "task";
  status: "active" | "closed";
  agentId?: string;
  title?: string;
  channel?: string;
  createdAt?: number;
  activeRunId?: string;
  /** Adapter 通过 `session.update` 上报的 opaque 恢复信息。 */
  providerSession?: ProviderSession;
}

/**
 * 一次可排队、执行、取消和终态化的业务执行。
 * Chat turn 直接保存 prompt；Task Run 通过 attemptId 找到 Task.description。
 */
export interface Run {
  id: string;
  sessionId: string;
  status: RunStatus;
  /** 下一个待分配的 event seq，从 1 开始，仅在本 Run 内递增。 */
  nextSeq: number;
  attemptId?: string;
  prompt?: string;
  /** Provider 调用开始后写入，供取消请求定位 Adapter Host invocation。 */
  invocationId?: string;
}

/** JSON Store 的版本化序列化形状；Map 使用 entries 数组保存。 */
export interface StoreSnapshot {
  agents: Array<[string, Agent]>;
  triggers: Array<[string, Trigger]>;
  occurrences: Array<[string, TriggerOccurrence]>;
  tasks: Array<[string, Task]>;
  attempts: Array<[string, Attempt]>;
  sessions: Array<[string, Session]>;
  runs: Array<[string, Run]>;
  events: Array<[string, EventEnvelope[]]>;
}

/**
 * Core 所需的最小持久化端口。
 * Map 让 reference implementation 保持简单；生产数据库实现可以在适配层维护等价索引。
 */
export interface Store {
  agents: Map<string, Agent>;
  triggers: Map<string, Trigger>;
  occurrences: Map<string, TriggerOccurrence>;
  tasks: Map<string, Task>;
  attempts: Map<string, Attempt>;
  sessions: Map<string, Session>;
  runs: Map<string, Run>;
  events: Map<string, EventEnvelope[]>;
  /** 以 `(runId, seq)` 去重追加事件；返回 false 表示该序号已经存在。 */
  appendEvent(event: EventEnvelope): boolean;
  /** 提交当前状态。Core 会在关键状态迁移和每个 provider event 后调用。 */
  commit(): Promise<void>;
}

/**
 * 无 I/O 的 Store，适合测试、示例和嵌入式短生命周期运行。
 * 进程退出后数据丢失，且不提供跨线程/跨进程并发控制。
 */
export class MemoryStore implements Store {
  agents = new Map<string, Agent>();
  triggers = new Map<string, Trigger>();
  occurrences = new Map<string, TriggerOccurrence>();
  tasks = new Map<string, Task>();
  attempts = new Map<string, Attempt>();
  sessions = new Map<string, Session>();
  runs = new Map<string, Run>();
  events = new Map<string, EventEnvelope[]>();

  appendEvent(event: EventEnvelope): boolean {
    const stream = this.events.get(event.runId) ?? [];
    if (stream.some(item => item.seq === event.seq)) return false;
    stream.push(event);
    this.events.set(event.runId, stream);
    return true;
  }

  /** 内存实现无需刷盘，但保留异步端口以便 Core 无差别使用持久 Store。 */
  async commit(): Promise<void> {}

  /** 生成与 JSON 文件格式兼容的当前状态快照。 */
  snapshot(): StoreSnapshot {
    return {
      agents: [...this.agents.entries()],
      triggers: [...this.triggers.entries()],
      occurrences: [...this.occurrences.entries()],
      tasks: [...this.tasks.entries()],
      attempts: [...this.attempts.entries()],
      sessions: [...this.sessions.entries()],
      runs: [...this.runs.entries()],
      events: [...this.events.entries()]
    };
  }
}

/**
 * 单进程、单 writer 的 JSON 文件 Store reference implementation。
 * 它演示恢复与原子替换，不替代生产数据库事务、lease 或 fencing。
 */
export class JsonFileStore extends MemoryStore {
  readonly #file: string;
  #writes: Promise<void> = Promise.resolve();

  constructor(file: string) {
    super();
    this.#file = file;
  }

  /** 打开已有 version=1 快照；文件不存在时返回空 Store。 */
  static async open(file: string): Promise<JsonFileStore> {
    const store = new JsonFileStore(file);
    try {
      const data = JSON.parse(await readFile(file, "utf8")) as Partial<StoreSnapshot> & { version?: number };
      if (data.version !== 1) throw new Error(`unsupported store version: ${data.version}`);
      store.agents = new Map(data.agents ?? []);
      store.triggers = new Map(data.triggers ?? []);
      store.occurrences = new Map(data.occurrences ?? []);
      store.tasks = new Map(data.tasks ?? []);
      store.attempts = new Map(data.attempts ?? []);
      store.sessions = new Map(data.sessions ?? []);
      store.runs = new Map(data.runs ?? []);
      store.events = new Map(data.events ?? []);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return store;
  }

  /** 把调用时的完整快照串行写入 mode 0600 临时文件，再原子替换目标文件。 */
  override async commit(): Promise<void> {
    const body = JSON.stringify({ version: 1, ...this.snapshot() }, null, 2) + "\n";
    // 串行化并发提交，再通过同目录 rename 原子替换，避免留下半写入的状态文件。
    this.#writes = this.#writes.then(async () => {
      await mkdir(dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.#file);
    });
    return this.#writes;
  }
}

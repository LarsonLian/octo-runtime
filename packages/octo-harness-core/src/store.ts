import type { DatabaseSync } from "node:sqlite";
import type { AgentConfig, EventEnvelope, ProviderSession } from "@mininglamp-oss/octo-harness-protocol";
import { openWalDatabase } from "./sqlite.js";

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

/**
 * Core 所需的持久化端口。
 *
 * 接口不再暴露内部集合：调用方通过 get/list/put 方法读写领域对象，用 `transaction` 把
 * 一次状态迁移涉及的多次写入合并成一个原子提交。持久实现（SQLite）据此做增量写入，
 * 不再每次都序列化全量快照。
 */
export interface Store {
  getAgent(id: string): Agent | undefined;
  hasAgent(id: string): boolean;
  listAgents(): Agent[];
  putAgent(agent: Agent): void;

  getTrigger(id: string): Trigger | undefined;
  listTriggers(): Trigger[];
  putTrigger(trigger: Trigger): void;

  /** 用幂等键 `(triggerId, externalEventId)` 查已物化的 occurrence。 */
  getOccurrenceByKey(triggerId: string, externalEventId: string): TriggerOccurrence | undefined;
  findOccurrenceById(id: string): TriggerOccurrence | undefined;
  findOccurrenceByTaskId(taskId: string): TriggerOccurrence | undefined;
  putOccurrence(occurrence: TriggerOccurrence): void;

  getTask(id: string): Task | undefined;
  listTasks(): Task[];
  putTask(task: Task): void;

  getAttempt(id: string): Attempt | undefined;
  listAttemptsByTask(taskId: string): Attempt[];
  putAttempt(attempt: Attempt): void;

  getSession(id: string): Session | undefined;
  listSessions(): Session[];
  putSession(session: Session): void;

  getRun(id: string): Run | undefined;
  hasRun(id: string): boolean;
  listRuns(): Run[];
  putRun(run: Run): void;

  getEvents(runId: string): EventEnvelope[];
  /** 以 `(runId, seq)` 去重追加事件；返回 false 表示该序号已经存在。 */
  appendEvent(event: EventEnvelope): boolean;

  /** 把 fn 中的写入合并成一个原子提交；实现失败时整体回滚。 */
  transaction<T>(fn: () => T): Promise<T>;
  /** 释放底层资源；内存实现为 no-op。 */
  close(): void;
}

/**
 * 无 I/O 的 Store，适合测试、示例和嵌入式短生命周期运行。
 * 进程退出后数据丢失，`transaction` 不提供真正的回滚，也不提供跨线程/跨进程并发控制。
 */
export class MemoryStore implements Store {
  readonly #agents = new Map<string, Agent>();
  readonly #triggers = new Map<string, Trigger>();
  readonly #occurrences = new Map<string, TriggerOccurrence>();
  readonly #tasks = new Map<string, Task>();
  readonly #attempts = new Map<string, Attempt>();
  readonly #sessions = new Map<string, Session>();
  readonly #runs = new Map<string, Run>();
  readonly #events = new Map<string, EventEnvelope[]>();

  getAgent(id: string): Agent | undefined { return this.#agents.get(id); }
  hasAgent(id: string): boolean { return this.#agents.has(id); }
  listAgents(): Agent[] { return [...this.#agents.values()]; }
  putAgent(agent: Agent): void { this.#agents.set(agent.id, agent); }

  getTrigger(id: string): Trigger | undefined { return this.#triggers.get(id); }
  listTriggers(): Trigger[] { return [...this.#triggers.values()]; }
  putTrigger(trigger: Trigger): void { this.#triggers.set(trigger.id, trigger); }

  getOccurrenceByKey(triggerId: string, externalEventId: string): TriggerOccurrence | undefined {
    for (const occurrence of this.#occurrences.values()) {
      if (occurrence.triggerId === triggerId && occurrence.externalEventId === externalEventId) return occurrence;
    }
    return undefined;
  }
  findOccurrenceById(id: string): TriggerOccurrence | undefined { return this.#occurrences.get(id); }
  findOccurrenceByTaskId(taskId: string): TriggerOccurrence | undefined {
    for (const occurrence of this.#occurrences.values()) {
      if (occurrence.taskId === taskId) return occurrence;
    }
    return undefined;
  }
  putOccurrence(occurrence: TriggerOccurrence): void { this.#occurrences.set(occurrence.id, occurrence); }

  getTask(id: string): Task | undefined { return this.#tasks.get(id); }
  listTasks(): Task[] { return [...this.#tasks.values()]; }
  putTask(task: Task): void { this.#tasks.set(task.id, task); }

  getAttempt(id: string): Attempt | undefined { return this.#attempts.get(id); }
  listAttemptsByTask(taskId: string): Attempt[] {
    return [...this.#attempts.values()].filter(attempt => attempt.taskId === taskId);
  }
  putAttempt(attempt: Attempt): void { this.#attempts.set(attempt.id, attempt); }

  getSession(id: string): Session | undefined { return this.#sessions.get(id); }
  listSessions(): Session[] { return [...this.#sessions.values()]; }
  putSession(session: Session): void { this.#sessions.set(session.id, session); }

  getRun(id: string): Run | undefined { return this.#runs.get(id); }
  hasRun(id: string): boolean { return this.#runs.has(id); }
  listRuns(): Run[] { return [...this.#runs.values()]; }
  putRun(run: Run): void { this.#runs.set(run.id, run); }

  getEvents(runId: string): EventEnvelope[] { return this.#events.get(runId) ?? []; }
  appendEvent(event: EventEnvelope): boolean {
    const stream = this.#events.get(event.runId) ?? [];
    if (stream.some(item => item.seq === event.seq)) return false;
    stream.push(event);
    this.#events.set(event.runId, stream);
    return true;
  }

  transaction<T>(fn: () => T): Promise<T> { return Promise.resolve(fn()); }
  close(): void {}
}

/**
 * 单进程、单 writer 的 SQLite (WAL) Store，是 daemon 的本地事实源。
 * 每次状态迁移只写本次事务涉及的行，不再序列化全量快照；崩溃后重开即恢复。
 */
export class SqliteStore implements Store {
  readonly #db: DatabaseSync;
  #depth = 0;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** 打开或创建 mode 0600 的数据库文件，应用 WAL/耐久 PRAGMA 并建表。 */
  static open(file: string): SqliteStore {
    const db = openWalDatabase(file);
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS triggers (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS occurrences (
        id TEXT PRIMARY KEY,
        trigger_id TEXT NOT NULL,
        external_event_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        json TEXT NOT NULL,
        UNIQUE (trigger_id, external_event_id)
      );
      CREATE INDEX IF NOT EXISTS occurrences_task ON occurrences (task_id);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attempts_task ON attempts (task_id);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
    `);
    return new SqliteStore(db);
  }

  getAgent(id: string): Agent | undefined { return this.#readOne<Agent>("agents", id); }
  hasAgent(id: string): boolean { return this.#exists("agents", id); }
  listAgents(): Agent[] { return this.#readAll<Agent>("agents"); }
  putAgent(agent: Agent): void { this.#upsert("agents", ["id"], [agent.id], agent); }

  getTrigger(id: string): Trigger | undefined { return this.#readOne<Trigger>("triggers", id); }
  listTriggers(): Trigger[] { return this.#readAll<Trigger>("triggers"); }
  putTrigger(trigger: Trigger): void { this.#upsert("triggers", ["id"], [trigger.id], trigger); }

  getOccurrenceByKey(triggerId: string, externalEventId: string): TriggerOccurrence | undefined {
    return this.#parse<TriggerOccurrence>(
      this.#db.prepare("SELECT json FROM occurrences WHERE trigger_id = ? AND external_event_id = ?")
        .get(triggerId, externalEventId)
    );
  }
  findOccurrenceById(id: string): TriggerOccurrence | undefined { return this.#readOne<TriggerOccurrence>("occurrences", id); }
  findOccurrenceByTaskId(taskId: string): TriggerOccurrence | undefined {
    return this.#parse<TriggerOccurrence>(
      this.#db.prepare("SELECT json FROM occurrences WHERE task_id = ? LIMIT 1").get(taskId)
    );
  }
  putOccurrence(occurrence: TriggerOccurrence): void {
    this.#db.prepare(
      `INSERT INTO occurrences (id, trigger_id, external_event_id, task_id, json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         trigger_id = excluded.trigger_id,
         external_event_id = excluded.external_event_id,
         task_id = excluded.task_id,
         json = excluded.json`
    ).run(occurrence.id, occurrence.triggerId, occurrence.externalEventId, occurrence.taskId, JSON.stringify(occurrence));
  }

  getTask(id: string): Task | undefined { return this.#readOne<Task>("tasks", id); }
  listTasks(): Task[] { return this.#readAll<Task>("tasks"); }
  putTask(task: Task): void { this.#upsert("tasks", ["id"], [task.id], task); }

  getAttempt(id: string): Attempt | undefined { return this.#readOne<Attempt>("attempts", id); }
  listAttemptsByTask(taskId: string): Attempt[] {
    return this.#db.prepare("SELECT json FROM attempts WHERE task_id = ?").all(taskId)
      .map(row => this.#parse<Attempt>(row)!);
  }
  putAttempt(attempt: Attempt): void {
    this.#db.prepare(
      `INSERT INTO attempts (id, task_id, json) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET task_id = excluded.task_id, json = excluded.json`
    ).run(attempt.id, attempt.taskId, JSON.stringify(attempt));
  }

  getSession(id: string): Session | undefined { return this.#readOne<Session>("sessions", id); }
  listSessions(): Session[] { return this.#readAll<Session>("sessions"); }
  putSession(session: Session): void {
    this.#db.prepare(
      `INSERT INTO sessions (id, type, json) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET type = excluded.type, json = excluded.json`
    ).run(session.id, session.type, JSON.stringify(session));
  }

  getRun(id: string): Run | undefined { return this.#readOne<Run>("runs", id); }
  hasRun(id: string): boolean { return this.#exists("runs", id); }
  listRuns(): Run[] { return this.#readAll<Run>("runs"); }
  putRun(run: Run): void { this.#upsert("runs", ["id"], [run.id], run); }

  getEvents(runId: string): EventEnvelope[] {
    return this.#db.prepare("SELECT json FROM events WHERE run_id = ? ORDER BY seq").all(runId)
      .map(row => this.#parse<EventEnvelope>(row)!);
  }
  appendEvent(event: EventEnvelope): boolean {
    const result = this.#db.prepare("INSERT OR IGNORE INTO events (run_id, seq, json) VALUES (?, ?, ?)")
      .run(event.runId, event.seq, JSON.stringify(event));
    return result.changes > 0;
  }

  transaction<T>(fn: () => T): Promise<T> {
    // 单连接、单 writer；SQLite 不支持事务嵌套，嵌套调用复用最外层事务。
    if (this.#depth > 0) {
      this.#depth += 1;
      try {
        return Promise.resolve(fn());
      } finally {
        this.#depth -= 1;
      }
    }
    this.#db.exec("BEGIN IMMEDIATE");
    this.#depth = 1;
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return Promise.resolve(result);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.#depth = 0;
    }
  }

  close(): void { this.#db.close(); }

  #readOne<T>(table: string, id: string): T | undefined {
    return this.#parse<T>(this.#db.prepare(`SELECT json FROM ${table} WHERE id = ?`).get(id));
  }
  #readAll<T>(table: string): T[] {
    return this.#db.prepare(`SELECT json FROM ${table}`).all().map(row => this.#parse<T>(row)!);
  }
  #exists(table: string, id: string): boolean {
    return this.#db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;
  }
  #upsert(table: string, keyColumns: string[], keyValues: string[], value: object): void {
    const columns = [...keyColumns, "json"];
    const placeholders = columns.map(() => "?").join(", ");
    this.#db.prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})
       ON CONFLICT(${keyColumns[0]}) DO UPDATE SET json = excluded.json`
    ).run(...keyValues, JSON.stringify(value));
  }
  #parse<T>(row: unknown): T | undefined {
    if (row === undefined || row === null) return undefined;
    const json = (row as { json?: unknown }).json;
    return typeof json === "string" ? JSON.parse(json) as T : undefined;
  }
}

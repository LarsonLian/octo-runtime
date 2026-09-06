import type { DatabaseSync } from "node:sqlite";
import type { AgentConfig, EventEnvelope, ProviderSession } from "@mininglamp-oss/octo-harness-protocol";
import { openWalDatabase } from "./sqlite.js";

/** Where a Trigger comes from: manual firing, an external event, or local interval scheduling. */
export type TriggerKind = "manual" | "event" | "interval";

/** The full Run state machine; the terminal states are completed, failed and cancelled. */
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** The current reference model has a Task's status follow its most recent Attempt/Run. */
export type TaskStatus = RunStatus;

/**
 * Agent config that a Chat or Task can select.
 * An Agent only binds an adapter type and its config; it is not an execution
 * and holds no conversation history.
 */
export interface Agent {
  id: string;
  name: string;
  /** Corresponds to `metadata.type` in the Adapter Host, not the npm package name. */
  adapterType: string;
  config: AgentConfig;
}

/** The business template a Trigger copies each time it materializes a Task. */
export interface TriggerTaskTemplate {
  title: string;
  /** The Task's stable user request; Task continuation never rewrites it. */
  description: string;
}

/**
 * A repeatable task definition.
 * A Trigger is a rule, not an execution record; each hit is recorded by a TriggerOccurrence.
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
 * One record of a Trigger hitting a specific external event.
 * The Store uses `(triggerId, externalEventId)` as an idempotency key so
 * webhook/scheduler retries do not create duplicate Tasks.
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
 * A durable business task. A Task owns one long-lived Session and can be
 * continued repeatedly through multiple Attempts.
 */
export interface Task {
  id: string;
  title: string;
  description: string;
  agentId: string;
  status: TaskStatus;
  sessionId: string;
  createdAt: number;
  /** When set, concurrent Attempts are rejected so a Task's provider session is used serially. */
  activeRunId?: string;
}

/**
 * One attempt at a Task.
 * An Attempt records provenance and a number; the actual events, cancellation
 * and terminal belong to its one-to-one Run.
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
 * The long-lived session container for a Chat or a Task.
 * A Chat binds an Agent directly; a Task resolves its Agent via Task.agentId,
 * so a task session does not store agentId again.
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
  /** Opaque resume info reported by the adapter via `session.update`. */
  providerSession?: ProviderSession;
}

/**
 * One business execution that can be queued, executed, cancelled and
 * terminalized. A Chat turn stores its prompt directly; a Task Run reaches
 * Task.description through attemptId.
 */
export interface Run {
  id: string;
  sessionId: string;
  status: RunStatus;
  /** The next event seq to assign; starts at 1 and increments only within this Run. */
  nextSeq: number;
  attemptId?: string;
  prompt?: string;
  /** Written once the provider call starts, so a cancel request can locate the Adapter Host invocation. */
  invocationId?: string;
}

/**
 * The persistence port the Core requires.
 *
 * The interface no longer exposes internal collections: callers read/write
 * domain objects through get/list/put methods and use `transaction` to merge
 * the several writes of one state transition into a single atomic commit. The
 * durable implementation (SQLite) writes incrementally on this basis instead of
 * serializing a full snapshot every time.
 */
export interface Store {
  getAgent(id: string): Agent | undefined;
  hasAgent(id: string): boolean;
  listAgents(): Agent[];
  putAgent(agent: Agent): void;

  getTrigger(id: string): Trigger | undefined;
  listTriggers(): Trigger[];
  putTrigger(trigger: Trigger): void;

  /** Look up an already materialized occurrence by the idempotency key `(triggerId, externalEventId)`. */
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
  /** Append an event deduped on `(runId, seq)`; returns false when that sequence already exists. */
  appendEvent(event: EventEnvelope): boolean;

  /** Merge the writes in fn into one atomic commit; the implementation rolls the whole thing back on failure. */
  transaction<T>(fn: () => T): Promise<T>;
  /** Release the underlying resources; a no-op for the in-memory implementation. */
  close(): void;
}

/**
 * An I/O-free Store, suited to tests, examples and embedded short-lived runs.
 * Data is lost after the process exits; `transaction` provides no real rollback
 * and no cross-thread/cross-process concurrency control.
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
 * A single-process, single-writer SQLite (WAL) Store — the daemon's local
 * source of truth. Each state transition writes only the rows involved in that
 * transaction rather than serializing a full snapshot, and reopening after a
 * crash recovers the state.
 */
export class SqliteStore implements Store {
  readonly #db: DatabaseSync;
  #depth = 0;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Open or create the mode-0600 database file, apply the WAL/durability PRAGMAs and create the tables. */
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
    // Single connection, single writer; SQLite does not support nested transactions, so nested calls reuse the outermost one.
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

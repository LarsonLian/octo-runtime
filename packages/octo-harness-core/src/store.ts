import type { DatabaseSync } from "node:sqlite";
import type { ContextEnvelope, EventEnvelope, ProviderSession, ResolvedExecutionPlan } from "@mininglamp-oss/octo-harness-protocol";
import { assertRunSnapshot, type LocalAgentConfig } from "./context.js";
import { openWalDatabase } from "./sqlite.js";

export type AgentRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** Local adapter materialization used only by the Runtime reference core. */
export interface Agent {
  id: string;
  name: string;
  agentSource: "preset" | "provisioned";
  capabilities: ["react"];
  adapterType: string;
  config: LocalAgentConfig;
  defaultContext: ContextEnvelope;
  contextDefaultsVersion: number;
}

export interface AgentSession {
  id: string;
  namespace: string;
  agentId: string;
  sessionKey: string;
  status: "active" | "closed";
  generation: number;
  nextRunNo: number;
  activeRunId?: string;
  providerSession?: ProviderSession;
  providerSessionConfigurationHash?: string;
  createdAt: number;
}

export interface AgentRunTrigger {
  kind: string;
  occurrenceId: string;
  occurredAt?: number;
}

export interface AgentRun {
  id: string;
  agentSessionId: string;
  runNo: number;
  status: AgentRunStatus;
  nextSeq: number;
  trigger: AgentRunTrigger;
  input: Record<string, unknown>;
  requestHash: string;
  readonly context: ContextEnvelope;
  readonly effectiveContext: ContextEnvelope;
  readonly contextDefaultsVersion: number;
  readonly contextHash: string;
  readonly resolvedExecutionPlan: Readonly<ResolvedExecutionPlan>;
  readonly materialization: Pick<Agent, "id" | "name" | "adapterType" | "config">;
  invocationId?: string;
}

export interface Store {
  getAgent(id: string): Agent | undefined;
  hasAgent(id: string): boolean;
  listAgents(): Agent[];
  putAgent(agent: Agent): void;
  getAgentSession(id: string): AgentSession | undefined;
  getAgentSessionByKey(namespace: string, agentId: string, sessionKey: string): AgentSession | undefined;
  listAgentSessions(): AgentSession[];
  putAgentSession(session: AgentSession): void;
  getAgentRun(id: string): AgentRun | undefined;
  getAgentRunByOccurrence(agentSessionId: string, occurrenceId: string): AgentRun | undefined;
  listAgentRuns(): AgentRun[];
  putAgentRun(run: AgentRun): void;
  getEvents(runId: string): EventEnvelope[];
  appendEvent(event: EventEnvelope): boolean;
  /** The callback is a synchronous critical section and must never return a Promise. */
  transaction<T>(fn: () => T): Promise<T>;
  close(): void;
}

export class MemoryStore implements Store {
  readonly #agents = new Map<string, Agent>();
  readonly #sessions = new Map<string, AgentSession>();
  readonly #runs = new Map<string, AgentRun>();
  readonly #events = new Map<string, EventEnvelope[]>();

  getAgent(id: string): Agent | undefined { return clone(this.#agents.get(id)); }
  hasAgent(id: string): boolean { return this.#agents.has(id); }
  listAgents(): Agent[] { return structuredClone([...this.#agents.values()]); }
  putAgent(agent: Agent): void { this.#agents.set(agent.id, structuredClone(agent)); }

  getAgentSession(id: string): AgentSession | undefined { return clone(this.#sessions.get(id)); }
  getAgentSessionByKey(namespace: string, agentId: string, sessionKey: string): AgentSession | undefined {
    return clone([...this.#sessions.values()].find(session =>
      session.namespace === namespace && session.agentId === agentId && session.sessionKey === sessionKey
    ));
  }
  listAgentSessions(): AgentSession[] { return structuredClone([...this.#sessions.values()]); }
  putAgentSession(session: AgentSession): void { this.#sessions.set(session.id, structuredClone(session)); }

  getAgentRun(id: string): AgentRun | undefined { return clone(this.#runs.get(id)); }
  getAgentRunByOccurrence(agentSessionId: string, occurrenceId: string): AgentRun | undefined {
    return clone([...this.#runs.values()].find(run =>
      run.agentSessionId === agentSessionId && run.trigger.occurrenceId === occurrenceId
    ));
  }
  listAgentRuns(): AgentRun[] { return structuredClone([...this.#runs.values()]); }
  putAgentRun(run: AgentRun): void {
    assertRunSnapshot(run, this.#runs.get(run.id));
    this.#runs.set(run.id, structuredClone(run));
  }

  getEvents(runId: string): EventEnvelope[] { return this.#events.get(runId) ?? []; }
  appendEvent(event: EventEnvelope): boolean {
    const stream = this.#events.get(event.runId) ?? [];
    if (stream.some(item => item.seq === event.seq)) return false;
    stream.push(event);
    this.#events.set(event.runId, stream);
    return true;
  }
  transaction<T>(fn: () => T): Promise<T> {
    return Promise.resolve(assertSynchronousTransactionResult(fn()));
  }
  close(): void {}
}

/** Breaking v1 store: only unified AgentSession and AgentRun state is persisted. */
export class SqliteStore implements Store {
  readonly #db: DatabaseSync;
  #depth = 0;
  #savepoint = 0;

  private constructor(db: DatabaseSync) { this.#db = db; }

  static open(file: string): SqliteStore {
    const db = openWalDatabase(file);
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_affinity_key TEXT NOT NULL,
        json TEXT NOT NULL,
        UNIQUE (namespace, agent_id, session_affinity_key)
      );
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        agent_session_id TEXT NOT NULL,
        trigger_occurrence_id TEXT NOT NULL,
        json TEXT NOT NULL,
        UNIQUE (agent_session_id, trigger_occurrence_id)
      );
      CREATE TABLE IF NOT EXISTS agent_run_events (
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

  getAgentSession(id: string): AgentSession | undefined { return this.#readOne<AgentSession>("agent_sessions", id); }
  getAgentSessionByKey(namespace: string, agentId: string, sessionKey: string): AgentSession | undefined {
    return this.#parse<AgentSession>(this.#db.prepare(
      "SELECT json FROM agent_sessions WHERE namespace = ? AND agent_id = ? AND session_affinity_key = ?"
    ).get(namespace, agentId, sessionKey));
  }
  listAgentSessions(): AgentSession[] { return this.#readAll<AgentSession>("agent_sessions"); }
  putAgentSession(session: AgentSession): void {
    this.#db.prepare(
      `INSERT INTO agent_sessions (id, namespace, agent_id, session_affinity_key, json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET namespace = excluded.namespace, agent_id = excluded.agent_id,
         session_affinity_key = excluded.session_affinity_key, json = excluded.json`
    ).run(session.id, session.namespace, session.agentId, session.sessionKey, JSON.stringify(session));
  }

  getAgentRun(id: string): AgentRun | undefined { return this.#readOne<AgentRun>("agent_runs", id); }
  getAgentRunByOccurrence(agentSessionId: string, occurrenceId: string): AgentRun | undefined {
    return this.#parse<AgentRun>(this.#db.prepare(
      "SELECT json FROM agent_runs WHERE agent_session_id = ? AND trigger_occurrence_id = ?"
    ).get(agentSessionId, occurrenceId));
  }
  listAgentRuns(): AgentRun[] { return this.#readAll<AgentRun>("agent_runs"); }
  putAgentRun(run: AgentRun): void {
    assertRunSnapshot(run, this.getAgentRun(run.id));
    this.#db.prepare(
      `INSERT INTO agent_runs (id, agent_session_id, trigger_occurrence_id, json) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET agent_session_id = excluded.agent_session_id,
         trigger_occurrence_id = excluded.trigger_occurrence_id, json = excluded.json`
    ).run(run.id, run.agentSessionId, run.trigger.occurrenceId, JSON.stringify(run));
  }

  getEvents(runId: string): EventEnvelope[] {
    return this.#db.prepare("SELECT json FROM agent_run_events WHERE run_id = ? ORDER BY seq").all(runId)
      .map(row => this.#parse<EventEnvelope>(row)!);
  }
  appendEvent(event: EventEnvelope): boolean {
    return this.#db.prepare(
      "INSERT OR IGNORE INTO agent_run_events (run_id, seq, json) VALUES (?, ?, ?)"
    ).run(event.runId, event.seq, JSON.stringify(event)).changes > 0;
  }

  transaction<T>(fn: () => T): Promise<T> {
    if (this.#depth > 0) {
      const savepoint = `octo_nested_${++this.#savepoint}`;
      this.#db.exec(`SAVEPOINT ${savepoint}`);
      this.#depth += 1;
      try {
        const result = assertSynchronousTransactionResult(fn());
        this.#db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return Promise.resolve(result);
      } catch (error) {
        this.#db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.#db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        throw normalizedError(error);
      } finally {
        this.#depth -= 1;
      }
    }
    this.#db.exec("BEGIN IMMEDIATE");
    this.#depth = 1;
    try {
      const result = assertSynchronousTransactionResult(fn());
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
    this.#db.prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
       ON CONFLICT(${keyColumns[0]}) DO UPDATE SET json = excluded.json`
    ).run(...keyValues, JSON.stringify(value));
  }
  #parse<T>(row: unknown): T | undefined {
    const json = (row as { json?: unknown } | undefined)?.json;
    return typeof json === "string" ? JSON.parse(json) as T : undefined;
  }
}

function assertSynchronousTransactionResult<T>(result: T): T {
  if (result !== null && (typeof result === "object" || typeof result === "function") &&
      "then" in result && typeof result.then === "function") {
    throw new TypeError("Store.transaction callback must be synchronous");
  }
  return result;
}

function normalizedError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

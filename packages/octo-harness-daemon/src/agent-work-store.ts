import { renameSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openWalDatabase } from "@mininglamp-oss/octo-harness-core";
import type { PreparedTaskMaterials } from "./task-materials.js";

/** One event staged before ACK, already carrying the lease/fencing and the stable
 * event_id needed for replay. */
export interface OutboxRow {
  runKey: string;
  seq: number;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: number;
  leaseId: string;
  fencingToken: number;
}

/** Input for creating or recovering an Agent Work run record. */
export interface AgentWorkRunInput {
  runKey: string;
  agentSessionKey?: string;
  commandKey: string;
  leaseId: string;
  fencingToken: number;
}

/** Persisted result of a deduplicated command hit. */
export interface CommandReceipt {
  commandKey: string;
  serverSeq: number;
  accepted: boolean;
  error?: Record<string, unknown>;
}

/** Result of advancing a cumulative watermark; `reason` flags out-of-range or
 * backwards (stale) ACKs so the caller can warn rather than silently ignore them. */
export type AckOutcome =
  | { advanced: true; through: number }
  | { advanced: false; reason: "unknown_run" | "stale" | "ack_beyond_produced" };

export interface DurableTerminal {
  seq: number;
  type: string;
  eventId: string;
  payload: Record<string, unknown>;
}

export type DurableAckInspection =
  | { advanced: true; through: number; terminal?: DurableTerminal }
  | { advanced: false; reason: "unknown_run" | "stale" | "ack_beyond_produced" };

const TERMINAL_EVENT_TYPES = new Set(["run.completed", "run.failed", "run.cancelled"]);
const LAST_ACKED_COMMAND_SEQ = "last_acked_command_seq";
/** Local retention (7 days) for command receipts and terminal runs; reconcile
 * deletes them once expired. Unacked outbox rows are never deleted by time. */
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface RunRow {
  next_seq: number;
  received_through_seq: number;
  durable_through_seq: number;
  terminal_seq: number | null;
  lease_id: string;
  fencing_token: number;
}

/**
 * Local durable outbox (SQLite WAL) for the Agent Work runtime.
 *
 * Each event is allocated a seq and written to the outbox inside a transaction
 * (the local durability point) before the sender transmits it; rows are deleted
 * only after a cloud ACK or explicit authoritative terminal reconciliation.
 * ACKs are cumulative: one `event.ack{run_key, seq}` means
 * the run is durable through seq, so keeping the existing wire shape stays
 * forward-compatible with cumulative ACK. Unacked events are never deleted by time.
 */
export class AgentWorkStore {
  readonly #db: DatabaseSync;
  readonly #file: string;
  readonly #quarantinedPath: string | undefined;

  private constructor(db: DatabaseSync, file: string, quarantinedPath?: string) {
    this.#db = db;
    this.#file = file;
    this.#quarantinedPath = quarantinedPath;
  }

  static open(file: string): AgentWorkStore {
    let db: DatabaseSync | undefined;
    try {
      db = openWalDatabase(file);
      initialize(db);
      return new AgentWorkStore(db, file);
    } catch (error) {
      if (!isCorruptDatabase(error)) {
        try { db?.close(); } catch { /* Preserve the original open/migration error. */ }
        throw error;
      }
      try { db?.close(); } catch { /* A corrupt handle may not close cleanly. */ }
      const quarantinedPath = quarantineDatabase(file);
      const replacement = openWalDatabase(file);
      initialize(replacement);
      return new AgentWorkStore(replacement, file, quarantinedPath);
    }
  }

  /** Non-empty when open isolated a corrupt database. The quarantined file is
   * retained for forensic recovery; callers should emit an operator alert. */
  get quarantinedPath(): string | undefined { return this.#quarantinedPath; }

  /** 按 Run 读取耐久材料快照；Context hash 不一致时拒绝，授权与正文完整性由准备入口复核。 */
  getTaskMaterialSnapshot(runKey: string, hash: string): PreparedTaskMaterials | undefined {
    const row = this.#db.prepare("SELECT context_hash, snapshot_json FROM task_material_snapshots WHERE run_key = ?").get(runKey) as
      { context_hash: string; snapshot_json: string } | undefined;
    if (!row) return undefined;
    if (row.context_hash !== hash) throw new TypeError("CONTEXT_MATERIAL_SNAPSHOT_CONFLICT");
    return JSON.parse(row.snapshot_json) as PreparedTaskMaterials;
  }

  /** 首次写入后固定正文；重复写入必须保持 Context hash 和序列化正文相同，否则报冲突。 */
  putTaskMaterialSnapshot(runKey: string, hash: string, value: PreparedTaskMaterials): void {
    const json = JSON.stringify(value);
    if (!runKey || !/^sha256:[a-f0-9]{64}$/.test(hash) || Buffer.byteLength(json) > 3 * 65536) throw new TypeError("TASK_MATERIAL_SNAPSHOT_INVALID");
    this.#db.prepare("INSERT OR IGNORE INTO task_material_snapshots (run_key, context_hash, snapshot_json, created_at) VALUES (?, ?, ?, ?)")
      .run(runKey, hash, json, Date.now());
    const prior = this.#db.prepare("SELECT context_hash, snapshot_json FROM task_material_snapshots WHERE run_key = ?").get(runKey) as { context_hash: string; snapshot_json: string };
    if (prior.context_hash !== hash || prior.snapshot_json !== json) throw new TypeError("CONTEXT_MATERIAL_SNAPSHOT_CONFLICT");
  }

  conversationWorkspace(scopeKey: string, candidatePath: string): { path: string; created: boolean } {
    const result = this.#db.prepare("INSERT OR IGNORE INTO conversation_workspaces (scope_key, path) VALUES (?, ?)").run(scopeKey, candidatePath);
    const row = this.#db.prepare("SELECT path FROM conversation_workspaces WHERE scope_key = ?").get(scopeKey) as { path: string };
    return { path: row.path, created: result.changes === 1 };
  }

  getCommandReceipt(commandKey: string): CommandReceipt | undefined {
    const row = this.#db.prepare(
      "SELECT command_key, server_seq, accepted, result_json FROM command_receipts WHERE command_key = ?"
    ).get(commandKey) as
      | { command_key: string; server_seq: number; accepted: number; result_json: string | null }
      | undefined;
    if (!row) return undefined;
    const error = row.result_json ? JSON.parse(row.result_json) as Record<string, unknown> : undefined;
    return { commandKey: row.command_key, serverSeq: row.server_seq, accepted: row.accepted === 1, error };
  }

  recordCommandReceipt(
    commandKey: string,
    serverSeq: number,
    accepted: boolean,
    error?: Record<string, unknown>,
    expiresAt?: number
  ): void {
    // Default 7-day retention keeps dedup working across restart; reconcile
    // deletes receipts once expired.
    const expiry = expiresAt ?? Date.now() + DEFAULT_RETENTION_MS;
    this.#db.prepare(
      `INSERT INTO command_receipts (command_key, server_seq, accepted, result_json, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(command_key) DO UPDATE SET
         server_seq = excluded.server_seq,
         accepted = excluded.accepted,
         result_json = excluded.result_json,
         expires_at = excluded.expires_at`
    ).run(commandKey, serverSeq, accepted ? 1 : 0, error ? JSON.stringify(error) : null, expiry);
  }

  get lastAckedCommandSeq(): number {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(LAST_ACKED_COMMAND_SEQ) as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : 0;
  }

  setLastAckedCommandSeq(seq: number): void {
    this.#db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(LAST_ACKED_COMMAND_SEQ, String(seq));
  }

  /** Create or recover a run; when it already exists only lease/fencing/status are
   * refreshed — seq and the ACK watermarks are never reset. */
  upsertRun(input: AgentWorkRunInput): void {
    this.#db.prepare(
      `INSERT INTO runs (run_key, agent_session_key, command_key, lease_id, fencing_token, status, next_seq, received_through_seq, durable_through_seq, updated_at)
       VALUES (?, ?, ?, ?, ?, 'running', 1, 0, 0, ?)
       ON CONFLICT(run_key) DO UPDATE SET
         lease_id = excluded.lease_id,
         fencing_token = excluded.fencing_token,
         status = 'running',
         updated_at = excluded.updated_at`
    ).run(input.runKey, input.agentSessionKey ?? null, input.commandKey, input.leaseId, input.fencingToken, Date.now());
  }

  runExists(runKey: string): boolean {
    return this.#db.prepare("SELECT 1 FROM runs WHERE run_key = ?").get(runKey) !== undefined;
  }

  /** Runs without a durable terminal ACK yet, used for replay after reconnect. */
  activeRunKeys(): string[] {
    return this.#db.prepare(
      "SELECT run_key FROM runs WHERE terminal_seq IS NULL OR durable_through_seq < terminal_seq"
    ).all().map(row => (row as { run_key: string }).run_key);
  }

  /** Terminal runs whose context commit decision can still arrive through a
   * durable ACK. Running work is protected by AgentWorkRuntime's live maps. */
  pendingTerminalAckRunIds(): string[] {
    return this.#db.prepare(
      "SELECT run_key FROM runs WHERE terminal_seq IS NOT NULL AND durable_through_seq < terminal_seq"
    ).all().map(row => (row as { run_key: string }).run_key);
  }

  /** Remove local execution state only after the Worker returns an explicit
   * authoritative terminal fact during reconnect reconciliation. */
  discardAuthoritativelyTerminalRun(runKey: string): boolean {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("DELETE FROM event_outbox WHERE run_key = ?").run(runKey);
      this.#db.prepare("DELETE FROM task_material_snapshots WHERE run_key = ?").run(runKey);
      const result = this.#db.prepare("DELETE FROM runs WHERE run_key = ?").run(runKey);
      this.#db.exec("COMMIT");
      return result.changes > 0;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Allocate the next seq, mint a stable event_id and append to the outbox in one
   * transaction; a terminal event also records terminal_seq. */
  allocateAndAppend(runKey: string, type: string, payload: Record<string, unknown>): { seq: number; eventId: string } {
    const run = this.#db.prepare("SELECT next_seq FROM runs WHERE run_key = ?").get(runKey) as
      | { next_seq: number }
      | undefined;
    if (!run) throw new Error(`agent work run not found: ${runKey}`);
    const seq = run.next_seq;
    const eventId = `event_${randomUUID()}`;
    const payloadJson = JSON.stringify(payload);
    const now = Date.now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(
        `INSERT INTO event_outbox (run_key, seq, event_id, event_type, payload_json, payload_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(runKey, seq, eventId, type, payloadJson, Buffer.byteLength(payloadJson), now);
      if (TERMINAL_EVENT_TYPES.has(type)) {
        this.#db.prepare("UPDATE runs SET next_seq = ?, terminal_seq = ?, status = ?, updated_at = ? WHERE run_key = ?")
          .run(seq + 1, seq, type, now, runKey);
      } else {
        this.#db.prepare("UPDATE runs SET next_seq = ?, updated_at = ? WHERE run_key = ?").run(seq + 1, now, runKey);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return { seq, eventId };
  }

  /** Return events still pending send in (run_key, seq) order: seq beyond the
   * run's connection-local received watermark. A new transport connection
   * rewinds received to durable because Worker memory may have been lost. */
  listSendable(limit: number): OutboxRow[] {
    return this.#db.prepare(
      `SELECT o.run_key, o.seq, o.event_id, o.event_type, o.payload_json, o.created_at, r.lease_id, r.fencing_token
       FROM event_outbox o JOIN runs r ON r.run_key = o.run_key
       WHERE o.seq > r.received_through_seq
       ORDER BY o.run_key, o.seq
       LIMIT ?`
    ).all(limit).map(raw => {
      const row = raw as {
        run_key: string; seq: number; event_id: string; event_type: string;
        payload_json: string; created_at: number; lease_id: string; fencing_token: number;
      };
      return {
        runKey: row.run_key,
        seq: row.seq,
        eventId: row.event_id,
        eventType: row.event_type,
        payload: JSON.parse(row.payload_json) as Record<string, unknown>,
        createdAt: row.created_at,
        leaseId: row.lease_id,
        fencingToken: row.fencing_token
      };
    });
  }

  markSent(runKey: string, seq: number, at = Date.now()): void {
    this.#db.prepare("UPDATE event_outbox SET last_sent_at = ?, send_attempts = send_attempts + 1 WHERE run_key = ? AND seq = ?")
      .run(at, runKey, seq);
  }

  /** Worker received state is memory-only. On every new WebSocket session,
   * replay everything not covered by the durable watermark. Duplicate rows
   * are harmless because Worker folds canonical seq idempotently. */
  prepareReplayAfterReconnect(at = Date.now()): number {
    return Number(this.#db.prepare(
      `UPDATE runs
       SET received_through_seq = durable_through_seq, updated_at = ?
       WHERE received_through_seq > durable_through_seq`
    ).run(at).changes);
  }

  /**
   * Advance the received watermark: the batch is safely held in Worker memory,
   * so the send window is released, but the outbox rows are NOT deleted — only
   * a durable ACK may delete them. Stale/out-of-range values are rejected.
   */
  advanceReceived(runKey: string, seq: number): AckOutcome {
    const run = this.#db.prepare(
      "SELECT next_seq, received_through_seq, durable_through_seq, terminal_seq FROM runs WHERE run_key = ?"
    ).get(runKey) as Pick<RunRow, "next_seq" | "received_through_seq" | "durable_through_seq" | "terminal_seq"> | undefined;
    if (!run) return { advanced: false, reason: "unknown_run" };
    if (seq > run.next_seq - 1) return { advanced: false, reason: "ack_beyond_produced" };
    if (seq <= run.received_through_seq) return { advanced: false, reason: "stale" };
    this.#db.prepare("UPDATE runs SET received_through_seq = ?, updated_at = ? WHERE run_key = ?").run(seq, Date.now(), runKey);
    return { advanced: true, through: seq };
  }

  /**
   * Advance the durable watermark: the aggregated business state is committed
   * cloud-side, so confirmed outbox rows can be deleted; terminal coverage
   * marks completed_at. This is the only path that deletes outbox rows.
   */
  advanceDurable(runKey: string, seq: number): AckOutcome {
    const run = this.#db.prepare(
      "SELECT next_seq, received_through_seq, durable_through_seq, terminal_seq FROM runs WHERE run_key = ?"
    ).get(runKey) as Pick<RunRow, "next_seq" | "received_through_seq" | "durable_through_seq" | "terminal_seq"> | undefined;
    if (!run) return { advanced: false, reason: "unknown_run" };
    if (seq > run.next_seq - 1) return { advanced: false, reason: "ack_beyond_produced" };
    if (seq <= run.durable_through_seq) return { advanced: false, reason: "stale" };
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("UPDATE runs SET durable_through_seq = ?, updated_at = ? WHERE run_key = ?").run(seq, Date.now(), runKey);
      this.#db.prepare("DELETE FROM event_outbox WHERE run_key = ? AND seq <= ?").run(runKey, seq);
      if (run.terminal_seq !== null && seq >= run.terminal_seq) {
        this.#db.prepare("UPDATE runs SET completed_at = ? WHERE run_key = ? AND completed_at IS NULL").run(Date.now(), runKey);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return { advanced: true, through: seq };
  }

  /**
   * Validate a durable ACK and inspect terminal coverage without mutating the
   * outbox. Callers can durably update a second database before advanceDurable;
   * a crash between those operations then leaves this terminal replayable.
   */
  inspectDurableAck(runKey: string, seq: number): DurableAckInspection {
    const run = this.#db.prepare(
      "SELECT next_seq, durable_through_seq, terminal_seq FROM runs WHERE run_key = ?"
    ).get(runKey) as Pick<RunRow, "next_seq" | "durable_through_seq" | "terminal_seq"> | undefined;
    if (!run) return { advanced: false, reason: "unknown_run" };
    if (seq > run.next_seq - 1) return { advanced: false, reason: "ack_beyond_produced" };
    if (seq <= run.durable_through_seq) return { advanced: false, reason: "stale" };
    const terminal = run.terminal_seq !== null && seq >= run.terminal_seq
      ? this.durableTerminal(runKey, seq)
      : undefined;
    return { advanced: true, through: seq, ...(terminal ? { terminal } : {}) };
  }

  durableTerminal(runKey: string, durableThrough: number): DurableTerminal | undefined {
    const row = this.#db.prepare(
      `SELECT o.seq, o.event_id, o.event_type, o.payload_json
       FROM event_outbox o JOIN runs r ON r.run_key = o.run_key
       WHERE o.run_key = ? AND r.terminal_seq = o.seq AND o.seq <= ?`
    ).get(runKey, durableThrough) as {
      seq: number;
      event_id: string;
      event_type: string;
      payload_json: string;
    } | undefined;
    return row ? { seq: row.seq,
      type: row.event_type,
      eventId: row.event_id,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>
    } : undefined;
  }

  /** Total bytes of unacked event bodies, used for the capacity watermark checks. */
  outboxBytes(): number {
    const row = this.#db.prepare("SELECT COALESCE(SUM(payload_bytes), 0) AS bytes FROM event_outbox").get() as { bytes: number };
    return row.bytes;
  }

  /** Age (ms) of the oldest unacked event; null when the outbox is empty. */
  oldestUnackedAgeMs(): number | null {
    const row = this.#db.prepare("SELECT MIN(created_at) AS oldest FROM event_outbox").get() as { oldest: number | null };
    return row.oldest === null ? null : Date.now() - row.oldest;
  }

  pendingCount(): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM event_outbox").get() as { n: number }).n;
  }

  /** Consistency sweep: delete rows already within the durable watermark and
   * expired metadata, checkpoint the WAL, and incrementally reclaim free pages. */
  reconcile(now = Date.now()): void {
    this.#db.prepare(
      `DELETE FROM event_outbox WHERE (run_key, seq) IN (
        SELECT o.run_key, o.seq FROM event_outbox o JOIN runs r ON r.run_key = o.run_key WHERE o.seq <= r.durable_through_seq
      )`
    ).run();
    // Expired command receipts and terminal runs past their local retention
    // (whose outbox has already drained) are no longer needed.
    this.#db.prepare("DELETE FROM command_receipts WHERE expires_at IS NOT NULL AND expires_at < ?").run(now);
    this.#db.prepare(
      `DELETE FROM runs
       WHERE completed_at IS NOT NULL AND completed_at < ?
         AND run_key NOT IN (SELECT run_key FROM event_outbox)`
    ).run(now - DEFAULT_RETENTION_MS);
    this.#db.prepare("DELETE FROM task_material_snapshots WHERE created_at < ? AND run_key NOT IN (SELECT run_key FROM runs)")
      .run(now - DEFAULT_RETENTION_MS);
    this.#db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    this.#db.exec("PRAGMA incremental_vacuum");
  }

  dbBytes(): number { return fileBytes(this.#file); }
  walBytes(): number { return fileBytes(`${this.#file}-wal`); }

  close(): void { this.#db.close(); }
}

function initialize(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_workspaces (
      scope_key TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS task_material_snapshots (
      run_key TEXT PRIMARY KEY,
      context_hash TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      run_key TEXT PRIMARY KEY,
      agent_session_key TEXT,
      command_key TEXT NOT NULL UNIQUE,
      lease_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      status TEXT NOT NULL,
      next_seq INTEGER NOT NULL DEFAULT 1,
      received_through_seq INTEGER NOT NULL DEFAULT 0,
      durable_through_seq INTEGER NOT NULL DEFAULT 0,
      terminal_seq INTEGER,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS event_outbox (
      run_key TEXT NOT NULL REFERENCES runs(run_key),
      seq INTEGER NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_sent_at INTEGER,
      send_attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_key, seq)
    );
    CREATE INDEX IF NOT EXISTS outbox_send_order ON event_outbox(run_key, seq);
    CREATE TABLE IF NOT EXISTS command_receipts (
      command_key TEXT PRIMARY KEY,
      server_seq INTEGER NOT NULL,
      accepted INTEGER NOT NULL,
      result_json TEXT,
      expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  migrateRunSessionColumn(db);
}

function migrateRunSessionColumn(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map(column => column.name)
  );
  if (columns.has("agent_session_key")) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE runs ADD COLUMN agent_session_key TEXT");
    if (columns.has("session_id")) {
      db.exec("UPDATE runs SET agent_session_key = session_id WHERE agent_session_key IS NULL");
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function isCorruptDatabase(error: unknown): boolean {
  const record = error as { code?: unknown; message?: unknown };
  return record?.code === "SQLITE_CORRUPT" || record?.code === "SQLITE_NOTADB"
    || /malformed|not a database|database disk image is malformed/i.test(String(record?.message ?? error));
}

function quarantineDatabase(file: string): string {
  const quarantinedPath = `${file}.corrupt-${Date.now()}`;
  for (const sidecar of ["", "-wal", "-shm"]) {
    try {
      renameSync(`${file}${sidecar}`, `${quarantinedPath}${sidecar}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return quarantinedPath;
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

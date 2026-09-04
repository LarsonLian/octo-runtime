import { statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openWalDatabase } from "@mininglamp-oss/octo-harness-core";

/** ACK 前暂存的一条待发送事件，已带上重放需要的 lease/fencing 与稳定 event_id。 */
export interface OutboxRow {
  runId: string;
  seq: number;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: number;
  leaseId: string;
  fencingToken: number;
}

/** 创建/恢复一个 Agent Work run 记录所需的输入。 */
export interface AgentWorkRunInput {
  runId: string;
  sessionId?: string;
  commandId: string;
  leaseId: string;
  fencingToken: number;
}

/** 一次 command 去重命中的持久化结果。 */
export interface CommandReceipt {
  commandId: string;
  serverSeq: number;
  accepted: boolean;
  error?: Record<string, unknown>;
}

/** 累计 ACK 推进的结果；`reason` 用于对越界/倒退 ACK 告警。 */
export type AckOutcome =
  | { advanced: true; through: number }
  | { advanced: false; reason: "unknown_run" | "stale" | "ack_beyond_produced" };

export interface DurableTerminal {
  seq: number;
  type: string;
}

export type DurableAckInspection =
  | { advanced: true; through: number; terminal?: DurableTerminal }
  | { advanced: false; reason: "unknown_run" | "stale" | "ack_beyond_produced" };

const TERMINAL_EVENT_TYPES = new Set(["run.completed", "run.failed", "run.cancelled"]);
const LAST_ACKED_COMMAND_SEQ = "last_acked_command_seq";
/** command receipt 与终态 run 的默认本地保留期（7 天），到期后由 reconcile 清理。 */
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
 * Agent Work runtime 的本地可靠 Outbox（SQLite WAL）。
 *
 * 事件先在事务中分配 seq + 写入 outbox（本地耐久点），再由 sender 发送；云端 ACK 后立即删除。
 * ACK 按“累计 through_seq”语义解释：一条 `event.ack{run_id, seq}` 表示该 run 到 seq 为止全部耐久，
 * 因此保持现有 wire 形状即可前向兼容累计 ACK。未 ACK 事件永不按时间删除。
 */
export class AgentWorkStore {
  readonly #db: DatabaseSync;
  readonly #file: string;

  private constructor(db: DatabaseSync, file: string) {
    this.#db = db;
    this.#file = file;
  }

  static open(file: string): AgentWorkStore {
    const db = openWalDatabase(file);
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT,
        command_id TEXT NOT NULL UNIQUE,
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
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_sent_at INTEGER,
        send_attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, seq)
      );
      CREATE INDEX IF NOT EXISTS outbox_send_order ON event_outbox(run_id, seq);
      CREATE TABLE IF NOT EXISTS command_receipts (
        command_id TEXT PRIMARY KEY,
        server_seq INTEGER NOT NULL,
        accepted INTEGER NOT NULL,
        result_json TEXT,
        expires_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    return new AgentWorkStore(db, file);
  }

  getCommandReceipt(commandId: string): CommandReceipt | undefined {
    const row = this.#db.prepare(
      "SELECT command_id, server_seq, accepted, result_json FROM command_receipts WHERE command_id = ?"
    ).get(commandId) as
      | { command_id: string; server_seq: number; accepted: number; result_json: string | null }
      | undefined;
    if (!row) return undefined;
    const error = row.result_json ? JSON.parse(row.result_json) as Record<string, unknown> : undefined;
    return { commandId: row.command_id, serverSeq: row.server_seq, accepted: row.accepted === 1, error };
  }

  recordCommandReceipt(
    commandId: string,
    serverSeq: number,
    accepted: boolean,
    error?: Record<string, unknown>,
    expiresAt?: number
  ): void {
    // 默认保留 7 天，重启后仍可去重；到期由 reconcile 清理。
    const expiry = expiresAt ?? Date.now() + DEFAULT_RETENTION_MS;
    this.#db.prepare(
      `INSERT INTO command_receipts (command_id, server_seq, accepted, result_json, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(command_id) DO UPDATE SET
         server_seq = excluded.server_seq,
         accepted = excluded.accepted,
         result_json = excluded.result_json,
         expires_at = excluded.expires_at`
    ).run(commandId, serverSeq, accepted ? 1 : 0, error ? JSON.stringify(error) : null, expiry);
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

  /** 创建或恢复 run；已存在时只刷新 lease/fencing/status，不重置 seq 与 ACK 水位。 */
  upsertRun(input: AgentWorkRunInput): void {
    this.#db.prepare(
      `INSERT INTO runs (run_id, session_id, command_id, lease_id, fencing_token, status, next_seq, received_through_seq, durable_through_seq, updated_at)
       VALUES (?, ?, ?, ?, ?, 'running', 1, 0, 0, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         lease_id = excluded.lease_id,
         fencing_token = excluded.fencing_token,
         status = 'running',
         updated_at = excluded.updated_at`
    ).run(input.runId, input.sessionId ?? null, input.commandId, input.leaseId, input.fencingToken, Date.now());
  }

  runExists(runId: string): boolean {
    return this.#db.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(runId) !== undefined;
  }

  /** Runs without a durable terminal ACK yet, used for replay after reconnect. */
  activeRunIds(): string[] {
    return this.#db.prepare(
      "SELECT run_id FROM runs WHERE terminal_seq IS NULL OR durable_through_seq < terminal_seq"
    ).all().map(row => (row as { run_id: string }).run_id);
  }

  /** 事务内分配 seq、生成稳定 event_id 并写入 outbox；terminal 事件记录 terminal_seq。 */
  allocateAndAppend(runId: string, type: string, payload: Record<string, unknown>): { seq: number; eventId: string } {
    const run = this.#db.prepare("SELECT next_seq FROM runs WHERE run_id = ?").get(runId) as
      | { next_seq: number }
      | undefined;
    if (!run) throw new Error(`agent work run not found: ${runId}`);
    const seq = run.next_seq;
    const eventId = `event_${randomUUID()}`;
    const payloadJson = JSON.stringify(payload);
    const now = Date.now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(
        `INSERT INTO event_outbox (run_id, seq, event_id, event_type, payload_json, payload_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(runId, seq, eventId, type, payloadJson, Buffer.byteLength(payloadJson), now);
      if (TERMINAL_EVENT_TYPES.has(type)) {
        this.#db.prepare("UPDATE runs SET next_seq = ?, terminal_seq = ?, status = ?, updated_at = ? WHERE run_id = ?")
          .run(seq + 1, seq, type, now, runId);
      } else {
        this.#db.prepare("UPDATE runs SET next_seq = ?, updated_at = ? WHERE run_id = ?").run(seq + 1, now, runId);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return { seq, eventId };
  }

  /** Return events still pending send in (run_id, seq) order: seq beyond the
   * run's connection-local received watermark. A new transport connection
   * rewinds received to durable because Worker memory may have been lost. */
  listSendable(limit: number): OutboxRow[] {
    return this.#db.prepare(
      `SELECT o.run_id, o.seq, o.event_id, o.event_type, o.payload_json, o.created_at, r.lease_id, r.fencing_token
       FROM event_outbox o JOIN runs r ON r.run_id = o.run_id
       WHERE o.seq > r.received_through_seq
       ORDER BY o.run_id, o.seq
       LIMIT ?`
    ).all(limit).map(raw => {
      const row = raw as {
        run_id: string; seq: number; event_id: string; event_type: string;
        payload_json: string; created_at: number; lease_id: string; fencing_token: number;
      };
      return {
        runId: row.run_id,
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

  markSent(runId: string, seq: number, at = Date.now()): void {
    this.#db.prepare("UPDATE event_outbox SET last_sent_at = ?, send_attempts = send_attempts + 1 WHERE run_id = ? AND seq = ?")
      .run(at, runId, seq);
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
  advanceReceived(runId: string, seq: number): AckOutcome {
    const run = this.#db.prepare(
      "SELECT next_seq, received_through_seq, durable_through_seq, terminal_seq FROM runs WHERE run_id = ?"
    ).get(runId) as Pick<RunRow, "next_seq" | "received_through_seq" | "durable_through_seq" | "terminal_seq"> | undefined;
    if (!run) return { advanced: false, reason: "unknown_run" };
    if (seq > run.next_seq - 1) return { advanced: false, reason: "ack_beyond_produced" };
    if (seq <= run.received_through_seq) return { advanced: false, reason: "stale" };
    this.#db.prepare("UPDATE runs SET received_through_seq = ?, updated_at = ? WHERE run_id = ?").run(seq, Date.now(), runId);
    return { advanced: true, through: seq };
  }

  /**
   * Advance the durable watermark: the aggregated business state is committed
   * cloud-side, so confirmed outbox rows can be deleted; terminal coverage
   * marks completed_at. This is the only path that deletes outbox rows.
   */
  advanceDurable(runId: string, seq: number): AckOutcome {
    const run = this.#db.prepare(
      "SELECT next_seq, received_through_seq, durable_through_seq, terminal_seq FROM runs WHERE run_id = ?"
    ).get(runId) as Pick<RunRow, "next_seq" | "received_through_seq" | "durable_through_seq" | "terminal_seq"> | undefined;
    if (!run) return { advanced: false, reason: "unknown_run" };
    if (seq > run.next_seq - 1) return { advanced: false, reason: "ack_beyond_produced" };
    if (seq <= run.durable_through_seq) return { advanced: false, reason: "stale" };
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("UPDATE runs SET durable_through_seq = ?, updated_at = ? WHERE run_id = ?").run(seq, Date.now(), runId);
      this.#db.prepare("DELETE FROM event_outbox WHERE run_id = ? AND seq <= ?").run(runId, seq);
      if (run.terminal_seq !== null && seq >= run.terminal_seq) {
        this.#db.prepare("UPDATE runs SET completed_at = ? WHERE run_id = ? AND completed_at IS NULL").run(Date.now(), runId);
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
  inspectDurableAck(runId: string, seq: number): DurableAckInspection {
    const run = this.#db.prepare(
      "SELECT next_seq, durable_through_seq, terminal_seq FROM runs WHERE run_id = ?"
    ).get(runId) as Pick<RunRow, "next_seq" | "durable_through_seq" | "terminal_seq"> | undefined;
    if (!run) return { advanced: false, reason: "unknown_run" };
    if (seq > run.next_seq - 1) return { advanced: false, reason: "ack_beyond_produced" };
    if (seq <= run.durable_through_seq) return { advanced: false, reason: "stale" };
    const terminal = run.terminal_seq !== null && seq >= run.terminal_seq
      ? this.durableTerminal(runId, seq)
      : undefined;
    return { advanced: true, through: seq, ...(terminal ? { terminal } : {}) };
  }

  durableTerminal(runId: string, durableThrough: number): DurableTerminal | undefined {
    const row = this.#db.prepare(
      `SELECT o.seq, o.event_type
       FROM event_outbox o JOIN runs r ON r.run_id = o.run_id
       WHERE o.run_id = ? AND r.terminal_seq = o.seq AND o.seq <= ?`
    ).get(runId, durableThrough) as { seq: number; event_type: string } | undefined;
    return row ? { seq: row.seq, type: row.event_type } : undefined;
  }

  /** 未 ACK 事件正文的合计字节，用于容量水位判断。 */
  outboxBytes(): number {
    const row = this.#db.prepare("SELECT COALESCE(SUM(payload_bytes), 0) AS bytes FROM event_outbox").get() as { bytes: number };
    return row.bytes;
  }

  /** 最早未确认事件的年龄（ms）；无积压返回 null。 */
  oldestUnackedAgeMs(): number | null {
    const row = this.#db.prepare("SELECT MIN(created_at) AS oldest FROM event_outbox").get() as { oldest: number | null };
    return row.oldest === null ? null : Date.now() - row.oldest;
  }

  pendingCount(): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM event_outbox").get() as { n: number }).n;
  }

  /** 一致性清扫：删除已在水位内的残留行与过期元数据，checkpoint 并小批回收空闲页。 */
  reconcile(now = Date.now()): void {
    this.#db.prepare(
      `DELETE FROM event_outbox WHERE (run_id, seq) IN (
        SELECT o.run_id, o.seq FROM event_outbox o JOIN runs r ON r.run_id = o.run_id WHERE o.seq <= r.durable_through_seq
      )`
    ).run();
    // 过期 command receipt 与本地保留期已过的终态 run（其 outbox 已排空）不再需要。
    this.#db.prepare("DELETE FROM command_receipts WHERE expires_at IS NOT NULL AND expires_at < ?").run(now);
    this.#db.prepare(
      `DELETE FROM runs
       WHERE completed_at IS NOT NULL AND completed_at < ?
         AND run_id NOT IN (SELECT run_id FROM event_outbox)`
    ).run(now - DEFAULT_RETENTION_MS);
    this.#db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    this.#db.exec("PRAGMA incremental_vacuum");
  }

  dbBytes(): number { return fileBytes(this.#file); }
  walBytes(): number { return fileBytes(`${this.#file}-wal`); }

  close(): void { this.#db.close(); }
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

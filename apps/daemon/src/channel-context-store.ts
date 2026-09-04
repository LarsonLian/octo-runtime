import { createHash, randomUUID } from "node:crypto";
import { renameSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { openWalDatabase } from "@mininglamp-oss/octo-harness-core";
import type {
  ChannelContextAppend,
  ChannelContextDescriptor,
  ChannelContextSnapshotRef,
  ChannelMessageFact,
  ChannelScope,
  ContextCommitResult,
  ContextSyncResult
} from "@mininglamp-oss/octo-harness-protocol";
import {
  assertChannelContextAppend,
  assertChannelContextDescriptor,
  assertContextSyncResult
} from "@mininglamp-oss/octo-harness-protocol";

const SCHEMA_VERSION = 2;
export const CHANNEL_CONTEXT_SERIALIZER_VERSION = "channel-context-jsonl-v1";
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_MESSAGES_PER_SCOPE = 200;
const DEFAULT_MAX_PROJECTED_MESSAGES = 40;
const DEFAULT_MAX_PROJECTED_BYTES = 32 * 1024;
const FLAG_SELF = 1;
const FLAG_CONTROL = 2;

export interface ChannelContextStoreOptions {
  retentionMs?: number;
  snapshotRetentionMs?: number;
  maxMessagesPerScope?: number;
  maxProjectedMessages?: number;
  maxProjectedBytes?: number;
}

export interface PreparedChannelContextSnapshot {
  ref: ChannelContextSnapshotRef;
  facts: ChannelMessageFact[];
  renderedText: string;
  recoveryFacts: ChannelMessageFact[];
  recoveryRenderedText: string;
  recoveryCompleteness: "complete" | "partial" | "unavailable";
  selectedVariant: "primary" | "recovery";
  state: "prepared" | "submitted" | "committed" | "failed";
}

export interface ChannelContextStoreStats {
  scopes: number;
  messages: number;
  snapshots: number;
  activeSnapshots: number;
  dbBytes: number;
  walBytes: number;
}

export class ChannelContextConsumerBusyError extends Error {
  readonly blockingRunId: string;

  constructor(blockingRunId: string) {
    super(`channel context consumer is busy with run ${blockingRunId}`);
    this.name = "ChannelContextConsumerBusyError";
    this.blockingRunId = blockingRunId;
  }
}

export class ChannelContextStaleGenerationError extends Error {
  readonly requestedGeneration: number;
  readonly latestGeneration: number;

  constructor(requestedGeneration: number, latestGeneration: number) {
    super(
      `channel context generation ${requestedGeneration} is stale; latest generation is ${latestGeneration}`
    );
    this.name = "ChannelContextStaleGenerationError";
    this.requestedGeneration = requestedGeneration;
    this.latestGeneration = latestGeneration;
  }
}

interface SnapshotRow {
  snapshot_id: string;
  run_id: string;
  scope_key: string;
  consumer_key: string;
  session_generation: number;
  effective_session_generation: number;
  selected_variant: "primary" | "recovery";
  base_consumer_version: number;
  trigger_message_id: string;
  trigger_seq: number | null;
  commit_order_key: string;
  payload_json: string;
  rendered_text: string;
  serializer_version: string;
  rendered_sha256: string;
  completeness: "complete" | "partial" | "unavailable";
  recovery_rendered_text: string | null;
  recovery_rendered_sha256: string | null;
  recovery_completeness: "complete" | "partial" | "unavailable" | null;
  state: "prepared" | "submitted" | "committed" | "failed";
}

interface ConsumerRow {
  consumed_order_key: string | null;
  consumed_through_seq: number | null;
  version: number;
}

/**
 * Rebuildable bounded Channel Journal. This database is deliberately separate
 * from the Agent Work execution outbox and never stores provider/platform tokens.
 */
export class ChannelContextStore {
  readonly #db: DatabaseSync;
  readonly #file: string;
  readonly #options: Required<ChannelContextStoreOptions>;

  private constructor(db: DatabaseSync, file: string, options: ChannelContextStoreOptions) {
    this.#db = db;
    this.#file = file;
    this.#options = {
      retentionMs: options.retentionMs ?? DEFAULT_RETENTION_MS,
      snapshotRetentionMs: options.snapshotRetentionMs ?? DEFAULT_SNAPSHOT_RETENTION_MS,
      maxMessagesPerScope: options.maxMessagesPerScope ?? DEFAULT_MAX_MESSAGES_PER_SCOPE,
      maxProjectedMessages: options.maxProjectedMessages ?? DEFAULT_MAX_PROJECTED_MESSAGES,
      maxProjectedBytes: options.maxProjectedBytes ?? DEFAULT_MAX_PROJECTED_BYTES
    };
  }

  static open(file: string, options: ChannelContextStoreOptions = {}): ChannelContextStore {
    let db: DatabaseSync | undefined;
    try {
      db = openWalDatabase(file);
      migrate(db);
      return new ChannelContextStore(db, file, options);
    } catch (error) {
      if (!isCorruptDatabase(error)) {
        try { db?.close(); } catch { /* Preserve the original open/migration error. */ }
        throw error;
      }
      try { db?.close(); } catch { /* A corrupt handle may not close cleanly. */ }
      quarantineDatabase(file);
      const replacement = openWalDatabase(file);
      migrate(replacement);
      return new ChannelContextStore(replacement, file, options);
    }
  }

  append(input: ChannelContextAppend, now = Date.now()): { accepted: number; scopeKey: string } {
    assertChannelContextAppend(input);
    const scopeKey = channelScopeKey(input.scope);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const detectedGap = this.#detectSequenceGap(scopeKey, input.facts);
      this.#upsertScope(scopeKey, input.scope, input.gap_after_seq ?? detectedGap, now);
      for (const fact of input.facts) this.#upsertFact(scopeKey, fact, now);
      this.#pruneScope(scopeKey, now);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return { accepted: input.facts.length, scopeKey };
  }

  applySyncResult(input: ContextSyncResult, now = Date.now()): { accepted: number; scopeKey: string } {
    assertContextSyncResult(input);
    const scopeKey = channelScopeKey(input.scope);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#upsertScope(scopeKey, input.scope, undefined, now);
      for (const fact of input.facts) this.#upsertFact(scopeKey, fact, now);
      this.#db.prepare(
        `UPDATE channel_context_scopes
         SET gap_after_seq = CASE WHEN ? = 'complete' THEN NULL ELSE gap_after_seq END,
             sync_completeness = ?, updated_at_ms = ?
         WHERE scope_key = ?`
      ).run(input.completeness, input.completeness, now, scopeKey);
      this.#pruneScope(scopeKey, now);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return { accepted: input.facts.length, scopeKey };
  }

  /** Freeze exact canonical facts and rendered bytes once per run. */
  prepareSnapshot(runId: string, descriptor: ChannelContextDescriptor, now = Date.now()): PreparedChannelContextSnapshot {
    assertChannelContextDescriptor(descriptor);
    const existing = this.#snapshotForRun(runId);
    if (existing) {
      assertSnapshotIdentity(existing, descriptor);
      this.#assertCurrentGeneration(
        existing.scope_key,
        existing.consumer_key,
        descriptor.session_generation,
        Math.max(descriptor.session_generation, existing.effective_session_generation),
        runId
      );
      if (existing.state === "failed") {
        const active = this.#db.prepare(
          `SELECT run_id FROM channel_context_snapshots
           WHERE scope_key = ? AND consumer_key = ? AND effective_session_generation = ?
             AND run_id <> ? AND state IN ('prepared', 'submitted')
           LIMIT 1`
        ).get(
          existing.scope_key,
          existing.consumer_key,
          existing.effective_session_generation,
          runId
        ) as { run_id: string } | undefined;
        if (active) throw new ChannelContextConsumerBusyError(active.run_id);
        this.#db.prepare(
          "UPDATE channel_context_snapshots SET state = 'prepared' WHERE snapshot_id = ? AND state = 'failed'"
        ).run(existing.snapshot_id);
        return this.getSnapshot(runId)!;
      }
      return snapshotFromRow(existing);
    }

    const scopeKey = channelScopeKey(descriptor.scope);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#upsertScope(scopeKey, descriptor.scope, undefined, now);
      // Trigger delivery is reliable even when prior context-only pushes were dropped.
      this.#upsertFact(scopeKey, descriptor.trigger_fact, now);
      this.#assertCurrentGeneration(
        scopeKey,
        descriptor.consumer_key,
        descriptor.session_generation,
        descriptor.session_generation,
        runId
      );
      this.#db.prepare(
        `INSERT OR IGNORE INTO channel_context_consumers (
           scope_key, consumer_key, session_generation, consumed_order_key,
           consumed_through_seq, consumed_message_id, version, updated_at_ms
         ) VALUES (?, ?, ?, NULL, NULL, NULL, 0, ?)`
      ).run(scopeKey, descriptor.consumer_key, descriptor.session_generation, now);

      const active = this.#db.prepare(
        `SELECT run_id FROM channel_context_snapshots
         WHERE scope_key = ? AND consumer_key = ? AND effective_session_generation = ?
           AND run_id <> ? AND state IN ('prepared', 'submitted')
         LIMIT 1`
      ).get(scopeKey, descriptor.consumer_key, descriptor.session_generation, runId) as { run_id: string } | undefined;
      if (active) throw new ChannelContextConsumerBusyError(active.run_id);

      const consumer = this.#db.prepare(
        `SELECT consumed_order_key, consumed_through_seq, version
         FROM channel_context_consumers
         WHERE scope_key = ? AND consumer_key = ? AND session_generation = ?`
      ).get(scopeKey, descriptor.consumer_key, descriptor.session_generation) as unknown as ConsumerRow;
      const trigger = this.#db.prepare(
        `SELECT order_key FROM channel_context_messages WHERE scope_key = ? AND message_id = ?`
      ).get(scopeKey, descriptor.trigger_message_id) as { order_key: string } | undefined;
      if (!trigger) throw new Error("channel context trigger fact was not persisted");

      const selected = this.#selectFacts(
        scopeKey,
        trigger.order_key,
        consumer.consumed_order_key,
        descriptor.trigger_message_id
      );
      // A resumed provider consumes the delta. If resume falls back to a fresh
      // provider session, the adapter instead uses this independently bounded
      // cold projection during the same turn.
      const recovery = this.#selectFacts(
        scopeKey,
        trigger.order_key,
        null,
        descriptor.trigger_message_id
      );
      const scopeState = this.#db.prepare(
        "SELECT gap_after_seq, sync_completeness FROM channel_context_scopes WHERE scope_key = ?"
      ).get(scopeKey) as { gap_after_seq: number | null; sync_completeness: string | null };
      const completeness = contextCompleteness(scopeState, selected.truncated);
      const recoveryCompleteness = contextCompleteness(scopeState, recovery.truncated);
      const payloadJson = canonicalJson({
        facts: selected.facts,
        recovery_facts: recovery.facts,
        recovery_completeness: recoveryCompleteness,
        trust: "untrusted_external",
        version: CHANNEL_CONTEXT_SERIALIZER_VERSION
      });
      const renderedText = renderChannelContextDelta(selected.facts);
      const renderedSha256 = sha256(renderedText);
      const recoveryRenderedText = renderChannelContextDelta(recovery.facts);
      const recoveryRenderedSha256 = sha256(recoveryRenderedText);
      const snapshotId = `ctx_${randomUUID()}`;
      const triggerSeq = descriptor.trigger_seq ?? descriptor.trigger_fact.message_seq ?? null;

      this.#db.prepare(
        `INSERT INTO channel_context_snapshots (
           snapshot_id, run_id, scope_key, consumer_key, session_generation,
           effective_session_generation, selected_variant,
           base_consumer_version, base_consumed_seq, trigger_message_id, trigger_seq,
           commit_order_key, payload_json, rendered_text, serializer_version,
           rendered_sha256, completeness, recovery_rendered_text,
           recovery_rendered_sha256, recovery_completeness, state, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, 'primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?)`
      ).run(
        snapshotId,
        runId,
        scopeKey,
        descriptor.consumer_key,
        descriptor.session_generation,
        descriptor.session_generation,
        consumer.version,
        consumer.consumed_through_seq,
        descriptor.trigger_message_id,
        triggerSeq,
        trigger.order_key,
        payloadJson,
        renderedText,
        CHANNEL_CONTEXT_SERIALIZER_VERSION,
        renderedSha256,
        completeness,
        recoveryRenderedText,
        recoveryRenderedSha256,
        recoveryCompleteness,
        now
      );
      this.#db.exec("COMMIT");
      return this.getSnapshot(runId)!;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #selectFacts(
    scopeKey: string,
    triggerOrderKey: string,
    afterOrderKey: string | null,
    triggerMessageId: string
  ): { facts: ChannelMessageFact[]; truncated: boolean } {
    const available = this.#db.prepare(
      `SELECT fact_json, content_bytes
       FROM channel_context_messages
       WHERE scope_key = ? AND order_key < ?
         AND (? IS NULL OR order_key > ?)
         AND message_id <> ?
         AND (flags & ?) = 0
       ORDER BY order_key DESC
       LIMIT ?`
    ).all(
      scopeKey,
      triggerOrderKey,
      afterOrderKey,
      afterOrderKey,
      triggerMessageId,
      FLAG_SELF | FLAG_CONTROL,
      this.#options.maxProjectedMessages + 1
    ) as Array<{ fact_json: string; content_bytes: number }>;

    let truncated = available.length > this.#options.maxProjectedMessages;
    const selectedDescending: ChannelMessageFact[] = [];
    let selectedBytes = 0;
    for (const row of available.slice(0, this.#options.maxProjectedMessages)) {
      if (selectedBytes + row.content_bytes > this.#options.maxProjectedBytes) {
        truncated = true;
        continue;
      }
      selectedDescending.push(JSON.parse(row.fact_json) as ChannelMessageFact);
      selectedBytes += row.content_bytes;
    }
    return { facts: selectedDescending.reverse(), truncated };
  }

  getSnapshot(runId: string): PreparedChannelContextSnapshot | undefined {
    const row = this.#snapshotForRun(runId);
    return row ? snapshotFromRow(row) : undefined;
  }

  /** Switch an already frozen run to its cold projection and generation N+1. */
  selectRecovery(runId: string, now = Date.now()): PreparedChannelContextSnapshot {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#snapshotForRun(runId);
      if (!row) throw new Error(`channel context snapshot not found for run ${runId}`);
      if (row.selected_variant === "recovery") {
        this.#db.exec("COMMIT");
        return snapshotFromRow(row);
      }
      if (row.state !== "prepared" && row.state !== "submitted") {
        throw new Error(`channel context snapshot cannot select recovery from state ${row.state}`);
      }
      const recoveryGeneration = row.session_generation + 1;
      if (!Number.isSafeInteger(recoveryGeneration)) {
        throw new Error("channel context recovery generation exceeds the safe integer range");
      }
      const active = this.#db.prepare(
        `SELECT run_id FROM channel_context_snapshots
         WHERE scope_key = ? AND consumer_key = ? AND effective_session_generation = ?
           AND run_id <> ? AND state IN ('prepared', 'submitted')
         LIMIT 1`
      ).get(row.scope_key, row.consumer_key, recoveryGeneration, runId) as { run_id: string } | undefined;
      if (active) throw new ChannelContextConsumerBusyError(active.run_id);
      this.#db.prepare(
        `INSERT OR IGNORE INTO channel_context_consumers (
           scope_key, consumer_key, session_generation, consumed_order_key,
           consumed_through_seq, consumed_message_id, version, updated_at_ms
         ) VALUES (?, ?, ?, NULL, NULL, NULL, 0, ?)`
      ).run(row.scope_key, row.consumer_key, recoveryGeneration, now);
      const consumer = this.#db.prepare(
        `SELECT consumed_through_seq, version FROM channel_context_consumers
         WHERE scope_key = ? AND consumer_key = ? AND session_generation = ?`
      ).get(row.scope_key, row.consumer_key, recoveryGeneration) as {
        consumed_through_seq: number | null;
        version: number;
      };
      this.#db.prepare(
        `UPDATE channel_context_snapshots
         SET effective_session_generation = ?, selected_variant = 'recovery',
             base_consumer_version = ?, base_consumed_seq = ?
         WHERE snapshot_id = ?`
      ).run(
        recoveryGeneration,
        consumer.version,
        consumer.consumed_through_seq,
        row.snapshot_id
      );
      this.#db.exec("COMMIT");
      return this.getSnapshot(runId)!;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  markSubmitted(runId: string): PreparedChannelContextSnapshot | undefined {
    this.#db.prepare(
      "UPDATE channel_context_snapshots SET state = 'submitted' WHERE run_id = ? AND state = 'prepared'"
    ).run(runId);
    return this.getSnapshot(runId);
  }

  markFailed(runId: string): void {
    this.#db.prepare(
      "UPDATE channel_context_snapshots SET state = 'failed' WHERE run_id = ? AND state IN ('prepared', 'submitted')"
    ).run(runId);
  }

  /** Advance the consumer only after Agent Work durably ACKs the successful terminal event. */
  commitSnapshot(runId: string, now = Date.now()): ContextCommitResult {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#snapshotForRun(runId);
      if (!row) {
        this.#db.exec("COMMIT");
        return { snapshot_id: runId, committed: false, reason: "snapshot_not_found" };
      }
      if (row.state === "committed") {
        this.#db.exec("COMMIT");
        return { snapshot_id: row.snapshot_id, committed: true, reason: "already_committed" };
      }
      if (row.state === "failed") {
        this.#db.exec("COMMIT");
        return { snapshot_id: row.snapshot_id, committed: false, reason: "snapshot_failed" };
      }
      if (row.state !== "submitted") {
        this.#db.exec("COMMIT");
        return { snapshot_id: row.snapshot_id, committed: false, reason: "snapshot_not_submitted" };
      }
      const updated = this.#db.prepare(
        `UPDATE channel_context_consumers
         SET consumed_order_key = ?, consumed_through_seq = ?, consumed_message_id = ?,
             version = version + 1, updated_at_ms = ?
         WHERE scope_key = ? AND consumer_key = ? AND session_generation = ? AND version = ?`
      ).run(
        row.commit_order_key,
        row.trigger_seq,
        row.trigger_message_id,
        now,
        row.scope_key,
        row.consumer_key,
        row.effective_session_generation,
        row.base_consumer_version
      );
      if (Number(updated.changes) !== 1) {
        this.#db.prepare(
          "UPDATE channel_context_snapshots SET state = 'failed' WHERE snapshot_id = ?"
        ).run(row.snapshot_id);
        this.#db.exec("COMMIT");
        return { snapshot_id: row.snapshot_id, committed: false, reason: "consumer_advanced" };
      }
      this.#db.prepare(
        "UPDATE channel_context_snapshots SET state = 'committed', committed_at_ms = ? WHERE snapshot_id = ?"
      ).run(now, row.snapshot_id);
      this.#db.exec("COMMIT");
      return { snapshot_id: row.snapshot_id, committed: true };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  reconcile(now = Date.now()): void {
    const retentionCutoff = now - this.#options.retentionMs;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("DELETE FROM channel_context_messages WHERE ingested_at_ms < ?").run(retentionCutoff);
      const scopes = this.#db.prepare("SELECT scope_key FROM channel_context_scopes").all() as Array<{ scope_key: string }>;
      for (const { scope_key: scopeKey } of scopes) this.#pruneScope(scopeKey, now);
      this.#db.prepare(
        "DELETE FROM channel_context_snapshots WHERE created_at_ms < ? AND state IN ('committed', 'failed')"
      ).run(now - this.#options.snapshotRetentionMs);
      this.#db.prepare(
        `DELETE FROM channel_context_consumers
         WHERE updated_at_ms < ?
           AND NOT EXISTS (
             SELECT 1 FROM channel_context_snapshots s
             WHERE s.scope_key = channel_context_consumers.scope_key
               AND s.consumer_key = channel_context_consumers.consumer_key
               AND s.effective_session_generation = channel_context_consumers.session_generation
               AND s.state IN ('prepared', 'submitted')
           )`
      ).run(retentionCutoff);
      this.#db.prepare(
        `DELETE FROM channel_context_scopes
         WHERE NOT EXISTS (
           SELECT 1 FROM channel_context_messages m
           WHERE m.scope_key = channel_context_scopes.scope_key
         ) AND NOT EXISTS (
           SELECT 1 FROM channel_context_consumers c
           WHERE c.scope_key = channel_context_scopes.scope_key
         ) AND NOT EXISTS (
           SELECT 1 FROM channel_context_snapshots s
           WHERE s.scope_key = channel_context_scopes.scope_key
             AND s.state IN ('prepared', 'submitted')
         )`
      ).run();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    this.#db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    this.#db.exec("PRAGMA incremental_vacuum");
  }

  messageCount(scope: ChannelScope): number {
    return (this.#db.prepare(
      "SELECT COUNT(*) AS n FROM channel_context_messages WHERE scope_key = ?"
    ).get(channelScopeKey(scope)) as { n: number }).n;
  }

  stats(): ChannelContextStoreStats {
    const count = (table: string, where = ""): number => (
      this.#db.prepare(`SELECT COUNT(*) AS n FROM ${table}${where}`).get() as { n: number }
    ).n;
    return {
      scopes: count("channel_context_scopes"),
      messages: count("channel_context_messages"),
      snapshots: count("channel_context_snapshots"),
      activeSnapshots: count("channel_context_snapshots", " WHERE state IN ('prepared', 'submitted')"),
      dbBytes: this.dbBytes(),
      walBytes: this.walBytes()
    };
  }

  needsSync(scope: ChannelScope): boolean {
    const row = this.#db.prepare(
      "SELECT gap_after_seq, sync_completeness FROM channel_context_scopes WHERE scope_key = ?"
    ).get(channelScopeKey(scope)) as { gap_after_seq: number | null; sync_completeness: string | null } | undefined;
    // A gap-free partial means the bounded window is warm even though the
    // snapshot stays partial. Unavailable remains retryable on the next trigger.
    return !row || row.gap_after_seq !== null
      || row.sync_completeness === null || row.sync_completeness === "unavailable";
  }

  syncAfterSeq(scope: ChannelScope): number | undefined {
    const row = this.#db.prepare(
      "SELECT gap_after_seq FROM channel_context_scopes WHERE scope_key = ?"
    ).get(channelScopeKey(scope)) as { gap_after_seq: number | null } | undefined;
    return row?.gap_after_seq ?? undefined;
  }

  dbBytes(): number { return fileBytes(this.#file); }
  walBytes(): number { return fileBytes(`${this.#file}-wal`); }
  close(): void { this.#db.close(); }

  #snapshotForRun(runId: string): SnapshotRow | undefined {
    return this.#db.prepare(
      `SELECT snapshot_id, run_id, scope_key, consumer_key, session_generation,
              effective_session_generation, selected_variant,
              base_consumer_version, base_consumed_seq, trigger_message_id, trigger_seq, commit_order_key,
              payload_json, rendered_text, serializer_version, rendered_sha256,
              completeness, recovery_rendered_text, recovery_rendered_sha256,
              recovery_completeness, state
       FROM channel_context_snapshots WHERE run_id = ?`
    ).get(runId) as SnapshotRow | undefined;
  }

  #upsertScope(scopeKey: string, scope: ChannelScope, gapAfterSeq: number | undefined, now: number): void {
    this.#db.prepare(
      `INSERT INTO channel_context_scopes (
         scope_key, scope_json, gap_after_seq, sync_completeness, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, NULL, ?, ?)
       ON CONFLICT(scope_key) DO UPDATE SET
         scope_json = excluded.scope_json,
         gap_after_seq = CASE
           WHEN excluded.gap_after_seq IS NULL THEN channel_context_scopes.gap_after_seq
           WHEN channel_context_scopes.gap_after_seq IS NULL THEN excluded.gap_after_seq
           ELSE MIN(excluded.gap_after_seq, channel_context_scopes.gap_after_seq)
         END,
         updated_at_ms = excluded.updated_at_ms`
    ).run(scopeKey, canonicalJson(scope), gapAfterSeq ?? null, now, now);
  }

  #upsertFact(scopeKey: string, fact: ChannelMessageFact, now: number): void {
    const factJson = canonicalJson(fact);
    this.#db.prepare(
      `INSERT INTO channel_context_messages (
         scope_key, message_id, message_seq, order_key, sender_id, sender_label,
         occurred_at_ms, parts_json, fact_json, content_bytes, flags, ingested_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_key, message_id) DO UPDATE SET
         message_seq = excluded.message_seq,
         order_key = excluded.order_key,
         sender_id = excluded.sender_id,
         sender_label = excluded.sender_label,
         occurred_at_ms = excluded.occurred_at_ms,
         parts_json = excluded.parts_json,
         fact_json = excluded.fact_json,
         content_bytes = excluded.content_bytes,
         flags = excluded.flags,
         ingested_at_ms = excluded.ingested_at_ms`
    ).run(
      scopeKey,
      fact.message_id,
      fact.message_seq ?? null,
      messageOrderKey(fact),
      fact.sender.id,
      fact.sender.label ?? null,
      fact.occurred_at_ms,
      canonicalJson(fact.parts),
      factJson,
      Buffer.byteLength(factJson),
      (fact.flags?.self ? FLAG_SELF : 0) | (fact.flags?.control ? FLAG_CONTROL : 0),
      now
    );
  }

  #detectSequenceGap(scopeKey: string, facts: readonly ChannelMessageFact[]): number | undefined {
    const incoming = [...new Set(
      facts.map(fact => fact.message_seq).filter((value): value is number => value !== undefined)
    )].sort((left, right) => left - right);
    if (incoming.length === 0) return undefined;
    const row = this.#db.prepare(
      "SELECT MAX(message_seq) AS max_seq FROM channel_context_messages WHERE scope_key = ?"
    ).get(scopeKey) as { max_seq: number | null } | undefined;
    const existingMax = row?.max_seq;
    // An empty cache is cold rather than a proven gap; bounded sync establishes completeness.
    if (existingMax === null || existingMax === undefined) return undefined;
    let expected = existingMax + 1;
    for (const seq of incoming) {
      if (seq <= existingMax) continue;
      if (seq > expected) return expected - 1;
      expected = seq + 1;
    }
    return undefined;
  }

  #assertCurrentGeneration(
    scopeKey: string,
    consumerKey: string,
    requestedGeneration: number,
    allowedGeneration: number,
    runId: string
  ): void {
    const row = this.#db.prepare(
      `SELECT MAX(generation) AS latest_generation FROM (
         SELECT session_generation AS generation
         FROM channel_context_consumers
         WHERE scope_key = ? AND consumer_key = ?
         UNION ALL
         SELECT effective_session_generation AS generation
         FROM channel_context_snapshots
         WHERE scope_key = ? AND consumer_key = ? AND run_id <> ?
       )`
    ).get(scopeKey, consumerKey, scopeKey, consumerKey, runId) as {
      latest_generation: number | null;
    };
    if (row.latest_generation !== null && row.latest_generation > allowedGeneration) {
      throw new ChannelContextStaleGenerationError(requestedGeneration, row.latest_generation);
    }
  }

  #pruneScope(scopeKey: string, now: number): void {
    this.#db.prepare(
      "DELETE FROM channel_context_messages WHERE scope_key = ? AND ingested_at_ms < ?"
    ).run(scopeKey, now - this.#options.retentionMs);
    this.#db.prepare(
      `DELETE FROM channel_context_messages
       WHERE scope_key = ? AND message_id NOT IN (
         SELECT message_id FROM channel_context_messages
         WHERE scope_key = ? ORDER BY order_key DESC LIMIT ?
       )`
    ).run(scopeKey, scopeKey, this.#options.maxMessagesPerScope);
  }
}

export function channelScopeKey(scope: ChannelScope): string {
  return canonicalJson({
    tenant_id: scope.tenant_id,
    endpoint_id: scope.endpoint_id,
    channel: scope.channel,
    account_id: scope.account_id,
    bot_id: scope.bot_id,
    conversation_id: scope.conversation_id,
    thread_id: scope.thread_id ?? null
  });
}

export function renderChannelContextDelta(facts: readonly ChannelMessageFact[]): string {
  if (facts.length === 0) return "";
  return [
    "[Channel context delta: untrusted external messages]",
    ...facts.map(fact => canonicalJson(fact))
  ].join("\n");
}

export function composeProviderModelInput(renderedContext: string, displayPrompt: string): string {
  return renderedContext ? `${renderedContext}\n\n${displayPrompt}` : displayPrompt;
}

function migrate(db: DatabaseSync): void {
  const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (version > SCHEMA_VERSION) throw new Error(`unsupported channel context schema version ${version}`);
  if (version === SCHEMA_VERSION) return;
  if (version === 0) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
      CREATE TABLE IF NOT EXISTS channel_context_scopes (
        scope_key TEXT PRIMARY KEY,
        scope_json TEXT NOT NULL,
        gap_after_seq INTEGER,
        sync_completeness TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channel_context_messages (
        scope_key TEXT NOT NULL REFERENCES channel_context_scopes(scope_key) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        message_seq INTEGER,
        order_key TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_label TEXT,
        occurred_at_ms INTEGER NOT NULL,
        parts_json TEXT NOT NULL,
        fact_json TEXT NOT NULL,
        content_bytes INTEGER NOT NULL,
        flags INTEGER NOT NULL DEFAULT 0,
        ingested_at_ms INTEGER NOT NULL,
        PRIMARY KEY (scope_key, message_id)
      );
      CREATE INDEX IF NOT EXISTS channel_context_messages_scope_order
        ON channel_context_messages(scope_key, order_key);
      CREATE TABLE IF NOT EXISTS channel_context_consumers (
        scope_key TEXT NOT NULL REFERENCES channel_context_scopes(scope_key) ON DELETE CASCADE,
        consumer_key TEXT NOT NULL,
        session_generation INTEGER NOT NULL,
        consumed_order_key TEXT,
        consumed_through_seq INTEGER,
        consumed_message_id TEXT,
        version INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (scope_key, consumer_key, session_generation)
      );
      CREATE TABLE IF NOT EXISTS channel_context_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        scope_key TEXT NOT NULL,
        consumer_key TEXT NOT NULL,
        session_generation INTEGER NOT NULL,
        effective_session_generation INTEGER NOT NULL,
        selected_variant TEXT NOT NULL DEFAULT 'primary',
        base_consumer_version INTEGER NOT NULL,
        base_consumed_seq INTEGER,
        trigger_message_id TEXT NOT NULL,
        trigger_seq INTEGER,
        commit_order_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        rendered_text TEXT NOT NULL,
        serializer_version TEXT NOT NULL,
        rendered_sha256 TEXT NOT NULL,
        completeness TEXT NOT NULL,
        recovery_rendered_text TEXT NOT NULL,
        recovery_rendered_sha256 TEXT NOT NULL,
        recovery_completeness TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        committed_at_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS channel_context_snapshots_consumer
        ON channel_context_snapshots(scope_key, consumer_key, session_generation, created_at_ms);
      CREATE INDEX IF NOT EXISTS channel_context_snapshots_effective_consumer
        ON channel_context_snapshots(scope_key, consumer_key, effective_session_generation, created_at_ms);
      PRAGMA user_version = 2;
      `);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE channel_context_snapshots
        ADD COLUMN effective_session_generation INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE channel_context_snapshots
        ADD COLUMN selected_variant TEXT NOT NULL DEFAULT 'primary';
      ALTER TABLE channel_context_snapshots
        ADD COLUMN recovery_rendered_text TEXT;
      ALTER TABLE channel_context_snapshots
        ADD COLUMN recovery_rendered_sha256 TEXT;
      ALTER TABLE channel_context_snapshots
        ADD COLUMN recovery_completeness TEXT;
      UPDATE channel_context_snapshots
        SET effective_session_generation = session_generation;
      DELETE FROM channel_context_snapshots
        WHERE state IN ('prepared', 'submitted', 'failed');
      CREATE INDEX IF NOT EXISTS channel_context_snapshots_effective_consumer
        ON channel_context_snapshots(scope_key, consumer_key, effective_session_generation, created_at_ms);
      PRAGMA user_version = 2;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function snapshotFromRow(row: SnapshotRow): PreparedChannelContextSnapshot {
  const payload = JSON.parse(row.payload_json) as {
    facts?: ChannelMessageFact[];
    recovery_facts?: ChannelMessageFact[];
    recovery_completeness?: "complete" | "partial" | "unavailable";
  };
  const facts = payload.facts ?? [];
  const hasRecovery = row.recovery_rendered_text !== null
    && row.recovery_rendered_sha256 !== null
    && row.recovery_completeness !== null;
  const recoveryFacts = hasRecovery ? (payload.recovery_facts ?? []) : [];
  const recoveryRenderedText = row.recovery_rendered_text ?? "";
  const recoveryCompleteness = row.recovery_completeness ?? "unavailable";
  return {
    ref: {
      snapshot_id: row.snapshot_id,
      scope_key: row.scope_key,
      consumer_key: row.consumer_key,
      session_generation: row.effective_session_generation,
      ...(row.effective_session_generation === row.session_generation
        ? {}
        : { source_session_generation: row.session_generation }),
      trigger_message_id: row.trigger_message_id,
      ...(row.trigger_seq === null ? {} : { trigger_seq: row.trigger_seq }),
      serializer_version: row.serializer_version,
      rendered_sha256: row.rendered_sha256,
      completeness: row.completeness,
      ...(hasRecovery ? {
        recovery_rendered_sha256: row.recovery_rendered_sha256!,
        recovery_completeness: recoveryCompleteness
      } : {})
    },
    facts,
    renderedText: row.rendered_text,
    recoveryFacts,
    recoveryRenderedText,
    recoveryCompleteness,
    selectedVariant: row.selected_variant,
    state: row.state
  };
}

function assertSnapshotIdentity(row: SnapshotRow, descriptor: ChannelContextDescriptor): void {
  if (row.scope_key !== channelScopeKey(descriptor.scope)
    || row.consumer_key !== descriptor.consumer_key
    || row.session_generation !== descriptor.session_generation
    || row.trigger_message_id !== descriptor.trigger_message_id
    || row.trigger_seq !== (descriptor.trigger_seq ?? null)) {
    throw new Error(`run ${row.run_id} already has a different channel context snapshot`);
  }
}

function contextCompleteness(
  scope: { gap_after_seq: number | null; sync_completeness: string | null },
  truncated: boolean
): "complete" | "partial" | "unavailable" {
  if (scope.sync_completeness === "unavailable") return "unavailable";
  if (truncated || scope.gap_after_seq !== null || scope.sync_completeness !== "complete") return "partial";
  return "complete";
}

function messageOrderKey(fact: ChannelMessageFact): string {
  const id = Buffer.from(fact.message_id).toString("base64url");
  if (fact.message_seq !== undefined) return `s:${sortableInteger(fact.message_seq)}:${id}`;
  return `t:${sortableInteger(fact.occurred_at_ms)}:${id}`;
}

function sortableInteger(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("channel context ordering values must be non-negative safe integers");
  return value.toString().padStart(20, "0");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, sortJson(item)])
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isCorruptDatabase(error: unknown): boolean {
  const record = error as { code?: unknown; message?: unknown };
  return record?.code === "SQLITE_CORRUPT" || record?.code === "SQLITE_NOTADB"
    || /malformed|not a database|database disk image is malformed/i.test(String(record?.message ?? error));
}

function quarantineDatabase(file: string): void {
  const suffix = `.corrupt-${Date.now()}`;
  for (const sidecar of ["", "-wal", "-shm"]) {
    try {
      renameSync(`${file}${sidecar}`, `${file}${suffix}${sidecar}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ChannelContextStore,
  CHANNEL_CONTEXT_SERIALIZER_VERSION,
  channelScopeKey,
  composeProviderModelInput
} from "../apps/daemon/dist/channel-context-store.js";

const now = Date.now();
const scope = {
  tenant_id: "tenant-1",
  endpoint_id: "endpoint-1",
  channel: "fake-im",
  account_id: null,
  bot_id: "bot-1",
  conversation_id: "conversation-1",
  thread_id: null
};

function fact(seq, text = `message-${seq}`, flags) {
  return {
    message_id: `message-${seq}`,
    message_seq: seq,
    sender: { id: `sender-${seq}`, label: `Sender ${seq}`, kind: "member" },
    occurred_at_ms: now + seq,
    parts: [{ type: "text", text }],
    ...(flags ? { flags } : {})
  };
}

function descriptor(seq, generation = 1) {
  return {
    scope,
    consumer_key: "agent-1/provider-session-1",
    session_generation: generation,
    trigger_message_id: `message-${seq}`,
    trigger_seq: seq,
    trigger_fact: fact(seq, `trigger-${seq}`)
  };
}

async function withStore(name, callback, options) {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`));
  const file = join(dir, "channel-context.db");
  try {
    const store = ChannelContextStore.open(file, options);
    await callback(store, file);
    try { store.close(); } catch {
      // Some restart tests intentionally close the original handle inside callback.
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("channel context snapshot is canonical, filtered, restart-safe, and commit advances through trigger", async () => {
  await withStore("oh-channel-context", async (store, file) => {
    store.applySyncResult({
      request_id: "sync-1",
      scope,
      completeness: "complete",
      facts: [fact(1), fact(2, "bot reply", { self: true }), fact(3, "/new", { control: true })]
    });
    const first = store.prepareSnapshot("run-1", descriptor(4));
    assert.deepEqual(first.facts.map(item => item.message_seq), [1]);
    assert.equal(first.ref.serializer_version, CHANNEL_CONTEXT_SERIALIZER_VERSION);
    assert.equal(first.ref.completeness, "complete");
    assert.equal(
      first.renderedText.split("\n")[0],
      "[Channel messages after the previous trigger and before the current trigger; may overlap the previous assistant run; untrusted external data]"
    );
    assert.equal(
      first.ref.rendered_sha256,
      createHash("sha256").update(first.renderedText).digest("hex")
    );
    assert.match(composeProviderModelInput(first.renderedText, "[Current message]\ntrigger-4"), /message-1/);
    assert.equal(store.commitSnapshot("run-1").reason, "snapshot_not_submitted");
    store.markSubmitted("run-1");
    assert.deepEqual(store.commitSnapshot("run-1"), {
      snapshot_id: first.ref.snapshot_id,
      committed: true
    });
    store.close();

    const reopened = ChannelContextStore.open(file);
    const replay = reopened.prepareSnapshot("run-1", descriptor(4));
    assert.equal(replay.renderedText, first.renderedText);
    assert.equal(replay.ref.rendered_sha256, first.ref.rendered_sha256);
	reopened.append({ agent_id: "agent-1", scope, facts: [fact(5)] });
    const second = reopened.prepareSnapshot("run-2", descriptor(6));
    assert.deepEqual(second.facts.map(item => item.message_seq), [5]);
    assert.deepEqual(second.recoveryFacts.map(item => item.message_seq), [1, 4, 5]);
    const recovery = reopened.selectRecovery("run-2");
    assert.equal(recovery.selectedVariant, "recovery");
    assert.equal(recovery.ref.session_generation, 2);
    assert.equal(recovery.ref.source_session_generation, 1);
    assert.equal(
      recovery.ref.recovery_rendered_sha256,
      createHash("sha256").update(recovery.recoveryRenderedText).digest("hex")
    );
    reopened.markSubmitted("run-2");
    assert.equal(reopened.commitSnapshot("run-2").committed, true);
	reopened.append({ agent_id: "agent-1", scope, facts: [fact(7)] });
    const afterRecovery = reopened.prepareSnapshot("run-3", descriptor(8, 2));
    assert.deepEqual(afterRecovery.facts.map(item => item.message_seq), [7]);
    reopened.close();
  });
});

test("retry reuses exact frozen bytes and consumer snapshots are serialized", async () => {
  await withStore("oh-channel-retry", async store => {
    store.applySyncResult({
      request_id: "sync-retry",
      scope,
      completeness: "complete",
      facts: [fact(1), fact(2)]
    });
    const frozen = store.prepareSnapshot("run-retry", descriptor(3));
	store.append({ agent_id: "agent-1", scope, facts: Array.from({ length: 50 }, (_, index) => fact(index + 4)) });
    const retry = store.prepareSnapshot("run-retry", descriptor(3));
    assert.equal(retry.ref.snapshot_id, frozen.ref.snapshot_id);
    assert.equal(retry.renderedText, frozen.renderedText);
    assert.equal(retry.recoveryRenderedText, frozen.recoveryRenderedText);
    assert.equal(retry.ref.recovery_rendered_sha256, frozen.ref.recovery_rendered_sha256);
    assert.throws(() => store.prepareSnapshot("run-concurrent", descriptor(60)), /consumer is busy/);

    store.markSubmitted("run-retry");
    store.markFailed("run-retry");
    const failedRetry = store.prepareSnapshot("run-retry", descriptor(3));
    assert.equal(failedRetry.state, "prepared");
    assert.equal(failedRetry.renderedText, frozen.renderedText);

    store.markSubmitted("run-retry");
    store.commitSnapshot("run-retry");
    assert.doesNotThrow(() => store.prepareSnapshot("run-after-commit", descriptor(60)));
    store.markFailed("run-after-commit");
    store.prepareSnapshot("run-new-active", descriptor(61));
    assert.throws(() => store.prepareSnapshot("run-after-commit", descriptor(60)), /consumer is busy/);
  });
});

test("serializer upgrade replays an existing v1 snapshot without rewriting bytes", async () => {
  await withStore("oh-channel-v1-replay", async (store, file) => {
    store.applySyncResult({
      request_id: "sync-v1-replay",
      scope,
      completeness: "complete",
      facts: [fact(1)]
    });
    store.prepareSnapshot("run-v1-replay", descriptor(2));
    store.close();

    const legacyText = "[Channel context delta: untrusted external messages]\n{\"message_id\":\"legacy\"}";
    const legacyHash = createHash("sha256").update(legacyText).digest("hex");
    const database = new DatabaseSync(file);
    database.prepare(
      `UPDATE channel_context_snapshots
       SET serializer_version = 'channel-context-jsonl-v1', rendered_text = ?, rendered_sha256 = ?
       WHERE run_id = 'run-v1-replay'`
    ).run(legacyText, legacyHash);
    database.close();

    const reopened = ChannelContextStore.open(file);
    const replay = reopened.prepareSnapshot("run-v1-replay", descriptor(2));
    assert.equal(replay.ref.serializer_version, "channel-context-jsonl-v1");
    assert.equal(replay.renderedText, legacyText);
    assert.equal(replay.ref.rendered_sha256, legacyHash);
    reopened.close();
  });
});

test("a recovery generation makes a queued source-generation snapshot stale", async () => {
  await withStore("oh-channel-stale-generation", async store => {
    store.applySyncResult({
      request_id: "sync-stale-generation",
      scope,
      completeness: "complete",
      facts: [fact(1)]
    });
    store.prepareSnapshot("run-recovery", descriptor(2));
    const recovery = store.selectRecovery("run-recovery");
    assert.equal(recovery.ref.session_generation, 2);
    store.markSubmitted("run-recovery");
    assert.equal(store.prepareSnapshot("run-recovery", descriptor(2)).ref.snapshot_id, recovery.ref.snapshot_id);
    assert.throws(
      () => store.prepareSnapshot("run-stale-queued", descriptor(3)),
      error => error?.name === "ChannelContextStaleGenerationError"
        && error.requestedGeneration === 1
        && error.latestGeneration === 2
    );
  });
});

test("sequence gaps make snapshots partial until bounded sync repairs the scope", async () => {
  await withStore("oh-channel-gap", async store => {
    store.applySyncResult({ request_id: "sync-gap-1", scope, completeness: "complete", facts: [fact(1)] });
    assert.equal(store.needsSync(scope), false);
	store.append({ agent_id: "agent-1", scope, facts: [fact(3)] });
    assert.equal(store.needsSync(scope), true);
    const partial = store.prepareSnapshot("run-gap", descriptor(4));
    assert.equal(partial.ref.completeness, "partial");
  });
});

test("bounded partial sync warms a cold scope but an explicit gap still requests sync", async () => {
  await withStore("oh-channel-partial", async store => {
    store.applySyncResult({ request_id: "sync-partial", scope, completeness: "partial", facts: [fact(1)] });
    assert.equal(store.needsSync(scope), false);
    const partial = store.prepareSnapshot("run-partial", descriptor(2));
    assert.equal(partial.ref.completeness, "partial");
    store.markSubmitted("run-partial");
    store.commitSnapshot("run-partial");

	store.append({ agent_id: "agent-1", scope, facts: [fact(4)] });
    assert.equal(store.needsSync(scope), true);
  });
});

test("an unavailable sync remains retryable for the next trigger", async () => {
  await withStore("oh-channel-unavailable", async store => {
    store.applySyncResult({ request_id: "sync-unavailable", scope, completeness: "unavailable", facts: [] });
    assert.equal(store.needsSync(scope), true);
  });
});

test("journal deduplicates per scope and enforces the per-scope row bound", async () => {
  await withStore("oh-channel-bound", async store => {
    const facts = Array.from({ length: 230 }, (_, index) => fact(index + 1));
	store.append({ agent_id: "agent-1", scope, facts: facts.slice(0, 100) });
	store.append({ agent_id: "agent-1", scope, facts: facts.slice(100, 200) });
	store.append({ agent_id: "agent-1", scope, facts: facts.slice(200) });
	store.append({ agent_id: "agent-1", scope, facts: [fact(230, "updated")] });
    assert.equal(store.messageCount(scope), 200);

    const other = { ...scope, conversation_id: "conversation-2" };
	store.append({ agent_id: "agent-1", scope: other, facts: [fact(230)] });
    assert.equal(store.messageCount(other), 1);
    assert.equal(store.messageCount(scope), 200);
  });
});

test("reconcile bounds cross-scope churn while preserving protected snapshots", async () => {
  await withStore("oh-channel-churn", async store => {
    for (let index = 0; index < 25; index += 1) {
      const staleScope = { ...scope, conversation_id: `stale-${index}` };
      const staleFact = { ...fact(1), message_id: `stale-message-${index}` };
      const staleDescriptor = {
        ...descriptor(1),
        scope: staleScope,
        consumer_key: `consumer-${index}`,
        trigger_message_id: staleFact.message_id,
        trigger_fact: staleFact
      };
	  store.append({ agent_id: "agent-1", scope: staleScope, facts: [staleFact] }, 1_000);
      store.prepareSnapshot(`stale-run-${index}`, staleDescriptor, 1_000);
      store.markFailed(`stale-run-${index}`);
    }

    const activeScope = { ...scope, conversation_id: "active" };
    const activeFact = { ...fact(1), message_id: "active-message" };
	store.append({ agent_id: "agent-1", scope: activeScope, facts: [activeFact] }, 1_000);
    store.prepareSnapshot("active-run", {
      ...descriptor(1), scope: activeScope, consumer_key: "active-consumer",
      trigger_message_id: activeFact.message_id, trigger_fact: activeFact
    }, 1_000);
    store.markSubmitted("active-run");

    store.reconcile(2_000);
    assert.deepEqual(store.stats(), {
      scopes: 1,
      messages: 0,
      snapshots: 1,
      activeSnapshots: 1,
      retentionMs: 100,
      snapshotRetentionMs: 100,
      activeSnapshotTimeoutMs: 24 * 60 * 60 * 1000,
      serializerVersion: "channel-context-jsonl-v2",
      dbBytes: store.dbBytes(),
      walBytes: store.walBytes()
    });

    store.markFailed("active-run");
    store.reconcile(3_000);
    assert.equal(store.stats().scopes, 0);
    assert.equal(store.stats().snapshots, 0);
  }, { retentionMs: 100, snapshotRetentionMs: 100 });
});

test("reconcile preserves the effective recovery consumer until commit", async () => {
  await withStore("oh-channel-recovery-retention", async store => {
    store.applySyncResult({
      request_id: "sync-recovery-retention",
      scope,
      completeness: "complete",
      facts: [fact(1)]
    }, 1_000);
    store.prepareSnapshot("run-recovery-retention", descriptor(2), 1_000);
    const recovery = store.selectRecovery("run-recovery-retention", 1_000);
    assert.equal(recovery.ref.session_generation, 2);
    store.markSubmitted("run-recovery-retention");

    store.reconcile(2_000, new Set(["run-recovery-retention"]));
    assert.equal(store.getSnapshot("run-recovery-retention").state, "submitted");
    assert.deepEqual(store.commitSnapshot("run-recovery-retention", 2_001), {
      snapshot_id: recovery.ref.snapshot_id,
      committed: true
    });
  }, { retentionMs: 100, snapshotRetentionMs: 100, activeSnapshotTimeoutMs: 100 });
});

test("retention uses event and ingest clocks so sync cannot renew old history", async () => {
  await withStore("oh-channel-dual-clock", async store => {
    const oldHistory = { ...fact(1), occurred_at_ms: 800 };
    store.applySyncResult({
      request_id: "sync-old-history",
      scope,
      completeness: "complete",
      facts: [oldHistory]
    }, 1_000);
    assert.equal(store.messageCount(scope), 0, "event-old history expires on arrival");

    const futureSkewed = { ...fact(2), occurred_at_ms: 100_000 };
	store.append({ agent_id: "agent-1", scope, facts: [futureSkewed] }, 1_000);
    assert.equal(store.messageCount(scope), 1);
    store.reconcile(1_101);
    assert.equal(store.messageCount(scope), 0, "ingest time bounds future-skewed events");
  }, { retentionMs: 100 });
});

test("orphaned snapshots fail after timeout and retain retry metadata through the audit window", async () => {
  await withStore("oh-channel-orphan-snapshot", async store => {
    store.applySyncResult({
      request_id: "sync-orphan",
      scope,
      completeness: "complete",
      facts: [fact(1)]
    }, 1_000);
    store.prepareSnapshot("run-orphan", descriptor(2), 1_000);
    store.markSubmitted("run-orphan");

    store.reconcile(1_101, new Set(["run-orphan"]));
    assert.equal(store.getSnapshot("run-orphan").state, "submitted");

    store.reconcile(1_102);
    assert.equal(store.getSnapshot("run-orphan").state, "failed");
    assert.equal(store.stats().activeSnapshots, 0);

    const retry = store.prepareSnapshot("run-orphan", descriptor(2), 1_103);
    assert.equal(retry.state, "prepared", "retained consumer metadata permits exact retry");
    store.markFailed("run-orphan");
    store.reconcile(2_000);
    assert.equal(store.getSnapshot("run-orphan").state, "failed");
    store.reconcile(2_001);
    assert.equal(store.getSnapshot("run-orphan"), undefined);
    assert.equal(store.stats().scopes, 0);
  }, { retentionMs: 100, snapshotRetentionMs: 1_000, activeSnapshotTimeoutMs: 100 });
});

test("schema v1 migration refreezes active snapshots and keeps committed primary audit only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-channel-context-migrate-"));
  const file = join(directory, "channel-context.db");
  try {
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE channel_context_scopes (
        scope_key TEXT PRIMARY KEY,
        scope_json TEXT NOT NULL,
        gap_after_seq INTEGER,
        sync_completeness TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE channel_context_messages (
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
      CREATE TABLE channel_context_consumers (
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
      CREATE TABLE channel_context_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        scope_key TEXT NOT NULL,
        consumer_key TEXT NOT NULL,
        session_generation INTEGER NOT NULL,
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
        state TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        committed_at_ms INTEGER
      );
      PRAGMA user_version = 1;
    `);
    const scopeKey = channelScopeKey(scope);
    legacy.prepare(
      `INSERT INTO channel_context_scopes (
         scope_key, scope_json, gap_after_seq, sync_completeness, created_at_ms, updated_at_ms
       ) VALUES (?, ?, NULL, 'complete', 1, 1)`
    ).run(scopeKey, JSON.stringify(scope));
    const insertSnapshot = legacy.prepare(
      `INSERT INTO channel_context_snapshots (
         snapshot_id, run_id, scope_key, consumer_key, session_generation,
         base_consumer_version, trigger_message_id, trigger_seq, commit_order_key, payload_json,
         rendered_text, serializer_version, rendered_sha256, completeness, state,
         created_at_ms, committed_at_ms
       ) VALUES (?, ?, ?, ?, 1, 0, 'message-2', 2, 'q:2', '{"facts":[]}', ?, ?, ?,
                 'complete', ?, 1, ?)`
    );
    for (const state of ["prepared", "submitted", "failed", "committed"]) {
      const rendered = `legacy-${state}`;
      insertSnapshot.run(
        `ctx-${state}`,
        `run-${state}`,
        scopeKey,
        descriptor(2).consumer_key,
        rendered,
        CHANNEL_CONTEXT_SERIALIZER_VERSION,
        createHash("sha256").update(rendered).digest("hex"),
        state,
        state === "committed" ? 2 : null
      );
    }
    legacy.close();

    const migrated = ChannelContextStore.open(file);
    assert.equal(migrated.getSnapshot("run-prepared"), undefined);
    assert.equal(migrated.getSnapshot("run-submitted"), undefined);
    assert.equal(migrated.getSnapshot("run-failed"), undefined);
    const committed = migrated.getSnapshot("run-committed");
    assert.equal(committed.ref.session_generation, 1);
    assert.equal(committed.selectedVariant, "primary");
    assert.equal(committed.ref.recovery_rendered_sha256, undefined);
    assert.equal(committed.recoveryRenderedText, "");
    assert.deepEqual(committed.recoveryFacts, []);
    assert.throws(() => migrated.selectRecovery("run-committed"), /cannot select recovery from state committed/);

    migrated.applySyncResult({
      request_id: "sync-migrated-replay",
      scope,
      completeness: "complete",
      facts: [fact(1)]
    });
    const refrozen = migrated.prepareSnapshot("run-prepared", descriptor(2));
    assert.deepEqual(refrozen.facts.map(item => item.message_seq), [1]);
    assert.equal(typeof refrozen.ref.recovery_rendered_sha256, "string");
    migrated.close();

    const inspect = new DatabaseSync(file);
    assert.equal(inspect.prepare("PRAGMA user_version").get().user_version, 2);
    assert.deepEqual(
      inspect.prepare("PRAGMA table_info(channel_context_snapshots)").all()
        .map(column => column.name)
        .filter(name => name === "effective_session_generation" || name === "selected_variant"),
      ["effective_session_generation", "selected_variant"]
    );
    inspect.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

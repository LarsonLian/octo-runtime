import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelContextStore,
  CHANNEL_CONTEXT_SERIALIZER_VERSION,
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
    reopened.append({ scope, facts: [fact(5)] });
    const second = reopened.prepareSnapshot("run-2", descriptor(6));
    assert.deepEqual(second.facts.map(item => item.message_seq), [5]);
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
    store.append({ scope, facts: Array.from({ length: 50 }, (_, index) => fact(index + 4)) });
    const retry = store.prepareSnapshot("run-retry", descriptor(3));
    assert.equal(retry.ref.snapshot_id, frozen.ref.snapshot_id);
    assert.equal(retry.renderedText, frozen.renderedText);
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

test("sequence gaps make snapshots partial until bounded sync repairs the scope", async () => {
  await withStore("oh-channel-gap", async store => {
    store.applySyncResult({ request_id: "sync-gap-1", scope, completeness: "complete", facts: [fact(1)] });
    assert.equal(store.needsSync(scope), false);
    store.append({ scope, facts: [fact(3)] });
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

    store.append({ scope, facts: [fact(4)] });
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
    store.append({ scope, facts: facts.slice(0, 100) });
    store.append({ scope, facts: facts.slice(100, 200) });
    store.append({ scope, facts: facts.slice(200) });
    store.append({ scope, facts: [fact(230, "updated")] });
    assert.equal(store.messageCount(scope), 200);

    const other = { ...scope, conversation_id: "conversation-2" };
    store.append({ scope: other, facts: [fact(230)] });
    assert.equal(store.messageCount(other), 1);
    assert.equal(store.messageCount(scope), 200);
  });
});

test("reconcile uses ingest time and bounds cross-scope churn while preserving active snapshots", async () => {
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
      store.append({ scope: staleScope, facts: [staleFact] }, 1_000);
      store.prepareSnapshot(`stale-run-${index}`, staleDescriptor, 1_000);
      store.markFailed(`stale-run-${index}`);
    }

    const activeScope = { ...scope, conversation_id: "active" };
    const activeFact = { ...fact(1), message_id: "active-message" };
    store.append({ scope: activeScope, facts: [activeFact] }, 1_000);
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
      dbBytes: store.dbBytes(),
      walBytes: store.walBytes()
    });

    store.markFailed("active-run");
    store.reconcile(3_000);
    assert.equal(store.stats().scopes, 0);
    assert.equal(store.stats().snapshots, 0);
  }, { retentionMs: 100, snapshotRetentionMs: 100 });
});

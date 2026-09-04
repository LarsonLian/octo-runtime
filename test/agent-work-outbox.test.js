import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentWorkStore } from "../apps/daemon/dist/agent-work-store.js";

async function withStore(name, fn) {
  const dir = await mkdtemp(join(tmpdir(), `oh-outbox-${name}-`));
  const store = AgentWorkStore.open(join(dir, "agent-work.db"));
  try {
    await fn(store, join(dir, "agent-work.db"));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("outbox appends in seq order; received releases the window, durable deletes", async () => {
  await withStore("ack", store => {
    store.upsertRun({ runId: "r1", commandId: "c1", leaseId: "l1", fencingToken: 3 });
    assert.equal(store.allocateAndAppend("r1", "run.started", {}).seq, 1);
    assert.equal(store.allocateAndAppend("r1", "message.delta", { text: "hi" }).seq, 2);

    let sendable = store.listSendable(10);
    assert.deepEqual(sendable.map(row => row.seq), [1, 2]);
    assert.equal(sendable[0].leaseId, "l1");
    assert.equal(sendable[0].fencingToken, 3);
    assert.ok(store.outboxBytes() > 0);

    // received ACK releases the send window but must NOT delete the outbox.
    assert.deepEqual(store.advanceReceived("r1", 1), { advanced: true, through: 1 });
    sendable = store.listSendable(10);
    assert.deepEqual(sendable.map(row => row.seq), [2]);
    assert.ok(store.outboxBytes() > 0);

    // durable ACK deletes confirmed rows.
    assert.deepEqual(store.advanceDurable("r1", 1), { advanced: true, through: 1 });
    assert.equal(store.pendingCount(), 1);
  });
});

test("analysis exposure provenance survives the reliable outbox and dual watermarks", async () => {
  await withStore("analysis-provenance", store => {
    store.upsertRun({ runId: "r1", commandId: "c1", leaseId: "l1", fencingToken: 3 });
    const payload = {
      channel: "analysis",
      text: "Checked the source.",
      exposure: "public_summary",
      provenance: { provider: "codex", nativeEvent: "item/reasoning/summaryTextDelta" }
    };
    store.allocateAndAppend("r1", "message.delta", payload);

    assert.deepEqual(store.listSendable(10)[0].payload, payload);
    store.advanceReceived("r1", 1);
    assert.equal(store.pendingCount(), 1);
    store.advanceDurable("r1", 1);
    assert.equal(store.pendingCount(), 0);
  });
});

test("terminal event stays active until its seq is durably acknowledged", async () => {
  await withStore("terminal", store => {
    store.upsertRun({ runId: "r1", commandId: "c1", leaseId: "l1", fencingToken: 1 });
    store.allocateAndAppend("r1", "run.started", {});
    store.allocateAndAppend("r1", "run.completed", { text: "done" });
    assert.deepEqual(store.activeRunIds(), ["r1"]);

    // received alone does not retire the run — only durable coverage does.
    store.advanceReceived("r1", 2);
    assert.deepEqual(store.activeRunIds(), ["r1"]);

    store.advanceDurable("r1", 2);
    assert.deepEqual(store.activeRunIds(), []);
    assert.equal(store.outboxBytes(), 0);
  });
});

test("duplicate, backward and out-of-range ACKs are handled without deleting unacked events", async () => {
  await withStore("acks", store => {
    store.upsertRun({ runId: "r1", commandId: "c1", leaseId: "l1", fencingToken: 1 });
    store.allocateAndAppend("r1", "run.started", {});
    store.allocateAndAppend("r1", "message.delta", { text: "a" });

    assert.deepEqual(store.advanceDurable("r1", 5), { advanced: false, reason: "ack_beyond_produced" });
    assert.equal(store.listSendable(10).length, 2);

    assert.deepEqual(store.advanceDurable("r1", 2), { advanced: true, through: 2 });
    assert.deepEqual(store.advanceDurable("r1", 2), { advanced: false, reason: "stale" });
    assert.deepEqual(store.advanceDurable("r1", 1), { advanced: false, reason: "stale" });
    assert.deepEqual(store.advanceReceived("missing", 1), { advanced: false, reason: "unknown_run" });
  });
});

test("unacknowledged events survive reopen and are replayed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-outbox-replay-"));
  const file = join(dir, "agent-work.db");
  try {
    const store = AgentWorkStore.open(file);
    store.upsertRun({ runId: "r1", commandId: "c1", leaseId: "l1", fencingToken: 1 });
    const first = store.allocateAndAppend("r1", "run.started", {});
    store.allocateAndAppend("r1", "message.delta", { text: "hi" });
    store.advanceReceived("r1", 1);
    store.advanceDurable("r1", 1);
    store.close();

    const reopened = AgentWorkStore.open(file);
    const sendable = reopened.listSendable(10);
    assert.deepEqual(sendable.map(row => row.seq), [2]);
    // stable event_id preserved across restart
    assert.notEqual(sendable[0].eventId, first.eventId);
    assert.deepEqual(reopened.activeRunIds(), ["r1"]);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("new transport connection replays received but non-durable events", async () => {
  await withStore("received-replay", store => {
    store.upsertRun({ runId: "r1", commandId: "c1", leaseId: "l1", fencingToken: 1 });
    store.allocateAndAppend("r1", "run.started", {});
    store.allocateAndAppend("r1", "message.delta", { text: "live only" });
    store.advanceReceived("r1", 2);
    store.advanceDurable("r1", 1);
    assert.deepEqual(store.listSendable(10), []);

    assert.equal(store.prepareReplayAfterReconnect(), 1);
    const replay = store.listSendable(10);
    assert.deepEqual(replay.map(row => row.seq), [2]);
    assert.equal(replay[0].payload.text, "live only");
  });
});

test("command receipts and last acked command seq persist for restart dedupe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-outbox-receipt-"));
  const file = join(dir, "agent-work.db");
  try {
    const store = AgentWorkStore.open(file);
    store.recordCommandReceipt("cmd-1", 7, true);
    store.recordCommandReceipt("cmd-2", 8, false, { code: "OUTBOX_BACKPRESSURE" });
    store.setLastAckedCommandSeq(8);
    store.close();

    const reopened = AgentWorkStore.open(file);
    assert.equal(reopened.getCommandReceipt("cmd-1").accepted, true);
    assert.equal(reopened.getCommandReceipt("cmd-2").accepted, false);
    assert.equal(reopened.getCommandReceipt("cmd-2").error.code, "OUTBOX_BACKPRESSURE");
    assert.equal(reopened.getCommandReceipt("missing"), undefined);
    assert.equal(reopened.lastAckedCommandSeq, 8);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcile clears events already within the durable watermark", async () => {
  await withStore("reconcile", store => {
    store.upsertRun({ runId: "r1", commandId: "c1", leaseId: "l1", fencingToken: 1 });
    store.allocateAndAppend("r1", "run.started", {});
    store.allocateAndAppend("r1", "run.completed", {});
    store.advanceDurable("r1", 2);
    assert.equal(store.pendingCount(), 0);
    store.reconcile();
    assert.equal(store.pendingCount(), 0);
    assert.equal(store.outboxBytes(), 0);
  });
});

test("reconcile prunes expired command receipts but keeps fresh ones", async () => {
  await withStore("prune", store => {
    store.recordCommandReceipt("old", 1, true, undefined, 1000);
    store.recordCommandReceipt("fresh", 2, true);
    store.reconcile(5000);
    assert.equal(store.getCommandReceipt("old"), undefined);
    assert.ok(store.getCommandReceipt("fresh"));
  });
});

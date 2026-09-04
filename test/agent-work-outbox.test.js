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

test("outbox appends in seq order and a cumulative ACK deletes confirmed events", async () => {
  await withStore("ack", store => {
    store.upsertRun({ runId: "r1", commandId: "c1", leaseId: "l1", fencingToken: 3 });
    assert.equal(store.allocateAndAppend("r1", "run.started", {}).seq, 1);
    assert.equal(store.allocateAndAppend("r1", "message.delta", { text: "hi" }).seq, 2);

    let sendable = store.listSendable(10);
    assert.deepEqual(sendable.map(row => row.seq), [1, 2]);
    assert.equal(sendable[0].leaseId, "l1");
    assert.equal(sendable[0].fencingToken, 3);
    assert.ok(store.outboxBytes() > 0);

    assert.deepEqual(store.ackThrough("r1", 1), { advanced: true, through: 1 });
    sendable = store.listSendable(10);
    assert.deepEqual(sendable.map(row => row.seq), [2]);
  });
});

test("terminal event stays active until its seq is acknowledged", async () => {
  await withStore("terminal", store => {
    store.upsertRun({ runId: "r1", commandId: "c1", leaseId: "l1", fencingToken: 1 });
    store.allocateAndAppend("r1", "run.started", {});
    store.allocateAndAppend("r1", "run.completed", { text: "done" });
    assert.deepEqual(store.activeRunIds(), ["r1"]);

    store.ackThrough("r1", 2);
    assert.deepEqual(store.activeRunIds(), []);
    assert.equal(store.outboxBytes(), 0);
  });
});

test("duplicate, backward and out-of-range ACKs are handled without deleting unacked events", async () => {
  await withStore("acks", store => {
    store.upsertRun({ runId: "r1", commandId: "c1", leaseId: "l1", fencingToken: 1 });
    store.allocateAndAppend("r1", "run.started", {});
    store.allocateAndAppend("r1", "message.delta", { text: "a" });

    assert.deepEqual(store.ackThrough("r1", 5), { advanced: false, reason: "ack_beyond_produced" });
    assert.equal(store.listSendable(10).length, 2);

    assert.deepEqual(store.ackThrough("r1", 2), { advanced: true, through: 2 });
    assert.deepEqual(store.ackThrough("r1", 2), { advanced: false, reason: "stale" });
    assert.deepEqual(store.ackThrough("r1", 1), { advanced: false, reason: "stale" });
    assert.deepEqual(store.ackThrough("missing", 1), { advanced: false, reason: "unknown_run" });
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
    store.ackThrough("r1", 1);
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

test("reconcile clears events already within the ack watermark", async () => {
  await withStore("reconcile", store => {
    store.upsertRun({ runId: "r1", commandId: "c1", leaseId: "l1", fencingToken: 1 });
    store.allocateAndAppend("r1", "run.started", {});
    store.allocateAndAppend("r1", "run.completed", {});
    store.ackThrough("r1", 2);
    assert.equal(store.pendingCount(), 0);
    store.reconcile();
    assert.equal(store.pendingCount(), 0);
    assert.equal(store.outboxBytes(), 0);
  });
});

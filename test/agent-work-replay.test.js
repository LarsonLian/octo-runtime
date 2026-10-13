import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentWorkStore, StreamGapError } from "../apps/daemon/dist/agent-work-store.js";

function store() {
  const value = AgentWorkStore.open("unused.db");
  value.upsertRun({ runId: "run", commandId: "command", leaseId: "lease", fencingToken: 7 });
  return value;
}

test("event replay uses source identity and sequence without ACK or SQLite writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-memory-replay-"));
  try {
    const path = join(directory, "events.db");
    const value = AgentWorkStore.open(path);
    value.upsertRun({ runId: "run", commandId: "command", leaseId: "lease", fencingToken: 7 });
    value.allocateAndAppend("run", "run.started", {});
    const identity = value.allocateAndAppend("run", "message.delta", { channel: "final", text: "hello" });
    value.allocateAndAppend("run", "run.completed", {});
    for (const row of value.listSendable(10)) value.markSent(row.runId, row.seq);
    assert.equal(value.pendingCount(), 0);
    value.resume("run", 1);
    const events = value.listSendable(10);
    assert.deepEqual(events.map(row => row.seq), [2, 3]);
    assert.equal(events[0].eventId, identity.eventId);
    assert.ok(events.every(row => row.leaseId === "lease" && row.fencingToken === 7));
    events[0].payload.text = "changed";
    assert.equal(value.read("run", value.streamId("run"), 1).events[0].payload.text, "hello");
    await assert.rejects(access(path), { code: "ENOENT" });
    await assert.rejects(access(`${path}-wal`), { code: "ENOENT" });
    const restarted = AgentWorkStore.open(path);
    assert.throws(() => restarted.read("run", value.streamId("run"), 1), /STREAM_EXPIRED/);
    value.close();restarted.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("count overflow produces an explicit gap and pauses only the cloud consumer", () => {
  const value = store();
  for (let i = 0; i < 4100; i++) value.allocateAndAppend("run", "message.delta", { text: "x" });
  assert.throws(() => value.resume("run", 0), StreamGapError);
  assert.throws(() => value.listSendable(10), StreamGapError);
  value.pauseCloudStream("run");
  assert.deepEqual(value.listSendable(10), []);
  const local = value.read("run", undefined, 4);
  assert.equal(local.events.length, 4096);
  assert.equal(local.events[0].seq, 5);
  assert.throws(() => value.read("run", local.streamId, 4101), /STREAM_CURSOR_INVALID/);
});

test("byte limits, expiry and capacity remain bounded", () => {
  const value = store();
  assert.throws(() => value.allocateAndAppend("run", "message.delta", { text: "x".repeat(256 << 10) }), /STREAM_EVENT_TOO_LARGE/);
  for (let i = 0; i < 100; i++) value.allocateAndAppend("run", "message.delta", { text: "x".repeat(64 << 10) });
  assert.ok(value.outboxBytes() <= 4 << 20);
  assert.throws(() => value.read("run", undefined, 0), StreamGapError);
  value.allocateAndAppend("run", "run.completed", {});
  value.reconcile(Date.now() + 120_001);
  assert.throws(() => value.read("run", undefined, 100), /STREAM_EXPIRED/);
  assert.equal(value.outboxBytes(), 0);
});

test("command receipts are bounded acceptance records and expire without an event ACK", () => {
  const value = store();
  value.recordCommandReceipt("command", 7, false, { code: "denied" });
  assert.equal(value.getCommandReceipt("command").accepted, false);
  value.reconcile(Date.now() + 120_001);
  assert.equal(value.getCommandReceipt("command"), undefined);
  assert.throws(() => value.upsertRun({ runId: "run", commandId: "other", leaseId: "other", fencingToken: 8 }), /RUN_LEASE_MISMATCH/);
});

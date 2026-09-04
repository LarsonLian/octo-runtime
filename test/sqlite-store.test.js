import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@mininglamp-oss/octo-harness-core";

const event = (runId, seq, type = "message.delta") => ({
  id: `e${seq}`, seq, tsMs: seq, sessionId: "s1", runId, type, payload: {}
});

test("SqliteStore persists domain state across reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-sqlite-"));
  try {
    const file = join(dir, "state.db");
    const store = SqliteStore.open(file);
    await store.transaction(() => {
      store.putAgent({ id: "a1", name: "A", adapterType: "test", config: {} });
      store.putSession({ id: "s1", type: "chat", status: "active", agentId: "a1" });
      store.putRun({ id: "r1", sessionId: "s1", status: "queued", nextSeq: 2 });
      store.appendEvent(event("r1", 1, "run.queued"));
    });
    store.close();

    const reopened = SqliteStore.open(file);
    assert.equal(reopened.getAgent("a1").name, "A");
    assert.equal(reopened.getSession("s1").type, "chat");
    assert.equal(reopened.hasRun("r1"), true);
    assert.equal(reopened.getRun("r1").nextSeq, 2);
    assert.equal(reopened.getEvents("r1").length, 1);
    assert.equal(reopened.getEvents("r1")[0].type, "run.queued");
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SqliteStore appendEvent deduplicates on (runId, seq)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-sqlite-dedupe-"));
  try {
    const store = SqliteStore.open(join(dir, "state.db"));
    store.putRun({ id: "r1", sessionId: "s1", status: "queued", nextSeq: 1 });
    assert.equal(store.appendEvent(event("r1", 1)), true);
    assert.equal(store.appendEvent(event("r1", 1)), false);
    assert.equal(store.getEvents("r1").length, 1);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SqliteStore occurrence lookups by dedupe key, id and task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-sqlite-occ-"));
  try {
    const store = SqliteStore.open(join(dir, "state.db"));
    const occurrence = {
      id: "occ1", triggerId: "t1", externalEventId: "ext-1",
      kind: "manual", payload: {}, createdAt: 1, taskId: "task1"
    };
    store.putOccurrence(occurrence);
    assert.equal(store.getOccurrenceByKey("t1", "ext-1").id, "occ1");
    assert.equal(store.getOccurrenceByKey("t1", "missing"), undefined);
    assert.equal(store.findOccurrenceById("occ1").taskId, "task1");
    assert.equal(store.findOccurrenceByTaskId("task1").id, "occ1");
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SqliteStore transaction rolls back all writes on error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-sqlite-rollback-"));
  try {
    const store = SqliteStore.open(join(dir, "state.db"));
    await assert.rejects(store.transaction(() => {
      store.putAgent({ id: "a1", name: "A", adapterType: "test", config: {} });
      throw new Error("boom");
    }), /boom/);
    assert.equal(store.getAgent("a1"), undefined);
    assert.equal(store.listAgents().length, 0);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

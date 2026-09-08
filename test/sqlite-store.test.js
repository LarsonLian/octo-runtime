import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@mininglamp-oss/octo-harness-core";

const event = (runId, seq, type = "message.delta") => ({
  id: `e${seq}`, seq, tsMs: seq, agentSessionId: "asess-1", runId, type, payload: {}
});

test("SqliteStore persists unified AgentSession and AgentRun state across reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-sqlite-"));
  try {
    const file = join(dir, "state.db");
    const store = SqliteStore.open(file);
    await store.transaction(() => {
      store.putAgent({ id: "a1", name: "A", adapterType: "test", config: {} });
      store.putAgentSession({
        id: "asess-1", namespace: "loop", agentId: "a1", sessionKey: "v1/task/t-1",
        status: "active", generation: 1, nextRunNo: 2, createdAt: 1
      });
      store.putAgentRun({
        id: "arun-1", agentSessionId: "asess-1", runNo: 1, status: "queued", nextSeq: 2,
        trigger: { kind: "loop.task.ready", occurrenceId: "task-event/e-1" }, input: {}, requestHash: "hash"
      });
      store.appendEvent(event("arun-1", 1, "run.queued"));
    });
    store.close();

    const reopened = SqliteStore.open(file);
    assert.equal(reopened.getAgent("a1").name, "A");
    assert.equal(reopened.getAgentSessionByKey("loop", "a1", "v1/task/t-1").id, "asess-1");
    assert.equal(reopened.getAgentRunByOccurrence("asess-1", "task-event/e-1").id, "arun-1");
    assert.equal(reopened.getEvents("arun-1")[0].type, "run.queued");
    reopened.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("SqliteStore deduplicates AgentRun events on (agent_run_id, seq)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-sqlite-dedupe-"));
  try {
    const store = SqliteStore.open(join(dir, "state.db"));
    assert.equal(store.appendEvent(event("arun-1", 1)), true);
    assert.equal(store.appendEvent(event("arun-1", 1)), false);
    assert.equal(store.getEvents("arun-1").length, 1);
    store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("SqliteStore transaction rolls back all writes on error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-sqlite-rollback-"));
  try {
    const store = SqliteStore.open(join(dir, "state.db"));
    await assert.rejects(store.transaction(() => {
      store.putAgent({ id: "a1", name: "A", adapterType: "test", config: {} });
      throw new Error("boom");
    }), /boom/);
    assert.equal(store.listAgents().length, 0);
    store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

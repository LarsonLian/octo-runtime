import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@mininglamp-oss/octo-harness-core";
import { contextHash } from "@mininglamp-oss/octo-harness-protocol";

const context = { schema: "octo.context-envelope/v1", items: [
  { namespace: "octo.execution", name: "adapter", payload: { type: "test" } },
  { namespace: "octo.execution", name: "workspace", payload: { mode: "fixed", path: process.cwd() } },
  { namespace: "octo.security", name: "approval_policy", payload: { mode: "ask" } }
] };
const agentRecord = (id, name) => ({ id, name, adapterType: "test", config: {}, defaultContext: structuredClone(context), contextDefaultsVersion: 1 });

const event = (runId, seq, type = "message.delta") => ({
  id: `e${seq}`, seq, tsMs: seq, agentSessionId: "asess-1", runId, type, payload: {}
});

test("SqliteStore persists unified AgentSession and AgentRun state across reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-sqlite-"));
  try {
    const file = join(dir, "state.db");
    const store = SqliteStore.open(file);
    await store.transaction(() => {
      store.putAgent(agentRecord("a1", "A"));
      store.putAgentSession({
        id: "asess-1", namespace: "loop", agentId: "a1", sessionKey: "v1/task/t-1",
        status: "active", generation: 1, nextRunNo: 2, createdAt: 1
      });
      store.putAgentRun({
        id: "arun-1", agentSessionId: "asess-1", runNo: 1, status: "queued", nextSeq: 2,
        trigger: { kind: "loop.task.ready", occurrenceId: "task-event/e-1" }, input: {}, requestHash: "hash",
        context: { schema: context.schema, items: [] }, effectiveContext: context, contextHash: contextHash(context), contextDefaultsVersion: 1,
        resolvedExecutionPlan: { adapter_type: "test", workdir: process.cwd(), approval_mode: "ask" },
        materialization: { id: "a1", name: "A", adapterType: "test", config: {} }
      });
      store.appendEvent(event("arun-1", 1, "run.queued"));
    });
    store.close();

    const reopened = SqliteStore.open(file);
    assert.equal(reopened.getAgent("a1").name, "A");
    assert.equal(reopened.getAgent("a1").contextDefaultsVersion, 1);
    assert.deepEqual(reopened.getAgent("a1").defaultContext, context);
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
      store.putAgent(agentRecord("a1", "A"));
      throw new Error("boom");
    }), /boom/);
    assert.equal(store.listAgents().length, 0);
    store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("SqliteStore nested transaction rolls back to a savepoint without aborting the outer transaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-sqlite-savepoint-"));
  try {
    const store = SqliteStore.open(join(dir, "state.db"));
    await store.transaction(() => {
      store.putAgent(agentRecord("outer-before", "before"));
      assert.throws(() => store.transaction(() => {
        store.putAgent(agentRecord("inner", "inner"));
        throw new Error("nested boom");
      }), /nested boom/);
      store.putAgent(agentRecord("outer-after", "after"));
    });

    assert.deepEqual(store.listAgents().map(agent => agent.id).sort(), ["outer-after", "outer-before"]);
    store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

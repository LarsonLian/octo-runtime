import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessEngine, MemoryStore, SqliteStore } from "@mininglamp-oss/octo-harness-core";

const context = { schema: "octo.context-envelope/v1", items: [
  { namespace: "octo.execution", name: "adapter", payload: { type: "test" } },
  { namespace: "octo.execution", name: "workspace", payload: { mode: "fixed", path: process.cwd() } },
  { namespace: "octo.security", name: "approval_policy", payload: { mode: "ask" } }
] };

for (const kind of ["memory", "sqlite"]) {
  test(`${kind} store isolates caller objects and rejects immutable Run snapshot rewrites`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "oh-local-snapshot-"));
    const store = kind === "memory" ? new MemoryStore() : SqliteStore.open(join(directory, "state.db"));
    try {
      const engine = new HarnessEngine({ store, host: { list: () => [{ type: "test" }] } });
      const agent = await engine.registerAgent({ name: "local", defaultContext: context, config: { providerAgentId: "original" } });
      const submitted = await engine.submitAgentRun({
        namespace: "local", agentId: agent.id, sessionKey: "v1/task/store",
        trigger: { kind: "manual", occurrenceId: "store" }, input: { prompt: "hello" },
        context: { schema: context.schema, items: [] }
      });
      const run = store.getAgentRun(submitted.agentRun.id);
      run.materialization.config.providerAgentId = "mutated";
      assert.equal(store.getAgentRun(run.id).materialization.config.providerAgentId, "original");
      assert.throws(() => store.putAgentRun(run), /LOCAL_RUN_SNAPSHOT_IMMUTABLE/);
      const invalid = store.getAgentRun(run.id);
      invalid.resolvedExecutionPlan.approval_mode = "full_access";
      assert.throws(() => store.putAgentRun(invalid), /LOCAL_RUN_SNAPSHOT_INVALID/);
      const legitimate = store.getAgentRun(run.id);
      legitimate.status = "running";
      legitimate.invocationId = "invocation";
      store.putAgentRun(legitimate);
      legitimate.materialization.config.providerAgentId = "after-put";
      assert.equal(store.getAgentRun(run.id).status, "running");
      assert.equal(store.getAgentRun(run.id).materialization.config.providerAgentId, "original");
      store.getAgent(agent.id).config.providerAgentId = "after-get";
      assert.equal(store.getAgent(agent.id).config.providerAgentId, "original");
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("SQLite reopen retains the submitted Context, defaults version and frozen plan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-local-reopen-"));
  const file = join(directory, "state.db");
  let store = SqliteStore.open(file);
  const requests = [];
  const host = {
    list: () => [{ type: "test" }],
    async *invoke(adapterType, request) {
      requests.push(request);
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    },
    cancel: () => true
  };
  try {
    let engine = new HarnessEngine({ store, host });
    const agent = await engine.registerAgent({ name: "persisted", defaultContext: context });
    const input = {
      namespace: "local", agentId: agent.id, sessionKey: "v1/task/reopen",
      trigger: { kind: "manual", occurrenceId: "reopen" }, input: { prompt: "hello" },
      context: { schema: context.schema, items: [{ namespace: "octo.execution", name: "model", payload: { id: "frozen" } }] }
    };
    const submitted = await engine.submitAgentRun(input);
    await engine.replaceDefaultContext({ agentId: agent.id, expectedVersion: 1, context: {
      schema: context.schema, items: context.items.map(item => item.name === "approval_policy" ? { ...item, payload: { mode: "full_access" } } : item)
    } });
    store.close();
    store = SqliteStore.open(file);
    engine = new HarnessEngine({ store, host });
    const duplicate = await engine.submitAgentRun(input);
    assert.equal(duplicate.agentRun.contextDefaultsVersion, 1);
    assert.equal(duplicate.agentRun.contextHash, submitted.agentRun.contextHash);
    assert.deepEqual(duplicate.agentRun.context, input.context);
    await engine.executeRun(submitted.agentRun.id);
    assert.equal(requests[0].approvalMode, "ask");
    assert.equal(requests[0].agentConfig.model, "frozen");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

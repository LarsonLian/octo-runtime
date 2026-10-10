import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterHost } from "@mininglamp-oss/octo-harness-adapter-host";
import { HarnessEngine, SqliteStore } from "@mininglamp-oss/octo-harness-core";
import { HarnessDaemon } from "@mininglamp-oss/octo-harness-daemon";
import { testAdapter } from "./fixtures/test-adapter.js";

const emptyContext = () => ({ schema: "octo.context-envelope/v3", items: [] });
const defaultContext = adapterType => ({
  schema: "octo.context-envelope/v3",
  items: [ { namespace: "octo.execution", name: "adapter", payload: { type: adapterType } }, { namespace: "octo.execution", name: "workspace", payload: { mode: "fixed", path: process.cwd() } }, { namespace: "octo.security", name: "approval_policy", payload: { mode: "full_access" } } ]
});

test("daemon recovers queued AgentRuns and terminalizes orphaned running runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-harness-recovery-"));
  try {
    const store = SqliteStore.open(join(directory, "state.db"));
    const host = new AdapterHost(); host.register(testAdapter);
    const engine = new HarnessEngine({ store, host });
    const agent = await engine.registerAgent({ agentSource: "provisioned", name: "test", defaultContext: defaultContext("test") });
    const queued = await engine.submitAgentRun({
      namespace: "loop", agentKey: agent.id, sessionKey: "v1/task/task-1",
      trigger: { kind: "loop.task.ready", occurrenceKey: "task-event/e-1" }, input: { prompt: "run" }, context: emptyContext()
    });
    const daemon = new HarnessDaemon({ engine, store });
    await daemon.recover();
    assert.equal((await daemon.waitForRun(queued.agentRun.id)).run.status, "completed");
    daemon.stop(); store.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("daemon deduplicates occurrences and executes one session in run_no order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-harness-fifo-"));
  try {
    const file = join(directory, "state.db");
    const store = SqliteStore.open(file);
    const host = new AdapterHost(); host.register(testAdapter);
    const engine = new HarnessEngine({ store, host });
    const daemon = new HarnessDaemon({ engine, store });
    const agent = await engine.registerAgent({ agentSource: "provisioned", name: "test", defaultContext: defaultContext("test") });
    const base = { namespace: "im", agentKey: agent.id, sessionKey: "v1/octo/ep-1/group/g-1", context: emptyContext() };
    const first = await daemon.submitAgentRun({
      ...base, trigger: { kind: "im.message", occurrenceKey: "message/m-1" }, input: { prompt: "one" }
    });
    const second = await daemon.submitAgentRun({
      ...base, trigger: { kind: "im.message", occurrenceKey: "message/m-2" }, input: { prompt: "two" }
    });
    const duplicate = await daemon.submitAgentRun({
      ...base, trigger: { kind: "im.message", occurrenceKey: "message/m-1" }, input: { prompt: "one" }
    });
    assert.equal(duplicate.deduplicated, true);
    await Promise.all([daemon.waitForRun(first.runKey), daemon.waitForRun(second.runKey)]);
    assert.deepEqual(
      store.listAgentRuns().sort((a, b) => a.runNo - b.runNo).map(run => [run.runNo, run.status]),
      [[1, "completed"], [2, "completed"]]
    );
    assert.equal(new Set(store.listAgentRuns().map(run => run.agentSessionKey)).size, 1);
    daemon.stop(); store.close();

    const reopened = SqliteStore.open(file);
    assert.equal(reopened.listAgentSessions().length, 1);
    assert.equal(reopened.listAgentRuns().length, 2);
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("daemon drain closes admission and waits for active Runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-harness-drain-"));
  let releaseProvider;
  const providerGate = new Promise(resolve => { releaseProvider = resolve; });
  try {
    const store = SqliteStore.open(join(directory, "state.db"));
    const host = new AdapterHost();
    host.register({
      metadata: { type: "slow", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access"] },
      async *invoke() {
        await providerGate;
        yield { protocolVersion: 2, type: "run.completed", payload: {} };
      }
    });
    const engine = new HarnessEngine({ store, host });
    const daemon = new HarnessDaemon({ engine, store });
    const agent = await engine.registerAgent({ agentSource: "provisioned", name: "slow", defaultContext: defaultContext("slow") });
    const base = { namespace: "test", agentKey: agent.id, sessionKey: "v1/drain", context: emptyContext() };
    const accepted = await daemon.submitAgentRun({
      ...base,
      trigger: { kind: "test", occurrenceKey: "occurrence-1" },
      input: { prompt: "wait" }
    });

    daemon.beginDrain();
    const draining = daemon.waitForDrained(1_000);
    await assert.rejects(
      daemon.submitAgentRun({
        ...base,
        trigger: { kind: "test", occurrenceKey: "occurrence-2" },
        input: { prompt: "must reject" }
      }),
      error => error.code === "DAEMON_DRAINING"
    );
    assert.equal(daemon.status.draining, true);
    assert.equal(daemon.status.activeRuns, 1);

    releaseProvider();
    await draining;
    assert.equal(daemon.status.activeRuns, 0);
    assert.equal((await daemon.waitForRun(accepted.runKey)).run.status, "completed");
    daemon.stop();
    store.close();
  } finally {
    releaseProvider?.();
    await rm(directory, { recursive: true, force: true });
  }
});

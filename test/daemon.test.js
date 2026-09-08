import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterHost } from "@mininglamp-oss/octo-harness-adapter-host";
import { HarnessEngine, SqliteStore } from "@mininglamp-oss/octo-harness-core";
import { HarnessDaemon } from "@mininglamp-oss/octo-harness-daemon";
import { testAdapter } from "./fixtures/test-adapter.js";

test("daemon recovers queued AgentRuns and terminalizes orphaned running runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-harness-recovery-"));
  try {
    const store = SqliteStore.open(join(directory, "state.db"));
    const host = new AdapterHost(); host.register(testAdapter);
    const engine = new HarnessEngine({ store, host });
    const agent = await engine.registerAgent({ name: "test", adapterType: "test" });
    const queued = await engine.submitAgentRun({
      namespace: "loop", agentId: agent.id, sessionKey: "v1/task/task-1",
      trigger: { kind: "loop.task.ready", occurrenceId: "task-event/e-1" }, input: { prompt: "run" }
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
    const agent = await engine.registerAgent({ name: "test", adapterType: "test" });
    const base = { namespace: "im", agentId: agent.id, sessionKey: "v1/octo/ep-1/group/g-1" };
    const first = await daemon.submitAgentRun({
      ...base, trigger: { kind: "im.message", occurrenceId: "message/m-1" }, input: { prompt: "one" }
    });
    const second = await daemon.submitAgentRun({
      ...base, trigger: { kind: "im.message", occurrenceId: "message/m-2" }, input: { prompt: "two" }
    });
    const duplicate = await daemon.submitAgentRun({
      ...base, trigger: { kind: "im.message", occurrenceId: "message/m-1" }, input: { prompt: "one" }
    });
    assert.equal(duplicate.deduplicated, true);
    await Promise.all([daemon.waitForRun(first.agentRunId), daemon.waitForRun(second.agentRunId)]);
    assert.deepEqual(
      store.listAgentRuns().sort((a, b) => a.runNo - b.runNo).map(run => [run.runNo, run.status]),
      [[1, "completed"], [2, "completed"]]
    );
    assert.equal(new Set(store.listAgentRuns().map(run => run.agentSessionId)).size, 1);
    daemon.stop(); store.close();

    const reopened = SqliteStore.open(file);
    assert.equal(reopened.listAgentSessions().length, 1);
    assert.equal(reopened.listAgentRuns().length, 2);
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

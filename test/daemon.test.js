import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterHost } from "@mininglamp-oss/octo-harness-adapter-host";
import { HarnessEngine, SqliteStore } from "@mininglamp-oss/octo-harness-core";
import { HarnessDaemon } from "@mininglamp-oss/octo-harness-daemon";
import { testAdapter } from "./fixtures/test-adapter.js";

test("daemon recovery queues a materialized task that has no run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-harness-orphan-test-"));
  try {
    const store = SqliteStore.open(join(directory, "state.db"));
    const host = new AdapterHost(); host.register(testAdapter);
    const engine = new HarnessEngine({ store, host });
    const agent = await engine.registerAgent({ name: "test", adapterType: "test" });
    const trigger = await engine.createTrigger({ kind: "manual", agentId: agent.id, task: { title: "T", description: "Do T" } });
    const created = await engine.materializeTrigger(trigger.id, { externalEventId: "before-crash" });
    assert.equal(created.task.activeRunId, undefined);
    const daemon = new HarnessDaemon({ engine, store }); await daemon.recover();
    const runId = store.getTask(created.task.id).activeRunId;
    assert.ok(runId); assert.equal((await daemon.waitForRun(runId)).run.status, "completed"); daemon.stop();
    store.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("daemon ACKs durable work, deduplicates triggers, and continues one task session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-harness-store-test-"));
  try {
    const file = join(directory, "state.db");
    const store = SqliteStore.open(file);
    const host = new AdapterHost(); host.register(testAdapter);
    const engine = new HarnessEngine({ store, host });
    const daemon = new HarnessDaemon({ engine, store });
    const agent = await engine.registerAgent({ name: "test", adapterType: "test" });
    const trigger = await engine.createTrigger({ kind: "manual", agentId: agent.id, task: { title: "T", description: "Do T" } });
    const ack = await daemon.submitTrigger(trigger.id, { externalEventId: "event-1" });
    assert.equal(ack.accepted, true);
    const first = await daemon.waitForRun(ack.runId);
    assert.equal(first.run.status, "completed");
    const duplicate = await daemon.submitTrigger(trigger.id, { externalEventId: "event-1" });
    assert.equal(duplicate.deduplicated, true);

    const eventTrigger = await engine.createTrigger({ kind: "event", eventType: "repo.changed", filter: { branch: "main" }, agentId: agent.id, task: { title: "Event", description: "Handle event" } });
    assert.equal((await daemon.ingestEvent({ eventType: "repo.changed", externalEventId: "change-ignored", payload: { branch: "dev" } })).length, 0);
    const eventAcks = await daemon.ingestEvent({ eventType: "repo.changed", externalEventId: "change-1", payload: { branch: "main" } });
    assert.equal(eventAcks.length, 1);
    await daemon.waitForRun(eventAcks[0].runId);

    const chat = await engine.createChatSession({ agentId: agent.id, title: "Chat" });
    const chatOne = await daemon.submitChat(chat.id, "hello"); await daemon.waitForRun(chatOne.runId);
    const chatTwo = await daemon.submitChat(chat.id, "continue"); await daemon.waitForRun(chatTwo.runId);
    assert.equal(store.getSession(chat.id).providerSession.sessionId, `test:${chat.id}`);
    assert.equal(store.getRun(chatOne.runId).sessionId, store.getRun(chatTwo.runId).sessionId);

    const continued = await daemon.continueTask(ack.taskId, { sourceType: "comment", sourceId: "comment-1", instructions: "continue" });
    await daemon.waitForRun(continued.runId);
    const attempts = store.listAttemptsByTask(ack.taskId);
    assert.equal(attempts.length, 2);
    assert.equal(new Set(attempts.map(item => store.getRun(item.runId).sessionId)).size, 1);
    daemon.stop();
    store.close();

    const reopened = SqliteStore.open(file);
    assert.equal(reopened.listTasks().length, 2);
    assert.equal(reopened.listRuns().length, 5);
    assert.equal(reopened.getEvents(continued.runId).at(-1).type, "run.finished");
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

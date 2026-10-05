import test from "node:test";
import assert from "node:assert/strict";
import { AdapterHost } from "@mininglamp-oss/octo-harness-adapter-host";
import { HarnessEngine, MemoryStore } from "@mininglamp-oss/octo-harness-core";
import { testAdapter } from "./fixtures/test-adapter.js";

test("one trigger occurrence creates one AgentRun and preserves Provider resume state", async () => {
  const host = new AdapterHost(); host.register(testAdapter);
  const store = new MemoryStore(); const engine = new HarnessEngine({ store, host });
  const agent = await engine.registerAgent({ name: "test", adapterType: "test" });
  const request = {
  protocolVersion: 2,
    namespace: "loop",
    agentId: agent.id,
    sessionKey: "v1/task/task-1",
    trigger: { kind: "loop.task.manual", occurrenceId: "task-event/event-1" },
    input: { prompt: "Do T" }
  };
  const first = await engine.submitAgentRun(request);
  const result = await engine.executeRun(first.agentRun.id);
  const duplicate = await engine.submitAgentRun(request);
  assert.equal(result.run.status, "completed");
  assert.equal(result.events[0].type, "run.queued");
  assert.equal(result.events[1].type, "run.started");
  assert.equal(result.events.at(-1).type, "run.completed");
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.agentRun.id, first.agentRun.id);
  assert.equal(store.listAgentRuns().length, 1);
  assert.equal(store.getAgentSession(first.agentSession.id).providerSession.sessionId, `test:${first.agentSession.id}`);
});

test("same occurrence with changed input is rejected", async () => {
  const host = new AdapterHost(); host.register(testAdapter);
  const store = new MemoryStore(); const engine = new HarnessEngine({ store, host });
  const agent = await engine.registerAgent({ name: "test", adapterType: "test" });
  const base = {
    namespace: "webhook", agentId: agent.id, sessionKey: "v1/hook/h-1/subject/s-1",
    trigger: { kind: "webhook.delivery", occurrenceId: "delivery/d-1" }
  };
  await engine.submitAgentRun({ ...base, input: { prompt: "one" } });
  await assert.rejects(engine.submitAgentRun({ ...base, input: { prompt: "two" } }), /different AgentRun request/);
});

test("only one concurrent executeRun call can claim a queued AgentRun", async () => {
  const host = new AdapterHost(); host.register(testAdapter);
  const store = new MemoryStore(); const engine = new HarnessEngine({ store, host });
  const agent = await engine.registerAgent({ name: "test", adapterType: "test" });
  const submitted = await engine.submitAgentRun({
    namespace: "loop",
    agentId: agent.id,
    sessionKey: "v1/task/concurrent",
    trigger: { kind: "loop.task.manual", occurrenceId: "task-event/concurrent" },
    input: { prompt: "Do once" }
  });

  const outcomes = await Promise.allSettled([
    engine.executeRun(submitted.agentRun.id),
    engine.executeRun(submitted.agentRun.id)
  ]);

  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === "rejected").length, 1);
  assert.equal(store.getEvents(submitted.agentRun.id).filter(item => item.type === "run.started").length, 1);
});

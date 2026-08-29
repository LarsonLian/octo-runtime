import test from "node:test";
import assert from "node:assert/strict";
import { AdapterHost } from "@orbtex-ai/orbtex-adapter-host";
import { HarnessEngine, MemoryStore } from "@orbtex-ai/orbtex-core";
import { mockAdapter } from "@orbtex-ai/orbtex-adapter-mock";

test("trigger occurrence is deduplicated and produces a terminal run", async () => {
  const host = new AdapterHost(); host.register(mockAdapter);
  const store = new MemoryStore(); const engine = new HarnessEngine({ store, host });
  const agent = await engine.registerAgent({ name: "test", adapterType: "mock" });
  const trigger = await engine.createTrigger({ kind: "manual", agentId: agent.id, task: { title: "T", description: "Do T" } });
  const first = await engine.fire(trigger.id, { externalEventId: "event-1" });
  const second = await engine.fire(trigger.id, { externalEventId: "event-1" });
  assert.equal(first.result.run.status, "completed");
  assert.equal(first.result.events.at(-1).type, "run.finished");
  assert.equal(first.result.events[0].type, "run.queued");
  assert.equal(first.result.events[1].type, "run.running");
  assert.equal(store.sessions.get(first.task.sessionId).providerSession.sessionId.startsWith("mock:"), true);
  assert.equal(second.deduplicated, true);
  assert.equal(store.tasks.size, 1);
});

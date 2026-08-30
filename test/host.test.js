import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { AdapterHost, spawnAdapterHost } from "@orbtex-ai/orbtex-adapter-host";

const request = { invocationId: "inv-host", sessionId: "s", runId: "r", prompt: "p", workdir: process.cwd() };

test("host holds terminal until adapter stream cleanup succeeds", async () => {
  const host = new AdapterHost();
  host.register({ metadata: { type: "bad", capabilities: [] }, async *invoke() { yield { type: "run.finished", payload: {} }; throw new Error("cleanup failed"); } });
  const events = []; for await (const event of host.invoke("bad", request)) events.push(event);
  assert.deepEqual(events.map(x => x.type), ["run.error"]);
  assert.match(events[0].payload.message, /cleanup failed/);
});

test("host synthesizes stopped when adapter exits without terminal", async () => {
  const host = new AdapterHost();
  host.register({ metadata: { type: "short", capabilities: [] }, async *invoke() { yield { type: "message.create", payload: {} }; } });
  const events = []; for await (const event of host.invoke("short", request)) events.push(event);
  assert.equal(events.at(-1).type, "run.stopped");
});

test("host cancellation aborts provider and emits stopped once", async () => {
  const host = new AdapterHost();
  host.register({ metadata: { type: "slow", capabilities: [] }, async *invoke(req) {
    yield { type: "message.create", payload: {} };
    await new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  } });
  const events = [];
  const consume = (async () => { for await (const event of host.invoke("slow", { ...request, invocationId: "cancel-me" })) events.push(event); })();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.cancel("cancel-me", "test_cancel"), true);
  await consume;
  assert.equal(events.at(-1).type, "run.stopped");
  assert.equal(events.filter(item => item.type.startsWith("run.")).length, 1);
});

test("separate adapter-host process loads manifest and streams events", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const processHost = await spawnAdapterHost({ entrypoint: `${root}/apps/adapter-host/dist/index.js`, manifest: `${root}/test/fixtures/adapters.json` });
  try {
    assert.equal(processHost.child.spawnargs[0], "orbtex-adapter-host");
    assert.equal((await processHost.client.list()).some(item => item.type === "test"), true);
    const events = []; for await (const event of processHost.client.invoke("test", { ...request, invocationId: "rpc-inv" })) events.push(event);
    assert.equal(events.at(-1).type, "run.finished");
  } finally { await processHost.close(); }
});

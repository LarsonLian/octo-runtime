import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { AdapterHost, AdapterHostRpcClient, AdapterHostRpcServer, spawnAdapterHost } from "@mininglamp-oss/octo-harness-adapter-host";

const request = { invocationId: "inv-host", agentSessionId: "s", runId: "r", prompt: "p", workdir: process.cwd() };

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

test("host preserves a strict trace capture error code in its synthesized terminal", async () => {
  const host = new AdapterHost({
    observe: async () => {
      throw Object.assign(new Error("provider trace capture failed"), { code: "trace_capture_failed" });
    }
  });
  host.register({
    metadata: { type: "capture-failure", capabilities: [] },
    async *invoke(_request, context) {
      await context.observe({
        event: "provider.input",
        rpcMethod: "turn/start",
        carrier: { kind: "json_params", content: { prompt: "strict input" } }
      });
      yield { type: "run.finished", payload: {} };
    }
  });
  const events = [];
  for await (const event of host.invoke("capture-failure", request)) events.push(event);
  assert.equal(events.at(-1).type, "run.error");
  assert.equal(events.at(-1).payload.code, "trace_capture_failed");
});

test("host gives adapters a provider observation context with full invocation identity", async () => {
  const observations = [];
  const host = new AdapterHost({
    observe: async (identity, observation) => {
      observations.push({ identity, observation });
      return { captureId: "cap-test", state: "durable", complete: true };
    }
  });
  host.register({
    metadata: { type: "observed", capabilities: [] },
    async *invoke(_request, context) {
      const receipt = await context.observe({
        event: "provider.input",
        rpcMethod: "turn/start",
        carrier: { kind: "json_params", content: { prompt: "raw input" } }
      });
      assert.equal(receipt.state, "durable");
      yield { type: "run.finished", payload: {} };
    }
  });

  const events = [];
  for await (const event of host.invoke("observed", request)) events.push(event);
  assert.equal(events.at(-1).type, "run.finished");
  assert.deepEqual(observations[0].identity, {
    runId: "r",
    invocationId: "inv-host",
    agentSessionId: "s",
    adapterType: "observed"
  });
  assert.equal(observations[0].observation.rpcMethod, "turn/start");
});

test("host normalizes unclassified analysis to an explicit fail-closed exposure", async () => {
  const host = new AdapterHost();
  host.register({
    metadata: { type: "legacy", capabilities: [] },
    async *invoke() {
      yield { type: "message.delta", payload: { channel: "analysis", text: "internal" } };
      yield { type: "run.finished", payload: {} };
    }
  });
  const events = [];
  for await (const event of host.invoke("legacy", request)) events.push(event);
  const analysis = events.filter(event => event.type.startsWith("message."));
  assert.equal(analysis.length, 3);
  for (const event of analysis) {
    assert.equal(event.payload.exposure, "unknown");
    assert.deepEqual(event.payload.provenance, { provider: "legacy", nativeEvent: "unknown" });
  }
});

test("host keeps step-scoped analysis messages separate and closes each round", async () => {
  const host = new AdapterHost();
  host.register({
    metadata: { type: "steps", capabilities: [] },
    async *invoke() {
      for (const stepId of ["step-1", "step-2"]) {
        yield { type: "model_step.started", payload: { stepId } };
        yield {
          type: "message.delta",
          payload: {
            channel: "analysis", messageId: `${stepId}:reasoning`, stepId, text: `${stepId} thought`,
            exposure: "public_reasoning", provenance: { provider: "steps", nativeEvent: "reasoning" }
          }
        };
        yield { type: "model_step.finished", payload: { stepId, status: "completed", finishReason: stepId === "step-1" ? "tool-calls" : "stop" } };
      }
      yield { type: "run.finished", payload: {} };
    }
  });
  const events = [];
  for await (const event of host.invoke("steps", request)) events.push(event);
  const analysisCreates = events.filter(event => event.type === "message.create" && event.payload.channel === "analysis");
  const analysisUpdates = events.filter(event => event.type === "message.update" && event.payload.channel === "analysis");
  assert.deepEqual(analysisCreates.map(event => event.payload.messageId), ["step-1:reasoning", "step-2:reasoning"]);
  assert.deepEqual(analysisUpdates.map(event => [event.payload.messageId, event.payload.stepId]), [
    ["step-1:reasoning", "step-1"], ["step-2:reasoning", "step-2"]
  ]);
  assert.ok(events.indexOf(analysisUpdates[0]) < events.findIndex(event => event.type === "model_step.finished"));
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

test("host shutdown aborts every active provider invocation before returning", async () => {
  const host = new AdapterHost();
  let aborted = 0;
  host.register({ metadata: { type: "slow", capabilities: [] }, async *invoke(req) {
    yield { type: "message.create", payload: {} };
    await new Promise((_, reject) => req.signal.addEventListener("abort", () => {
      aborted += 1;
      reject(new Error("aborted"));
    }, { once: true }));
  } });
  const invocations = ["shutdown-1", "shutdown-2"].map(invocationId => (async () => {
    const events = [];
    for await (const event of host.invoke("slow", { ...request, invocationId })) events.push(event);
    return events;
  })());
  await new Promise(resolve => setImmediate(resolve));

  await host.shutdown("parent disconnected");
  const results = await Promise.all(invocations);

  assert.equal(aborted, 2);
  assert.deepEqual(results.map(events => events.at(-1).type), ["run.stopped", "run.stopped"]);
});

test("separate adapter-host process loads manifest and streams events", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const processHost = await spawnAdapterHost({ entrypoint: `${root}/apps/adapter-host/dist/index.js`, manifest: `${root}/test/fixtures/adapters.json` });
  try {
    assert.equal(processHost.child.spawnargs[0], "octo-harness-adapter-host");
    assert.equal(processHost.adapters.some(item => item.type === "test"), true);
    assert.equal((await processHost.client.list()).some(item => item.type === "test"), true);
    const events = []; for await (const event of processHost.client.invoke("test", { ...request, invocationId: "rpc-inv" })) events.push(event);
    assert.equal(events.at(-1).type, "run.finished");
  } finally { await processHost.close(); }
});

test("RPC trace observes every client frame without changing the wire", async () => {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const host = new AdapterHost();
  const traced = [];
  new AdapterHostRpcServer({ host, output: serverToClient }).listen(clientToServer);
  const client = new AdapterHostRpcClient({
    input: serverToClient,
    output: clientToServer,
    trace: (direction, frame) => traced.push({ direction, frame })
  });

  assert.deepEqual(await client.list(), []);
  assert.deepEqual(traced.map(item => item.direction), ["send", "receive"]);
  assert.deepEqual(traced.map(item => JSON.parse(item.frame)), [
    { jsonrpc: "2.0", id: JSON.parse(traced[0].frame).id, method: "list", params: {} },
    { jsonrpc: "2.0", id: JSON.parse(traced[0].frame).id, result: [] }
  ]);
  client.close();
  clientToServer.end();
  serverToClient.end();
});

import { createHostInvoke as preparedTestInvoke } from "@mininglamp-oss/octo-runtime-protocol";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { PassThrough, Writable } from "node:stream";
import { AdapterHost, AdapterHostRpcClient, AdapterHostRpcServer, spawnAdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";
import { contextHash } from "@mininglamp-oss/octo-runtime-protocol";

const request = {
  protocolVersion: 2,
  invocationId: "inv-host",
  agentSessionId: "s",
  runId: "run_35c4ffc5db9940c9be7ce3a894819ae3",
  prompt: "p",
  modelInput: "p",
  workdir: process.cwd(),
  context: { schema: "octo.context-envelope/v3", items: [] },
  controlInstructions: "",
  approvalMode: "full_access",
  agentSource: "provisioned", agentConfig: {}
};

async function assertClosedRpcCalls(client, failure) {
  for (const call of [
    () => client.request("list"),
    () => client.list(),
    () => client.probe("fixture"),
    () => client.cancel("closed-invocation"),
    () => client.respondInteraction("closed-invocation", { interactionId: "closed-interaction", outcome: "accepted" }),
    () => preparedTestInvoke((...args) => client.invokeFrames(...args))("fixture", { ...request, invocationId: "closed-invocation" }, { protocolMode: "canonical" }).next()
  ]) {
    const result = await Promise.race([
      call().then(() => assert.fail("closed RPC call unexpectedly succeeded"), error => error),
      new Promise(resolve => setImmediate(() => resolve("RPC call remained pending after close")))
    ]);
    assert.equal(result, failure);
  }
}

test("host rejects missing mandatory invocation inputs and untyped context before dispatch", async () => {
  let invoked = false;
  const host = new AdapterHost();
  host.register({
    metadata: { protocolSupport: { protocol: ("contract") + '.canonical', modes: ['canonical'], nativeMethods: [] }, type: "contract", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access"] },
    async *invoke() {
      invoked = true;
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    }
  });
  for (const [field, reason] of [
    ["context", /CONTEXT_REQUIRED/],
    ["modelInput", /modelInput must be a non-empty string/],
    ["controlInstructions", /controlInstructions must be a string/],
    ["approvalMode", /APPROVAL_MODE_UNSUPPORTED/]
  ]) {
    const invalid = { ...request };
    delete invalid[field];
    await assert.rejects(async () => {
      for await (const event of preparedTestInvoke((...args) => host.invokeFrames(...args))("contract", invalid, { protocolMode: "canonical" })) assert.fail(`unexpected ${event.type}`);
    }, reason);
  }
  for (const context of [{}, { profile: "work", runtimeId: "runtime-work" }]) {
    await assert.rejects(async () => {
      for await (const event of preparedTestInvoke((...args) => host.invokeFrames(...args))("contract", { ...request, context }, { protocolMode: "canonical" })) assert.fail(`unexpected ${event.type}`);
    }, /CONTEXT_SCHEMA_INVALID|CONTEXT_UNKNOWN_FIELD/);
  }
  assert.equal(invoked, false);
});

test("host rejects legacy prompt, permission and reasoning contracts before dispatch", async () => {
  let invoked = false;
  const host = new AdapterHost();
  host.register({
    metadata: { protocolSupport: { protocol: ("legacy") + '.canonical', modes: ['canonical'], nativeMethods: [] }, type: "legacy", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access"] },
    async *invoke() {
      invoked = true;
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    }
  });
  for (const [overrides, reason] of [
    [{ appendInstructions: "legacy control" }, /LEGACY_RUN_CONTRACT_REJECTED/],
    [{ agentSource: "provisioned", agentConfig: { permissionMode: "bypassPermissions" } }, /LEGACY_PERMISSION_CONFIG_REJECTED/],
    [{ agentSource: "provisioned", agentConfig: { autoApprove: true } }, /LEGACY_PERMISSION_CONFIG_REJECTED/],
    [{ agentSource: "provisioned", agentConfig: { autoApprove: false } }, /LEGACY_PERMISSION_CONFIG_REJECTED/],
    [{ agentSource: "provisioned", agentConfig: { dangerouslyBypassPermissions: true } }, /LEGACY_PERMISSION_CONFIG_REJECTED/],
    [{ agentSource: "provisioned", agentConfig: { thinking: true } }, /LEGACY_REASONING_CONFIG_REJECTED/],
    [{ agentSource: "provisioned", agentConfig: { thinking: false } }, /LEGACY_REASONING_CONFIG_REJECTED/],
    [{ agentSource: "provisioned", agentConfig: { thinking: "high", effort: "high" } }, /LEGACY_REASONING_CONFIG_REJECTED/]
  ]) {
    await assert.rejects(async () => {
      for await (const event of preparedTestInvoke((...args) => host.invokeFrames(...args))("legacy", { ...request, ...overrides }, { protocolMode: "canonical" })) assert.fail(`unexpected ${event.type}`);
    }, reason);
  }
  assert.equal(invoked, false);
});

test("host requires both declared interaction capability and a responder for ask and assisted", async () => {
  let invoked = false;
  let responded = false;
  const host = new AdapterHost();
  for (const [type, capabilities, responder] of [
    ["neither", [], false],
    ["declaration-only", ["interaction.response"], false],
    ["responder-only", [], true]
  ]) {
    host.register({
      metadata: { protocolSupport: { protocol: (type) + '.canonical', modes: ['canonical'], nativeMethods: [] }, type, capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: [...capabilities, "approval.ask", "approval.assisted", "approval.full_access"] },
      async *invoke() {
        invoked = true;
        yield { protocolVersion: 2, type: "run.completed", payload: {} };
      },
      ...(responder ? { async respondInteraction() { responded = true; } } : {})
    });
    for (const approvalMode of ["ask", "assisted"]) {
      await assert.rejects(async () => {
        for await (const event of preparedTestInvoke((...args) => host.invokeFrames(...args))(type, { ...request, approvalMode }, { protocolMode: "canonical" })) assert.fail(`unexpected ${event.type}`);
      }, /APPROVAL_MODE_UNSUPPORTED/);
    }
  }
  assert.equal(invoked, false);
  assert.equal(responded, false);
});

test("host holds terminal until adapter stream cleanup succeeds", async () => {
  const host = new AdapterHost();
  host.register({ metadata: { protocolSupport: { protocol: ("bad") + '.canonical', modes: ['canonical'], nativeMethods: [] }, type: "bad", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access"] }, async *invoke() { yield { protocolVersion: 2, type: "run.completed", payload: {} }; throw new Error("cleanup failed"); } });
  const events = []; for await (const event of preparedTestInvoke((...args) => host.invokeFrames(...args))("bad", request, { protocolMode: "canonical" })) { if (!event.type.startsWith("activity.")) events.push(event); };
  assert.deepEqual(events.map(x => x.type), ["run.failed"]);
  assert.equal(events[0].payload.failure.code, "OH-ADP-3004");
  assert.equal(events[0].payload.failure.stage, "adapter.invoke");
  assert.doesNotMatch(JSON.stringify(events[0]), /cleanup failed/);
});

test("host reports failure when adapter exits without terminal", async () => {
  const host = new AdapterHost();
  host.register({ metadata: { protocolSupport: { protocol: ("short") + '.canonical', modes: ['canonical'], nativeMethods: [] }, type: "short", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access"] }, async *invoke() { yield { protocolVersion: 2, type: "message.create", payload: {} }; } });
  const events = []; for await (const event of preparedTestInvoke((...args) => host.invokeFrames(...args))("short", request, { protocolMode: "canonical" })) { if (!event.type.startsWith("activity.")) events.push(event); };
  assert.equal(events.at(-1).type, "run.failed");
});

test("host classifies and redacts adapter-provided provider failures", async () => {
  const host = new AdapterHost();
  host.register({
    metadata: { protocolSupport: { protocol: ("provider-fixture") + '.canonical', modes: ['canonical'], nativeMethods: [] }, type: "provider-fixture", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access"] },
    async *invoke() {
      yield { protocolVersion: 2,
        type: "run.failed",
        payload: {
          code: "invalid_api_key",
          message: "Authorization: Bearer provider-secret",
          providerError: { status: 401, token: "provider-secret" }
        }
      };
    }
  });

  const events = [];
  for await (const event of preparedTestInvoke((...args) => host.invokeFrames(...args))("provider-fixture", request, { protocolMode: "canonical" })) { if (!event.type.startsWith("activity.")) events.push(event); };
  assert.equal(events.at(-1).payload.failure.reasonCode, "PROVIDER_HTTP_401");
  assert.equal(events.at(-1).payload.failure.code, "OH-PRV-4001");
  assert.equal(events.at(-1).payload.failure.source.adapter, "provider-fixture");
  assert.doesNotMatch(JSON.stringify(events), /provider-secret|Authorization|providerError/);
});

test("host normalizes unclassified analysis to an explicit fail-closed exposure", async () => {
  const host = new AdapterHost();
  host.register({
    metadata: { protocolSupport: { protocol: ("legacy") + '.canonical', modes: ['canonical'], nativeMethods: [] }, type: "legacy", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access"] },
    async *invoke() {
      yield { protocolVersion: 2, type: "message.delta", payload: { channel: "analysis", text: "internal" } };
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    }
  });
  const events = [];
  for await (const event of preparedTestInvoke((...args) => host.invokeFrames(...args))("legacy", request, { protocolMode: "canonical" })) { if (!event.type.startsWith("activity.")) events.push(event); };
  const analysis = events.filter(event => event.type.startsWith("message."));
  assert.equal(analysis.length, 0);
  for (const event of analysis) {
    assert.equal(event.payload.exposure, "unknown");
    assert.deepEqual(event.payload.provenance, { provider: "legacy", nativeEvent: "unknown" });
  }
});

test("host keeps step-scoped analysis messages separate and closes each round", async () => {
  const host = new AdapterHost();
  host.register({
    metadata: { protocolSupport: { protocol: ("steps") + '.canonical', modes: ['canonical'], nativeMethods: [] }, type: "steps", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access"] },
    async *invoke() {
      for (const stepId of ["step-1", "step-2"]) {
        yield { protocolVersion: 2, type: "model_step.started", payload: { stepId } };
        yield { protocolVersion: 2,
          type: "message.delta",
          payload: {
            channel: "analysis", messageId: `${stepId}:reasoning`, stepId, text: `${stepId} thought`,
            exposure: "public_reasoning", provenance: { provider: "steps", nativeEvent: "reasoning" }
          }
        };
        yield { protocolVersion: 2, type: "model_step.finished", payload: { stepId, status: "completed", finishReason: stepId === "step-1" ? "tool-calls" : "stop" } };
      }
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    }
  });
  const events = [];
  for await (const event of preparedTestInvoke((...args) => host.invokeFrames(...args))("steps", request, { protocolMode: "canonical" })) { if (!event.type.startsWith("activity.")) events.push(event); };
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
  host.register({ metadata: { protocolSupport: { protocol: ("slow") + '.canonical', modes: ['canonical'], nativeMethods: [] }, type: "slow", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access"] }, async *invoke(req) {
    yield { protocolVersion: 2, type: "message.create", payload: {} };
    await new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  } });
  const events = [];
  const consume = (async () => { for await (const event of preparedTestInvoke((...args) => host.invokeFrames(...args))("slow", { ...request, invocationId: "cancel-me" }, { protocolMode: "canonical" })) { if (!event.type.startsWith("activity.")) events.push(event); }; })();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.cancel("cancel-me", "test_cancel"), true);
  await consume;
  assert.equal(events.at(-1).type, "run.cancelled");
  assert.equal(events.filter(item => item.type.startsWith("run.")).length, 1);
});

test("host watchdog fails a provider that never emits its first protocol frame", async () => {
  const host = new AdapterHost();
  host.register({
    metadata: { protocolSupport: { protocol: ("silent-start") + '.canonical', modes: ['canonical'], nativeMethods: [] }, type: "silent-start", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access"] },
    async *invoke() { await new Promise(() => {}); }
  });
  const events = [];
  for await (const event of preparedTestInvoke((...args) => host.invokeFrames(...args))("silent-start", {
    ...request,
    invocationId: "watchdog-start",
    runtimeLimits: {
      firstFrameTimeoutMs: 100,
      modelIdleTimeoutMs: 10_000,
      toolTimeoutMs: 10_000,
      runTimeoutMs: 10_000,
      cancelGraceMs: 100,
      enforcement: "enforce"
    }
  }, { protocolMode: "canonical" })) { if (!event.type.startsWith("activity.")) events.push(event); };
  assert.equal(events.at(-1).type, "run.failed");
  assert.equal(events.at(-1).payload.failure.reasonCode, "ADAPTER_FIRST_FRAME_TIMEOUT");
  assert.equal(events.at(-1).payload.failure.code, "OH-ADP-3007");
  assert.equal(events.at(-1).payload.failure.stage, "adapter.invoke");
  assert.equal(events.at(-1).payload.failure.diagnosticId, "diag_35c4ffc5db9940c9be7ce3a894819ae3");
  const params = events.at(-1).payload.failure.params;
  assert.equal(params.timeoutStage, "starting");
  assert.equal(params.timeoutMs, 100);
  assert.equal(params.timeoutReason, "first_frame");
  assert.equal(params.configParameter, "execution_profile.runtime_limits.first_frame_timeout_ms");
});

test("host watchdog uses the tool budget while a canonical tool call is open", async () => {
  const host = new AdapterHost();
  host.register({
    metadata: { protocolSupport: { protocol: ("silent-tool") + '.canonical', modes: ['canonical'], nativeMethods: [] }, type: "silent-tool", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access"] },
    async *invoke() {
      yield { protocolVersion: 2, type: "model_step.started", payload: { stepId: "step-1" } };
      yield { protocolVersion: 2, type: "tool_call.create", payload: { id: "tool-1", name: "exec", args: {}, status: "running" } };
      await new Promise(() => {});
    }
  });
  const events = [];
  for await (const event of preparedTestInvoke((...args) => host.invokeFrames(...args))("silent-tool", {
    ...request,
    invocationId: "watchdog-tool",
    runtimeLimits: {
      firstFrameTimeoutMs: 1_000,
      modelIdleTimeoutMs: 10_000,
      toolTimeoutMs: 100,
      runTimeoutMs: 10_000,
      cancelGraceMs: 100,
      enforcement: "enforce"
    }
  }, { protocolMode: "canonical" })) { if (!event.type.startsWith("activity.")) events.push(event); };
  assert.deepEqual(events.slice(0, 2).map(event => event.type), ["model_step.started", "tool_call.create"]);
  assert.equal(events.at(-1).type, "run.failed");
  assert.equal(events.at(-1).payload.failure.reasonCode, "ADAPTER_TOOL_IDLE_TIMEOUT");
  assert.equal(events.at(-1).payload.failure.code, "OH-ADP-3009");
  const params = events.at(-1).payload.failure.params;
  assert.equal(params.timeoutStage, "tool_active");
  assert.equal(params.timeoutMs, 100);
  assert.equal(params.timeoutReason, "tool_idle");
});

test("host shutdown aborts every active provider invocation before returning", async () => {
  const host = new AdapterHost();
  let aborted = 0;
  host.register({ metadata: { protocolSupport: { protocol: ("slow") + '.canonical', modes: ['canonical'], nativeMethods: [] }, type: "slow", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access"] }, async *invoke(req) {
    yield { protocolVersion: 2, type: "message.create", payload: {} };
    await new Promise((_, reject) => req.signal.addEventListener("abort", () => {
      aborted += 1;
      reject(new Error("aborted"));
    }, { once: true }));
  } });
  const invocations = ["shutdown-1", "shutdown-2"].map(invocationId => (async () => {
    const events = [];
    for await (const event of preparedTestInvoke((...args) => host.invokeFrames(...args))("slow", { ...request, invocationId, runId: invocationId }, { protocolMode: "canonical" })) { if (!event.type.startsWith("activity.")) events.push(event); };
    return events;
  })());
  await new Promise(resolve => setImmediate(resolve));

  await host.shutdown("parent disconnected");
  const results = await Promise.all(invocations);

  assert.equal(aborted, 2);
  assert.deepEqual(results.map(events => events.at(-1).type), ["run.cancelled", "run.cancelled"]);
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

test("RPC failed Writable callback rejects pending calls and invoke ACK without an unhandled error", { timeout: 5_000 }, async testContext => {
  const input = new PassThrough();
  let failWrite;
  const output = new Writable({ write(_chunk, _encoding, callback) { failWrite = callback; } });
  const frames = [];
  const client = new AdapterHostRpcClient({ input, output, trace: (_direction, frame) => frames.push(JSON.parse(frame)) });
  testContext.after(() => { client.close(); input.destroy(); output.destroy(); });
  assert.equal(output.listenerCount("error"), 1);
  const failure = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  const rejectedCall = assert.rejects(client.list(), error => error === failure);
  const iterator = preparedTestInvoke((...args) => client.invokeFrames(...args))("fixture", { ...request, invocationId: "pending-ack" }, { protocolMode: "canonical" });
  const rejectedInvoke = assert.rejects(iterator.next(), error => error === failure);
  assert.deepEqual(frames.map(frame => frame.method), ["list", "invoke"]);
  failWrite(failure);
  await Promise.all([rejectedCall, rejectedInvoke]);
  await new Promise(resolve => setImmediate(resolve));
  client.close(new Error("later close must not replace the write failure"));
  await assertClosedRpcCalls(client, failure);
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  assert.deepEqual(frames.map(frame => frame.method), ["list", "invoke"]);
});

test("RPC failed Writable callback rejects an acknowledged invocation waiting for its next event", { timeout: 5_000 }, async testContext => {
  const input = new PassThrough();
  let failWrite;
  const output = new Writable({ write(chunk, _encoding, callback) {
    if (JSON.parse(chunk.toString()).method === "invoke") callback();
    else failWrite = callback;
  } });
  const frames = [];
  const client = new AdapterHostRpcClient({ input, output, trace: (_direction, frame) => frames.push(JSON.parse(frame)) });
  testContext.after(() => { client.close(); input.destroy(); output.destroy(); });
  const failure = Object.assign(new Error("write EPIPE after invoke ACK"), { code: "EPIPE" });
  const iterator = preparedTestInvoke((...args) => client.invokeFrames(...args))("fixture", { ...request, invocationId: "acknowledged-invoke" }, { protocolMode: "canonical" });
  const rejectedInvoke = assert.rejects(iterator.next(), error => error === failure);
  const acknowledgement = { jsonrpc: "2.0", id: frames[0].id, result: { run_id: request.runId, invocation_id: "acknowledged-invoke", stream_id: "host:fixture", agent_session_id: request.agentSessionId, session_generation: 0, protocol_mode: "canonical", protocol: "fixture.canonical" } };
  input.write(`${JSON.stringify(acknowledgement)}\n`);
  await new Promise(resolve => setImmediate(resolve));
  const rejectedCall = assert.rejects(client.list(), error => error === failure);
  assert.equal(typeof failWrite, "function");
  failWrite(failure);
  await Promise.all([rejectedCall, rejectedInvoke]);
  await new Promise(resolve => setImmediate(resolve));
  const sentFrames = frames.filter(frame => frame.method);
  assert.deepEqual(sentFrames.map(frame => frame.method), ["invoke", "list"]);
  await assertClosedRpcCalls(client, failure);
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  assert.equal(frames.filter(frame => frame.method).length, sentFrames.length);
});

test("RPC output error closes pending calls and invocations even when write callbacks succeeded", { timeout: 5_000 }, async testContext => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const frames = [];
  const client = new AdapterHostRpcClient({ input, output, trace: (_direction, frame) => frames.push(JSON.parse(frame)) });
  testContext.after(() => { client.close(); input.destroy(); output.destroy(); });
  assert.equal(output.listenerCount("error"), 1);
  const failure = Object.assign(new Error("output EPIPE"), { code: "EPIPE" });
  const rejectedCall = assert.rejects(client.list(), error => error === failure);
  const iterator = preparedTestInvoke((...args) => client.invokeFrames(...args))("fixture", { ...request, invocationId: "output-error-invoke" }, { protocolMode: "canonical" });
  const rejectedInvoke = assert.rejects(iterator.next(), error => error === failure);
  output.emit("error", failure);
  await Promise.all([rejectedCall, rejectedInvoke]);
  await assertClosedRpcCalls(client, failure);
  assert.deepEqual(frames.map(frame => frame.method), ["list", "invoke"]);
});

test("RPC synchronous Writable throw rejects all pending work and later calls without another write", { timeout: 5_000 }, async testContext => {
  const input = new PassThrough();
  const failure = Object.assign(new Error("synchronous write EPIPE"), { code: "EPIPE" });
  const output = new Writable({ write(chunk, _encoding, callback) {
    if (JSON.parse(chunk.toString()).method === "invoke") throw failure;
    callback();
  } });
  const frames = [];
  const client = new AdapterHostRpcClient({ input, output, trace: (_direction, frame) => frames.push(JSON.parse(frame)) });
  testContext.after(() => { client.close(); input.destroy(); output.destroy(); });
  const rejectedCall = assert.rejects(client.list(), error => error === failure);
  const iterator = preparedTestInvoke((...args) => client.invokeFrames(...args))("fixture", { ...request, invocationId: "synchronous-error-invoke" }, { protocolMode: "canonical" });
  const rejectedInvoke = assert.rejects(iterator.next(), error => error === failure);
  await Promise.all([rejectedCall, rejectedInvoke]);
  await new Promise(resolve => setImmediate(resolve));
  await assertClosedRpcCalls(client, failure);
  assert.deepEqual(frames.map(frame => frame.method), ["list", "invoke"]);
});

test("RPC server closes active providers when its output fails", { timeout: 5_000 }, async testContext => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const host = new AdapterHost();
  let started;
  const providerStarted = new Promise(resolve => { started = resolve; });
  let aborted;
  const providerAborted = new Promise(resolve => { aborted = resolve; });
  host.register({
    metadata: { protocolSupport: { protocol: ("broken-output") + '.canonical', modes: ['canonical'], nativeMethods: [] }, type: "broken-output", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access"] },
    async *invoke(invoke) {
      started();
      await new Promise(resolve => invoke.signal.addEventListener("abort", () => { aborted(); resolve(); }, { once: true }));
      yield { protocolVersion: 2, type: "run.cancelled", payload: {} };
    }
  });
  const frames = [];
  new AdapterHostRpcServer({ host, output, trace: (_direction, frame) => frames.push(JSON.parse(frame)) }).listen(input);
  testContext.after(async () => { input.destroy(); output.destroy(); await host.shutdown(); });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "invoke-1", method: "invoke", params: { adapterType: "broken-output", request, options: { protocol_mode: "canonical" } } })}\n`);
  await providerStarted;
  output.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  await providerAborted;
  await host.shutdown();
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "list-1", method: "list" })}\n`);
  assert.equal(frames.filter(frame => frame.jsonrpc === "2.0" && frame.id === "list-1").length, 0);
});

test("RPC interaction responses resume the same active ask invocation", { timeout: 5_000 }, async testContext => {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const host = new AdapterHost();
  let resume;
  const response = new Promise(resolve => { resume = resolve; });
  host.register({
    metadata: { protocolSupport: { protocol: ("interactive") + '.canonical', modes: ['canonical'], nativeMethods: [] }, type: "interactive", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access", "interaction.response"] },
    async *invoke(invocation) {
      yield { protocolVersion: 2,
        type: "interaction.requested",
        payload: {
          interactionId: "approval-1",
          kind: "approval",
          executionInstanceId: invocation.invocationId,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          request: {
            schema: "octo.approval-request/v1",
            policy: { mode: invocation.approvalMode, hash: contextHash(invocation.context) },
            operation: { kind: "tool_execution", summary: "Proceed?" },
            requestedPermissions: [],
            allowedOutcomes: ["accepted", "declined", "cancelled"],
            grantScope: "request"
          }
        }
      };
      const answer = await response;
      yield { protocolVersion: 2, type: "interaction.resolved", payload: {
        interactionId: answer.interactionId, executionInstanceId: invocation.invocationId,
        status: "resolved", outcome: answer.outcome
      } };
      yield { protocolVersion: 2, type: "message.create", payload: { channel: "final", text: answer.outcome } };
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    },
    async respondInteraction(invocationId, answer) {
      assert.equal(invocationId, "rpc-interactive");
      resume(answer);
    }
  });
  new AdapterHostRpcServer({ host, output: serverToClient }).listen(clientToServer);
  const client = new AdapterHostRpcClient({ input: serverToClient, output: clientToServer });
  testContext.after(() => {
    client.close();
    clientToServer.end();
    serverToClient.end();
  });

  const iterator = preparedTestInvoke((...args) => client.invokeFrames(...args))("interactive", { ...request, invocationId: "rpc-interactive", approvalMode: "ask" }, { protocolMode: "canonical" });
  let interaction;
  while (!interaction) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    if (next.value.type === "interaction.requested") interaction = next.value;
  }
  assert.equal(interaction.payload.request.policy.mode, "ask");
  assert.equal(interaction.payload.executionInstanceId, "rpc-interactive");
  await assert.rejects(
    client.respondInteraction("wrong-invocation", { interactionId: "approval-1", outcome: "accepted" }),
    /invocation is not active/
  );
  await client.respondInteraction("rpc-interactive", { interactionId: "approval-1", outcome: "accepted" });
  const remaining = [];
  for await (const event of iterator) { if (!event.type.startsWith("activity.")) remaining.push(event); };
  assert.deepEqual(remaining.map(event => event.type), ["interaction.resolved", "message.create", "message.update", "run.completed"]);
  assert.deepEqual(remaining[0].payload, {
    interactionId: "approval-1", executionInstanceId: "rpc-interactive", status: "resolved", outcome: "accepted"
  });
  assert.equal(remaining[1].payload.text, "accepted");
});

test("RPC keeps AbortSignal local and cancels both pending ACK and active streams", async t => {
  for (const acknowledged of [false, true]) {
    const input = new PassThrough();
    const frames = [];
    const output = new Writable({ write(chunk, _encoding, callback) { frames.push(JSON.parse(chunk.toString())); callback(); } });
    const client = new AdapterHostRpcClient({ input, output });
    t.after(() => { client.close(); input.destroy(); output.destroy(); });
    const controller = new AbortController();
    const reason = new Error("shared run deadline");
    const iterator = preparedTestInvoke((...args) => client.invokeFrames(...args))("fixture", { ...request, invocationId: "abort-" + acknowledged, signal: controller.signal }, { protocolMode: "canonical" });
    const pending = iterator.next();
    assert.equal(Object.hasOwn(frames[0].params.request, "signal"), false);
    if (acknowledged) {
      input.write(JSON.stringify({ jsonrpc: "2.0", id: frames[0].id, result: { run_id: request.runId, invocation_id: "abort-" + acknowledged, stream_id: "host:fixture", agent_session_id: request.agentSessionId, session_generation: 0, protocol_mode: "canonical", protocol: "fixture.canonical" } }) + "\n");
      await new Promise(resolve => setImmediate(resolve));
    }
    controller.abort(reason);
    await assert.rejects(pending, error => error === reason);
    const cancellation = frames.find(frame => frame.method === "cancel");
    assert.equal(cancellation.params.invocationId, "abort-" + acknowledged);
    input.write(JSON.stringify({ jsonrpc: "2.0", id: cancellation.id, result: { cancelled: true } }) + "\n");
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  }
});

test("pre-aborted RPC invocation sends no Provider command", async t => {
  const input = new PassThrough(); const frames = [];
  const output = new Writable({ write(chunk, _encoding, callback) { frames.push(JSON.parse(chunk.toString())); callback(); } });
  const client = new AdapterHostRpcClient({ input, output });
  t.after(() => { client.close(); input.destroy(); output.destroy(); });
  const controller = new AbortController(); controller.abort(new Error("cancelled before dispatch"));
  await assert.rejects(preparedTestInvoke((...args) => client.invokeFrames(...args))("fixture", { ...request, signal: controller.signal }, { protocolMode: "canonical" }).next(), /cancelled before dispatch/);
  assert.deepEqual(frames, []);
});

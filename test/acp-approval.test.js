import { preparedFrames } from "./runtime-fixture.js";
import { preparedTestInvoke } from "./runtime-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { AcpApprovalBridge } from "../packages/octo-runtime-adapter-sdk/dist/index.js";

const request = { protocolVersion: 2, invocationId: "instance-1", agentSessionId: "session-1", runId: "run-1", prompt: "hello", modelInput: "hello", controlInstructions: "", approvalMode: "ask", context: { schema: "octo.context-envelope/v3", items: [] }, agentSource: "provisioned", agentConfig: {}, workdir: "/tmp" };
const permission = { toolCall: { toolCallId: "tool-1", title: "Read a file" }, options: [{ kind: "allow_once", optionId: "allow" }, { kind: "reject_once", optionId: "deny" }, { kind: "allow_always", optionId: "always" }] };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("ACP human approval answers the original request and resolves only after transport write", { timeout: 2000 }, async () => {
  const bridge = new AcpApprovalBridge(request);
  const native = deferred();
  const finish = deferred();
  let closed = false;
  bridge.bindTransport(async () => { closed = true; finish.resolve(); });
  const stream = bridge.stream((async function* () {
    native.resolve(await bridge.requestPermission(permission));
    await finish.promise;
    yield { protocolVersion: 2, type: "run.completed", payload: {} };
  })());
  const first = await stream.next();
  assert.equal(first.value.type, "interaction.requested");
  assert.equal(first.value.payload.executionInstanceId, "instance-1");
  assert.equal(first.value.payload.request.grantScope, "request");
  let delivered = false;
  const responding = bridge.respond({ interactionId: first.value.payload.interactionId, outcome: "accepted" }).then(() => { delivered = true; });
  assert.deepEqual(await native.promise, { outcome: { outcome: "selected", optionId: "allow" } });
  assert.equal(delivered, false);
  await assert.rejects(bridge.respond({ interactionId: first.value.payload.interactionId, outcome: "accepted" }), /INTERACTION_NOT_ACTIVE/);
  bridge.responseWritten(permission);
  await responding;
  assert.equal((await stream.next()).value.type, "interaction.resolved");
  finish.resolve();
  assert.equal((await stream.next()).value.type, "run.completed");
  assert.equal((await stream.next()).done, true);
  assert.equal(closed, true);
  await assert.rejects(bridge.requestPermission(permission), /APPROVAL_WAIT_UNAVAILABLE/);
});

test("ACP expiry cancels transport before waiting for a blocked source cleanup", { timeout: 2000 }, async () => {
  const bridge = new AcpApprovalBridge(request, 20);
  const blocked = deferred();
  let closed = false;
  let cleaned = false;
  const pending = bridge.requestPermission(permission);
  void pending.catch(() => undefined);
  bridge.bindTransport(async () => { closed = true; blocked.resolve(); });
  const stream = bridge.stream((async function* () {
    try { await blocked.promise; } finally { cleaned = true; }
  })());
  assert.equal((await stream.next()).value.type, "interaction.requested");
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const expired = await stream.next();
    assert.equal(expired.value.type, "interaction.resolved");
    assert.equal(expired.value.payload.status, "expired");
    await assert.rejects(stream.next(), /APPROVAL_EXPIRED/);
    assert.equal(closed, true);
    assert.equal(cleaned, true);
  } finally { clearTimeout(keepAlive); }
});

test("ACP response delivery failure invalidates without reporting approval success", { timeout: 2000 }, async () => {
  const bridge = new AcpApprovalBridge(request);
  const permissionResult = bridge.requestPermission(permission);
  bridge.bindTransport(async () => {});
  const response = bridge.respond({ interactionId: (await bridge.stream((async function* () {})()).next()).value.payload.interactionId, outcome: "accepted" });
  assert.deepEqual(await permissionResult, { outcome: { outcome: "selected", optionId: "allow" } });
  bridge.responseFailed(permission, new Error("broken pipe"));
  await assert.rejects(response, /broken pipe/);
});

test("full access never grants an allow-always option when allow-once is unavailable", async () => {
  const bridge = new AcpApprovalBridge({ ...request, approvalMode: "full_access" });
  assert.deepEqual(await bridge.requestPermission(permission), { outcome: { outcome: "selected", optionId: "allow" } });
  assert.deepEqual(await bridge.requestPermission({ options: [{ kind: "allow_always", optionId: "always" }] }), { outcome: { outcome: "cancelled" } });
  bridge.close("run_terminal");
});

test("Host rejects interactive approval with no response implementation", async () => {
  const { AdapterHost } = await import("@mininglamp-oss/octo-runtime-adapter-host");
  const host = new AdapterHost();
  let started = false;
  host.register({ metadata: { protocolSupport: { protocol: ("broken") + '.canonical', modes: ['canonical'], nativeMethods: [] }, type: "broken", agentSources: ["provisioned"], executionFeatures: [] }, async *invoke() { started = true; yield { protocolVersion: 2, type: "run.completed", payload: {} }; } });
  await assert.rejects(async () => { for await (const event of preparedTestInvoke((...args) => preparedFrames(host, ...args))("broken", request, { protocolMode: "canonical" })) assert.fail(event.type); }, /APPROVAL_MODE_UNSUPPORTED/);
  assert.equal(started, false);
});

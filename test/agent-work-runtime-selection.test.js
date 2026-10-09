import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { AgentWorkRuntime, AgentWorkStore } from "../packages/octo-harness-daemon/dist/index.js";
import { RUNTIME_RUN_CONTRACT } from "../packages/octo-harness-protocol/dist/index.js";
import { contextEnvelope, continuityItem, deferred, executionContext, resolvedRuntimeSelection, waitFor, wire, withTimeout } from "./agent-work-runtime-fixture.js";

const runtimeId = "本机 Runtime/🎯";
const plan = { agent_source: "provisioned", adapter_type: "fake", workdir: process.cwd(), approval_mode: "ask" };

function executionEnvelope(selection = resolvedRuntimeSelection(runtimeId)) {
  return {
    schema_version: 6,
    context_configuration_version: 1,
    effective_context: executionContext(plan),
    resolved_execution_plan: plan,
    resolved_runtime_selection: selection,
    run_id: "run-selection",
    agent_session_id: "session-selection",
    agent_revision: {},
    agent_run_request: {
      context: contextEnvelope(), namespace: "test", agent_id: "agent-1", agent_revision_id: "revision-1",
      session_key: "selection-test", trigger: { kind: "test", occurrence_id: "test/selection" },
      input: { prompt: "Target this Runtime only." }
    }
  };
}

const boundPool = {
  ...resolvedRuntimeSelection(runtimeId), selection_mode: "candidates",
  failover: "candidates",
  authorized_candidates: [
    { runtime_id: "other-runtime", priority: 1, owner_subject_type: "teamspace", owner_subject_id: "space-1" },
    { runtime_id: runtimeId, priority: 2, owner_subject_type: "user", owner_subject_id: "user-1" }
  ]
};
delete boundPool.explicit_runtime_id;

for (const scenario of [
  { name: "schema 2", error: "LEGACY_RUN_CONTRACT_REJECTED", modify: envelope => { envelope.schema_version = 2; delete envelope.resolved_runtime_selection; } },
  { name: "missing selection", error: "RESOLVED_RUNTIME_SELECTION_REQUIRED", modify: envelope => { delete envelope.resolved_runtime_selection; } },
  { name: "unknown routing field", error: "RESOLVED_RUNTIME_SELECTION_INVALID", modify: envelope => { envelope.resolved_runtime_selection.target_runtime_id = runtimeId; } },
  { name: "explicit foreign target", error: "RUNTIME_SELECTION_TARGET_MISMATCH", modify: envelope => { envelope.resolved_runtime_selection = resolvedRuntimeSelection("foreign-runtime"); } },
  { name: "explicit inconsistent candidate", error: "RESOLVED_RUNTIME_SELECTION_INVALID", modify: envelope => { envelope.resolved_runtime_selection.explicit_runtime_id = "foreign-runtime"; } },
  { name: "bound pool excludes local Runtime", error: "RUNTIME_SELECTION_TARGET_MISMATCH", modify: envelope => { envelope.resolved_runtime_selection = structuredClone(boundPool); envelope.resolved_runtime_selection.authorized_candidates[1].runtime_id = "another-runtime"; } },
  { name: "effective Context target disagrees", error: "RUNTIME_SELECTION_CONTEXT_MISMATCH", modify: envelope => { envelope.effective_context.items.find(item => item.name === "config").payload.runtime = { mode: "explicit", runtime_id: "foreign-runtime" }; } }
]) {
  test(`daemon rejects ${scenario.name} before context sync or invocation and persists replay rejection`, { timeout: 5_000 }, async () => {
    const payload = executionEnvelope();
    payload.internal_context = { continuity: continuityItem().payload };
    scenario.modify(payload);
    const fixture = await startFixture();
    try {
      await fixture.runtime.start();
      await withTimeout(fixture.ready.promise, 2_000, "runtime hello timeout");
      const command = { server_seq: 1, command_id: "command-selection", run_id: payload.run_id, type: "run.start", payload, lease_id: "lease-1", fencing_token: 1 };
      fixture.socket.send(wire("runtime.command", command));
      await waitFor(() => fixture.receipts.length === 1);
      assert.equal(fixture.receipts[0].accepted, false);
      assert.equal(fixture.receipts[0].error.code, "INVALID_EXECUTION_ENVELOPE");
      assert.equal(fixture.receipts[0].error.message, scenario.error);
      fixture.socket.send(wire("runtime.command", command));
      await waitFor(() => fixture.receipts.length === 2);
      assert.deepEqual(fixture.receipts[1], fixture.receipts[0]);
      assert.equal(fixture.contextSyncs, 0);
      assert.equal(fixture.invocations.length, 0);
      await fixture.runtime.close();
      const store = AgentWorkStore.open(fixture.storePath);
      try {
        const persisted = store.getCommandReceipt(command.command_id);
        assert.equal(persisted.accepted, false);
        assert.equal(persisted.error.message, scenario.error);
        assert.deepEqual(store.activeRunIds(), []);
      } finally {
        store.close();
      }
    } finally {
      await fixture.close();
    }
  });
}

for (const [name, selection] of [["explicit Unicode target", resolvedRuntimeSelection(runtimeId)], ["non-primary authorized bound candidate", boundPool]]) {
  test(`daemon accepts ${name} after schema 3 pre-registration`, { timeout: 5_000 }, async () => {
    const fixture = await startFixture();
    try {
      await fixture.runtime.start();
      await withTimeout(fixture.ready.promise, 2_000, "runtime hello timeout");
      fixture.socket.send(wire("runtime.command", {
        server_seq: 1, command_id: "command-selection", run_id: "run-selection", type: "run.start",
        payload: executionEnvelope(selection), lease_id: "lease-1", fencing_token: 1
      }));
      await waitFor(() => fixture.receipts.length === 1 && fixture.invocations.length === 1);
      assert.equal(fixture.receipts[0].accepted, true);
      assert.equal(fixture.registrations, 1);
      assert.equal(fixture.invocations[0].runMetadata.runtimeId, runtimeId);
      assert.equal(fixture.invocations[0].runMetadata.schemaVersion, 6);
    } finally {
      await fixture.close();
    }
  });
}

test("daemon schema 3 registration rejection cannot connect or execute with a configured Runtime ID", { timeout: 5_000 }, async () => {
  const fixture = await startFixture({ rejectRegistration: true });
  try {
    await fixture.runtime.start();
    assert.equal(fixture.registrations, 1);
    assert.equal(fixture.upgrades, 0);
    assert.equal(fixture.runtime.status.connected, false);
    assert.equal(fixture.invocations.length, 0);
  } finally {
    await fixture.close();
  }
});

test("OpenClaw availability refresh preserves the device connection and other adapters", async () => {
  const state = { available: false, reason: "config_not_found" };
  const fixture = await startFixture({ openClawProbeState: state });
  try {
    await fixture.runtime.start();
    await fixture.ready.promise;
    state.available = true;
    await waitFor(() => fixture.lastCapabilities.adapters.find(a => a.provider_type === "openclaw")?.available === true);
    state.available = false;
    state.reason = "gateway_unreachable";
    await waitFor(() => fixture.lastCapabilities.adapters.find(a => a.provider_type === "openclaw")?.unavailable_reason === "gateway_unreachable");
    assert.equal(fixture.runtime.status.connected, true);
    assert.equal(fixture.runtime.status.connectionState, "online");
    assert.equal(fixture.upgrades, 1);
    assert.equal(fixture.lastCapabilities.adapters.find(a => a.provider_type === "fake").available, true);
  } finally { await fixture.close(); }
});

async function startFixture({ rejectRegistration = false, openClawProbeState } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "oh-runtime-selection-"));
  const storePath = join(directory, "agent-work.db");
  const server = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const ready = deferred();
  const fixture = { storePath, ready, registrations: 0, upgrades: 0, contextSyncs: 0, receipts: [], invocations: [], socket: undefined };
  server.on("request", async (request, response) => {
    if (request.url === "/v1/runtime/context/prepare") { request.resume(); response.writeHead(200); response.end("{}"); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    const registration = JSON.parse(body);
    fixture.lastCapabilities = registration.capabilities;
    assert.deepEqual(registration.capabilities.run_contract, RUNTIME_RUN_CONTRACT);
    assert.equal(registration.capabilities.run_contract.schema_version, 6);
    assert.equal(registration.capabilities.run_contract.routing_schema, "octo.runtime-selection/v2");
    fixture.registrations += 1;
    response.writeHead(rejectRegistration ? 400 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(rejectRegistration
      ? { error: { code: "VALIDATION_ERROR", details: { reason_code: "RUNTIME_RUN_CONTRACT_UNSUPPORTED" } } }
      : { runtime: { id: runtimeId, profile: "default", protocol_version: 2 } }));
  });
  server.on("upgrade", (request, socket, head) => {
    assert.ok(fixture.registrations > 0);
    assert.equal(rejectRegistration, false);
    fixture.upgrades += 1;
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", socket => {
    fixture.socket = socket;
    socket.on("message", data => {
      const frame = JSON.parse(data.toString("utf8"));
      if (frame.type === "runtime.hello") {
        socket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 }));
        ready.resolve();
      }
      if (frame.type === "context.sync_request") fixture.contextSyncs += 1;
      if (frame.type === "command.ack") fixture.receipts.push(frame.payload);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fixture.runtime = new AgentWorkRuntime({
    profile: "default", baseUrl: `http://127.0.0.1:${server.address().port}`, token: "runtime-test-token",
    runtimeId, runtimeName: "selection-test", storePath, initialReconnectDelayMs: 60_000, reconnectDelayMs: 60_000,
    ...(openClawProbeState ? { adapterProbeMs: 20 } : {})
  }, {
    list: async () => [{ type: "fake", available: true, capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: [] }, ...(openClawProbeState ? [{ type: "openclaw", available: false, unavailableReason: "config_not_found", capabilities: ["react"], agentSources: ["preset", "provisioned"], executionFeatures: ["agent.existing-target.v1"] }] : [])],
    probe: async () => ({ ...openClawProbeState }),
    cancel: async () => ({ cancelled: true }),
    async *invoke(_adapterType, request) {
      fixture.invocations.push(request);
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    }
  });
  fixture.close = async () => {
    await fixture.runtime.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  };
  return fixture;
}

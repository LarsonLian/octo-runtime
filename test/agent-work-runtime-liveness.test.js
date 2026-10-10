import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { AgentWorkRuntime } from "../apps/daemon/dist/agent-work-runtime.js";
import { contextEnvelope, resolvedRuntimeSelection, executionContext, terminalGrant, waitFor, wire } from "./agent-work-runtime-fixture.js";

const host = {
  list: async () => [],
  cancel: async () => ({ cancelled: true }),
  async *invoke() { yield { protocolVersion: 2, type: "run.completed", payload: {} }; }
};

async function startFixture(t, { silentFirst = false, welcomeOnFirst = true, dispatchRun = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "oh-runtime-liveness-"));
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const state = { registrations: 0, connections: 0, firstHeartbeats: 0, helloRuntimeIds: [], invokedRequests: [], terminalEvents: [] };
  let runtime;
  t.after(async () => {
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  httpServer.on("request", async (request, response) => {
    if (request.url === "/v1/runtime/context/prepare") { request.resume(); response.writeHead(200); response.end("{}"); return; }
    for await (const _chunk of request) { /* Consume registration. */ }
    state.registrations += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { profile: "default", runtime_key: "runtime-liveness", protocol_version: 2 } }));
  });
  httpServer.on("upgrade", (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket));
  });
  wsServer.on("connection", websocket => {
    const connection = ++state.connections;
    websocket.on("message", data => {
      const frame = JSON.parse(data.toString("utf8"));
      if (frame.type === "runtime.hello") {
        state.helloRuntimeIds.push(frame.runtime_key);
        if (connection !== 1 || welcomeOnFirst) {
          websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 10 }));
          if (dispatchRun) {
            const plan = { agent_source: "provisioned", adapter_type: "fake", workdir: process.cwd(), approval_mode: "ask", required_execution_features: ["tool.canonical"] };
            const items = [{ namespace: "octo.content", name: "inline", payload: { entries: [
              { resource_ref: "octo://liveness/background", text: "Frozen background for the liveness run" }
            ] } }];
            websocket.send(wire("runtime.command", {
              server_seq: 1, command_key: "command-liveness", run_key: "run-liveness", type: "run.start",
              lease_id: "lease-liveness", fencing_token: 1,
              payload: {
                schema_version: 7, context_configuration_version: 1,
                resolved_runtime_selection: resolvedRuntimeSelection("runtime-liveness"),
                effective_context: executionContext(plan, items), resolved_execution_plan: plan,
                run_key: "run-liveness", agent_session_key: "session-liveness",
                agent_run_request: {
                  namespace: "test", agent_key: "agent-liveness", agent_revision_key: "revision-liveness",
                  session_affinity_key: "liveness/session", trigger: { kind: "test", occurrence_key: "liveness/current" },
                  context: contextEnvelope(items), input: { parts: [{ type: "text", text: "Keep the connection healthy" }] }
                },
                agent_revision: { definition: { instructions: "Keep runtime work scoped." } }
              }
            }));
          }
        }
      }
      if (frame.type === "run.event_batch") {
        const terminal = frame.payload.events.find(event => event.type === "run.completed");
        websocket.send(wire("event.ack", {
          run_key: frame.payload.run_key,
          received_through_seq: frame.payload.last_seq,
          durable_through_seq: frame.payload.last_seq,
          ...(terminal ? terminalGrant(terminal) : {})
        }));
        if (terminal) state.terminalEvents.push(terminal);
      }
      if (frame.type === "runtime.heartbeat") {
        if (connection === 1) state.firstHeartbeats += 1;
        if (connection !== 1 || !silentFirst) {
          websocket.send(wire("runtime.heartbeat_ack", { server_time: new Date().toISOString() }));
        }
      }
    });
  });
  await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  runtime = new AgentWorkRuntime({
    profile: "default",
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: "runtime-token",
    runtimeKey: "runtime-liveness",
    runtimeName: "runtime-liveness",
    storePath: join(directory, "agent-work.db"),
    receiveTimeoutMs: 100,
    reconnectFirstMs: 5,
    reconnectMs: 5,
    reconnectMaxMs: 5
  }, {
    ...host,
    list: async () => [{ type: "fake", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: ["tool.canonical"] }],
    async *invoke(_adapterType, request) {
      state.invokedRequests.push(request);
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    }
  });
  await runtime.start();
  return { runtime, state };
}

test("missing heartbeat ACKs terminate an open socket and reconnect the same runtime", async t => {
  const { runtime, state } = await startFixture(t, { silentFirst: true });
  await waitFor(() => state.connections >= 2 && runtime.status.connected === true);
  assert.ok(state.firstHeartbeats > 0, "outbound heartbeats must not reset the receive timeout");
  assert.deepEqual(state.helloRuntimeIds.slice(0, 2), ["runtime-liveness", "runtime-liveness"]);
  assert.equal(state.registrations, 2);
});

test("a schema2 run consumes frozen Context without disrupting heartbeat liveness", { timeout: 5_000 }, async testContext => {
  const { runtime, state } = await startFixture(testContext, { dispatchRun: true });
  await waitFor(() => state.terminalEvents.length === 1 && runtime.status.outboxPending === 0);
  assert.equal(state.invokedRequests.length, 1);
  const request = state.invokedRequests[0];
  assert.equal(request.approvalMode, "ask");
  assert.equal(request.controlInstructions, "Keep runtime work scoped.");
  assert.equal(request.prompt, "[Current message]\nKeep the connection healthy");
  assert.match(request.modelInput, /Frozen background for the liveness run/);
  assert.doesNotMatch(request.prompt, /Frozen background/);
  assert.equal(request.runMetadata.runtimeKey, "runtime-liveness");
  assert.equal(request.context.schema, "octo.context-envelope/v3");
  assert.equal(request.context.runtimeKey, undefined);
  assert.equal(runtime.status.connected, true);
  assert.equal(state.registrations, 1);
});

test("missing welcome after WebSocket open also triggers automatic reconnect", async t => {
  const { runtime, state } = await startFixture(t, { silentFirst: true, welcomeOnFirst: false });
  await waitFor(() => state.connections >= 2 && runtime.status.connected === true);
  assert.equal(state.firstHeartbeats, 0);
  assert.equal(state.registrations, 2);
});

test("inbound heartbeat ACKs reset the watchdog and shutdown cancels it", async t => {
  const { runtime, state } = await startFixture(t);
  await waitFor(() => runtime.status.connected === true);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(state.registrations, 1);
  assert.equal(runtime.status.connected, true);
  await runtime.close();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(state.registrations, 1, "shutdown must not leave a receive timer that reconnects");
});

test("receive timeout rejects non-positive or non-finite values", () => {
  for (const receiveTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new AgentWorkRuntime({
      profile: "default",
      baseUrl: "https://im-test.deepminer.com.cn/agentworker",
      token: "runtime-token",
      runtimeName: "runtime-liveness",
      storePath: "unused.db",
      receiveTimeoutMs
    }, host), /receiveTimeoutMs must be finite and positive/);
  }
});

test("Agent Work Runtime requires an explicit valid profile", () => {
  for (const profile of [undefined, null, 123, "", "a/b", "a\n", "a".repeat(129)]) {
    assert.throws(() => new AgentWorkRuntime({
      profile, baseUrl: "http://localhost:3000", token: "runtime-token",
      runtimeName: "MacBook", storePath: "unused.db"
    }, host), /valid Harness profile/);
  }
});

test("missing, mismatched or rejected server profiles fail before WSS and do not retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-runtime-profile-drift-"));
  try {
    for (const result of [
      { status: 200, body: { runtime: { runtime_key: "runtime-fixture" , protocol_version: 2 } } },
      { status: 200, body: { runtime: { runtime_key: "runtime-fixture", profile: "Work" , protocol_version: 2 } } },
      { status: 409, body: { error: { code: "CONFLICT", details: { reason_code: "RUNTIME_PROFILE_MISMATCH" } } } }
    ]) {
      let registrations = 0;
      const server = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        assert.equal(JSON.parse(body).profile, "work");
        registrations++;
        response.writeHead(result.status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(result.body));
      });
      server.on("upgrade", () => assert.fail("profile drift must not open WSS"));
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const runtime = new AgentWorkRuntime({
        profile: "work", baseUrl: `http://127.0.0.1:${server.address().port}`,
        token: "runtime-token", runtimeName: "MacBook", storePath: join(directory, "agent-work.db")
      }, host);
      try {
        await assert.rejects(runtime.start(), /profile/);
        assert.equal(runtime.status.connected, false);
        assert.equal(registrations, 1);
      } finally {
        await runtime.close();
        await new Promise(resolve => server.close(resolve));
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

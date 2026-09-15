import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { AgentWorkRuntime } from "../apps/daemon/dist/agent-work-runtime.js";
import { waitFor, wire } from "./agent-work-runtime-fixture.js";

const host = {
  list: async () => [],
  cancel: async () => ({ cancelled: true }),
  async *invoke() { yield { type: "run.finished", payload: {} }; }
};

async function startFixture(t, { silentFirst = false, welcomeOnFirst = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "oh-runtime-liveness-"));
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const state = { registrations: 0, connections: 0, firstHeartbeats: 0, helloRuntimeIds: [] };
  let runtime;
  t.after(async () => {
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* Consume registration. */ }
    state.registrations += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { id: "runtime-liveness", protocol_version: 1 } }));
  });
  httpServer.on("upgrade", (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket));
  });
  wsServer.on("connection", websocket => {
    const connection = ++state.connections;
    websocket.on("message", data => {
      const frame = JSON.parse(data.toString("utf8"));
      if (frame.type === "runtime.hello") {
        state.helloRuntimeIds.push(frame.runtime_id);
        if (connection !== 1 || welcomeOnFirst) {
          websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 10 }));
        }
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
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: "runtime-token",
    runtimeId: "runtime-liveness",
    runtimeName: "runtime-liveness",
    fingerprint: "runtime:liveness",
    storePath: join(directory, "agent-work.db"),
    receiveTimeoutMs: 100,
    reconnectFirstMs: 5,
    reconnectMs: 5,
    reconnectMaxMs: 5
  }, host);
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
      baseUrl: "https://im-test.deepminer.com.cn/agentworker",
      token: "runtime-token",
      runtimeName: "runtime-liveness",
      fingerprint: "runtime:liveness",
      storePath: "unused.db",
      receiveTimeoutMs
    }, host), /receiveTimeoutMs must be finite and positive/);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeDaemonRun } from "../packages/octo-harness-daemon/dist/runtime/run-stream.js";
import { callDaemon } from "../packages/octo-harness-daemon/dist/runtime/runtime-contract.js";
import { invokeRequest } from "./agent-work-runtime-fixture.js";
import { canonicalEvents } from "../packages/octo-harness-protocol/dist/index.js";

async function fixture(t, handler) {
  const root = await mkdtemp(join(tmpdir(), "octo-invoke-")),
    path = join(root, "host.sock");
  const connections = new Set();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.setEncoding("utf8");
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk;
      if (pending.includes("\n"))
        handler(JSON.parse(pending.slice(0, pending.indexOf("\n"))), socket);
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return path;
}
const receipt = (request, stream) => ({
  run_id: request.runId,
  invocation_id: request.invocationId,
  stream_id: stream,
  agent_session_id: request.agentSessionId,
  session_generation: request.sessionGeneration ?? 0,
  protocol_mode: "canonical",
  protocol: "codex.app-server"
});
const event = (request, stream, seq, canonical) => ({
  jsonrpc: "2.0",
  method: "agent_run.event",
  params: {
    run_id: request.runId,
    stream_id: stream,
    seq,
    event: {
      ...receipt(request, stream),
      seq,
      ...(canonical
        ? { kind: "canonical", event: canonical }
        : { kind: "control", control: { type: "state", state: "completed" } })
    }
  }
});
const write = (socket, frame) => socket.write(JSON.stringify(frame) + "\n");

test("daemon calls reject malformed JSON with the original parse Error", async (t) => {
  const path = await fixture(t, (_rpc, socket) => socket.end("{invalid JSON}\n"));
  await assert.rejects(callDaemon(path, { method: "status" }), SyntaxError);
});

test("daemon calls reject remote errors with their diagnostic message", async (t) => {
  const path = await fixture(t, (rpc, socket) => {
    write(socket, { jsonrpc: "2.0", id: rpc.id, error: { message: "fixture daemon failed" } });
    socket.end();
  });
  await assert.rejects(callDaemon(path, { method: "status" }), {
    name: "Error",
    message: "fixture daemon failed"
  });
});

test("local invoke repairs IPC disconnect without submitting again or losing full canonical payloads", async (t) => {
  const request = invokeRequest(),
    calls = [],
    stream = "host:epoch";
  const canonical = [
    { protocolVersion: 2, type: "run.started", payload: {} },
    {
      protocolVersion: 2,
      type: "message.delta",
      payload: {
        channel: "analysis",
        exposure: "private_reasoning",
        provenance: { provider: "fixture", nativeEvent: "reasoning" },
        text: "provider detail",
        metadata: { a: [1, 2] }
      }
    },
    { protocolVersion: 2, type: "run.completed", payload: {} }
  ];
  const path = await fixture(t, (rpc, socket) => {
    calls.push(rpc);
    assert.equal(rpc.jsonrpc, "2.0");
    write(socket, { jsonrpc: "2.0", id: rpc.id, result: receipt(request, stream) });
    if (rpc.method === "agent_run.invoke") {
      write(socket, event(request, stream, 1, canonical[0]));
      socket.end();
    } else {
      write(socket, event(request, stream, 2, canonical[1]));
      write(socket, event(request, stream, 3, canonical[2]));
      write(socket, event(request, stream, 4));
      socket.end();
    }
  });
  const received = [];
  for await (const value of canonicalEvents(
    invokeDaemonRun(path, "codex", request, { protocolMode: "canonical" })
  ))
    received.push(value);
  assert.deepEqual(received, canonical);
  assert.deepEqual(
    calls.map((rpc) => rpc.method),
    ["agent_run.invoke", "agent_run.subscribe"]
  );
  assert.equal(calls[1].params.after_seq, 1);
  assert.equal(calls[1].params.stream_id, stream);
});

test("source expiration fails explicitly and never reinvokes the adapter", async (t) => {
  const request = invokeRequest(),
    calls = [];
  const path = await fixture(t, (rpc, socket) => {
    calls.push(rpc.method);
    if (rpc.method === "agent_run.invoke")
      write(socket, { jsonrpc: "2.0", id: rpc.id, result: receipt(request, "original") });
    else write(socket, { jsonrpc: "2.0", id: rpc.id, error: { message: "STREAM_EXPIRED" } });
    socket.end();
  });
  await assert.rejects(async () => {
    for await (const value of invokeDaemonRun(path, "codex", request, {
      protocolMode: "canonical"
    }))
      void value;
  }, /STREAM_EXPIRED/);
  assert.deepEqual(
    calls.filter((call) => call !== "agent_run.cancel"),
    ["agent_run.invoke", "agent_run.subscribe"]
  );
});

test("lost acceptance ACK recovers the original native stream without a second invoke", async (t) => {
  const request = invokeRequest(),
    calls = [],
    stream = "native:original";
  const accepted = { ...receipt(request, stream), protocol_mode: "native" };
  const frames = [
    {
      ...accepted,
      seq: 1,
      kind: "native",
      messageKind: "notification",
      payload: { method: "future/raw", params: { untouched: [1, 2] } }
    },
    { ...accepted, seq: 2, kind: "control", control: { type: "state", state: "completed" } }
  ];
  const path = await fixture(t, (rpc, socket) => {
    calls.push(rpc.method);
    if (rpc.method === "agent_run.invoke") {
      socket.end();
      return;
    }
    write(socket, { jsonrpc: "2.0", id: rpc.id, result: accepted });
    if (rpc.method === "agent_run.subscribe")
      for (const frame of frames)
        write(socket, {
          jsonrpc: "2.0",
          method: "agent_run.event",
          params: { run_id: request.runId, stream_id: stream, seq: frame.seq, event: frame }
        });
    socket.end();
  });
  const received = [];
  for await (const frame of invokeDaemonRun(path, "codex", request)) received.push(frame);
  assert.deepEqual(received, frames);
  assert.deepEqual(calls, ["agent_run.invoke", "agent_run.get", "agent_run.subscribe"]);
});

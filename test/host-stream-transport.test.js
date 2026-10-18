import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterHostRpcClient } from "@mininglamp-oss/octo-runtime-adapter-host";
import {
  HOST_RPC_MAX_LINE_BYTES,
  MAX_STREAM_LIMIT_POLICY,
  invocationInput
} from "@mininglamp-oss/octo-runtime-protocol";
import {
  invokeDaemonRun,
  subscribeDaemonRun
} from "../packages/octo-runtime-daemon/dist/runtime/run-stream.js";
import { invokeRequest } from "./runtime-fixture.js";

async function socketFixture(context, handler) {
  const root = await mkdtemp(join(tmpdir(), "octo-large-stream-"));
  const path = join(root, "host.sock");
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", (chunk) => handler(JSON.parse(chunk.toString()), socket));
  });
  await new Promise((resolve) => server.listen(path, resolve));
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return path;
}

function receipt(input) {
  return {
    run_id: input.runId,
    invocation_id: input.invocationId,
    stream_id: "fixture:stream",
    agent_session_id: input.sessionId,
    session_generation: input.sessionGeneration ?? 0,
    protocol_mode: "canonical",
    protocol: "fixture.canonical"
  };
}

test("daemon SDK retains large UTF-8 output and its accepted terminal without cancellation", async (context) => {
  const input = invocationInput(invokeRequest(), "canonical", "fixture");
  const identity = receipt(input);
  const text = "大".repeat(Math.ceil(1_430_765 / 3));
  const expected = [
    {
      ...identity,
      seq: 1,
      kind: "canonical",
      event: { protocolVersion: 2, type: "message.delta", payload: { channel: "final", text } }
    },
    { ...identity, seq: 2, kind: "control", control: { type: "state", state: "completed" } }
  ];
  const methods = [];
  const path = await socketFixture(context, (rpc, socket) => {
    methods.push(rpc.method);
    socket.write(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: identity }) + "\n");
    for (const event of expected)
      socket.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "agent_run.event",
          params: {
            run_id: identity.run_id,
            stream_id: identity.stream_id,
            seq: event.seq,
            event
          }
        }) + "\n"
      );
  });
  const actual = [];
  for await (const frame of invokeDaemonRun(path, input)) actual.push(frame);
  assert.deepEqual(actual, expected);
  assert.deepEqual(methods, ["agent_run.invoke"]);
});

test("daemon SDK rejects an unterminated oversized UTF-8 line by bytes", async (context) => {
  const text = "大".repeat(Math.floor(HOST_RPC_MAX_LINE_BYTES / 3) + 1);
  assert.ok(text.length < HOST_RPC_MAX_LINE_BYTES);
  const path = await socketFixture(context, (_rpc, socket) => socket.write(text));
  await assert.rejects(
    async () => {
      for await (const frame of subscribeDaemonRun(path, { runId: "large" })) void frame;
    },
    (error) => {
      assert.equal(error.code, "HOST_FRAME_TOO_LARGE");
      assert.equal(error.boundary, "daemon.stream_transport");
      assert.equal(error.limitBytes, HOST_RPC_MAX_LINE_BYTES);
      assert.ok(error.measuredBytes > error.limitBytes);
      return true;
    }
  );
});

test("Host RPC accepts a hard-maximum HostFrame plus its envelope without failing sibling requests", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent = [];
  output.on("data", (chunk) => sent.push(JSON.parse(chunk.toString())));
  const client = new AdapterHostRpcClient({ input, output });
  try {
    const request = invocationInput(invokeRequest(), "canonical", "fixture");
    const frame = {
      ...receipt(request),
      seq: 1,
      kind: "canonical",
      event: {
        protocolVersion: 2,
        type: "message.delta",
        payload: { channel: "final", text: "" }
      }
    };
    const emptyBytes = Buffer.byteLength(JSON.stringify(frame));
    frame.event.payload.text = "x".repeat(MAX_STREAM_LIMIT_POLICY.hostFrameMaxBytes - emptyBytes);
    assert.equal(
      Buffer.byteLength(JSON.stringify(frame)),
      MAX_STREAM_LIMIT_POLICY.hostFrameMaxBytes
    );
    const large = client.request("fixture.large");
    const sibling = client.request("fixture.sibling");
    const line = JSON.stringify({ jsonrpc: "2.0", id: sent[0].id, result: frame });
    assert.ok(Buffer.byteLength(line) > MAX_STREAM_LIMIT_POLICY.hostFrameMaxBytes);
    input.write(line + "\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: sent[1].id, result: "ready" }) + "\n");
    assert.equal((await large).event.payload.text.length, frame.event.payload.text.length);
    assert.equal(await sibling, "ready");
  } finally {
    client.close();
    input.destroy();
    output.destroy();
  }
});

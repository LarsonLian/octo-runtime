import { preparedFrames } from "./runtime-fixture.js";
import { preparedTestInvoke } from "./runtime-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import {
  AdapterHost,
  AdapterHostRpcClient,
  AdapterHostRpcServer
} from "@mininglamp-oss/octo-runtime-adapter-host";
import {
  createCodexAdapter,
  CodexEventNormalizer
} from "@mininglamp-oss/octo-runtime-adapter-codex";
import {
  createClaudeCodeAdapter,
  ClaudeEventNormalizer
} from "@mininglamp-oss/octo-runtime-adapter-claude-code";
import { assertHostFrame, isHostTerminal } from "../packages/octo-runtime-protocol/dist/index.js";
import {
  DriverQueue,
  NativeInteractionBridge,
  watchLineLimit
} from "../packages/octo-runtime-adapter-sdk/dist/index.js";
import { invokeRequest } from "./runtime-fixture.js";
const codex = fileURLToPath(new URL("../test-support/fake-native-codex.mjs", import.meta.url));
const claude = fileURLToPath(
  new URL("../test-support/claude/fake-permission-cli.js", import.meta.url)
);
const input = (scenario = "normal", extras = {}) =>
  invokeRequest({ modelInput: scenario, approvalMode: "full_access", ...extras });
const collect = async (source) => {
  const values = [];
  for await (const value of source) values.push(value);
  return values;
};
function hostFor(adapter) {
  const host = new AdapterHost();
  host.register(adapter);
  return host;
}
const codexHost = () =>
  hostFor(createCodexAdapter({ command: process.execPath, appServerArgs: [codex] }));

test("default native retains provider response and notification fields and never normalizes", async () => {
  const original = CodexEventNormalizer.prototype.normalize;
  let conversions = 0;
  CodexEventNormalizer.prototype.normalize = function (...args) {
    conversions++;
    return original.apply(this, args);
  };
  try {
    const host = codexHost(),
      frames = await collect(
        preparedTestInvoke((...args) => preparedFrames(host, ...args))("codex", input())
      );
    for (const frame of frames) assertHostFrame(frame);
    assert.equal(conversions, 0);
    assert.ok(
      frames.every(
        (frame) => frame.protocol_mode === "native" && frame.protocol === "codex.app-server"
      )
    );
    assert.deepEqual(
      frames.map((frame) => frame.seq),
      frames.map((_, index) => index + 1)
    );
    const raw = frames.filter((frame) => frame.kind === "native");
    assert.deepEqual(raw[0].payload.result.future, { exact: true });
    assert.deepEqual(
      raw.find((frame) => frame.payload.method === "item/agentMessage/delta").payload,
      {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-native",
          turnId: "turn-native",
          itemId: "native-item-id",
          delta: "",
          extra: { keep: ["a", 2] }
        },
        future: "not canonical"
      }
    );
    assert.deepEqual(raw.at(-1).payload.extension, { retained: true });
    assert.equal(frames.filter(isHostTerminal).length, 1);
    assert.equal(frames.at(-1).control.state, "completed");
    assert.doesNotMatch(JSON.stringify(frames), /excluded|other-thread/);
    await assert.rejects(
      collect(preparedTestInvoke((...args) => preparedFrames(host, ...args))("codex", input())),
      (error) => error.code === "EXECUTION_IDENTITY_CONFLICT"
    );
  } finally {
    CodexEventNormalizer.prototype.normalize = original;
  }
});

test("explicit canonical runs the converter and retains the existing terminal semantics", async () => {
  const frames = await collect(
    preparedFrames(codexHost(), "codex", input(), { protocolMode: "canonical" })
  );
  assert.ok(
    frames.some((frame) => frame.kind === "canonical" && frame.event.type === "run.completed")
  );
  assert.equal(frames.at(-1).control.state, "completed");
  assert.ok(frames.every((frame) => frame.kind !== "native"));
});

test("native raw RPC errors retain numeric codes and nested data before Host failure", async () => {
  const frames = await collect(
    preparedTestInvoke((...args) => preparedFrames(codexHost(), ...args))(
      "codex",
      input("rpc-error")
    )
  );
  assert.deepEqual(
    frames.find((frame) => frame.kind === "native" && frame.payload.error).payload.error,
    { code: -32123, message: "original error", data: { nested: [1, "raw"] } }
  );
  assert.equal(frames.at(-1).control.state, "failed");
  assert.equal(frames.filter(isHostTerminal).length, 1);
});

for (const scenario of ["unknown", "eof"])
  test(`native ${scenario} handles unsupported requests and missing terminal`, async () => {
    const frames = await collect(
      preparedTestInvoke((...args) => preparedFrames(codexHost(), ...args))(
        "codex",
        input(scenario)
      )
    );
    assert.equal(frames.at(-1).control.state, scenario === "unknown" ? "completed" : "failed");
    assert.equal(frames.filter(isHostTerminal).length, 1);
  });

test("native pending approvals reject widened grants, duplicates, wrong-mode and late replies", async () => {
  const host = codexHost(),
    frames = [],
    request = input("approval", { approvalMode: "ask" });
  const reply = {
    requestId: 42,
    payload: { jsonrpc: "2.0", id: 42, result: { decision: "accept" } }
  };
  for await (const frame of preparedTestInvoke((...args) => preparedFrames(host, ...args))(
    "codex",
    request
  )) {
    frames.push(frame);
    if (
      frame.kind === "control" &&
      frame.control.type === "interaction" &&
      frame.control.status === "pending"
    ) {
      await assert.rejects(
        host.respondNative(request.invocationId, {
          requestId: 42,
          payload: { jsonrpc: "2.0", id: 42, result: { decision: "acceptForSession" } }
        }),
        (error) => error.code === "NATIVE_RESPONSE_INVALID"
      );
      await assert.rejects(
        host.respondInteraction(request.invocationId, { interactionId: "42", outcome: "accepted" }),
        (error) => error.code === "EXECUTION_PROTOCOL_MISMATCH"
      );
      await host.respondNative(request.invocationId, reply);
      await assert.rejects(
        host.respondNative(request.invocationId, reply),
        (error) => error.code === "INTERACTION_NOT_ACTIVE"
      );
    }
  }
  assert.deepEqual(
    frames.find(
      (frame) => frame.kind === "native" && frame.payload.method === "native/replyObserved"
    ).payload.params.reply,
    reply.payload
  );
  assert.ok(
    frames.some(
      (frame) =>
        frame.kind === "native" &&
        frame.messageKind === "request" &&
        frame.payload.future[0] === "original"
    )
  );
  assert.ok(
    frames.some(
      (frame) =>
        frame.kind === "control" &&
        frame.control.type === "interaction" &&
        frame.control.status === "resolved"
    )
  );
  await assert.rejects(host.respondNative(request.invocationId, reply));
});

test("native cancellation and abandoned consumers converge with one terminal and cleanup", async () => {
  const host = codexHost(),
    controller = new AbortController(),
    frames = [];
  for await (const frame of preparedTestInvoke((...args) => preparedFrames(host, ...args))(
    "codex",
    input("hang", { signal: controller.signal })
  )) {
    frames.push(frame);
    if (frame.kind === "native" && frame.payload.method === "item/agentMessage/delta")
      controller.abort("test cancelled");
  }
  assert.equal(frames.at(-1).control.state, "cancelled");
  assert.equal(frames.filter(isHostTerminal).length, 1);
  assert.equal(host.cancel("invoke-test"), false);
  const second = codexHost(),
    iterator = preparedTestInvoke((...args) => preparedFrames(second, ...args))(
      "codex",
      input("hang")
    );
  await iterator.next();
  await iterator.return();
  assert.equal(second.cancel("invoke-test"), false);
});

for (const mode of ["ask", "full_access"])
  test(`Claude native ${mode} preserves control request and result without normalization`, async () => {
    const original = ClaudeEventNormalizer.prototype.normalize;
    let conversions = 0;
    ClaudeEventNormalizer.prototype.normalize = function (...args) {
      conversions++;
      return original.apply(this, args);
    };
    const host = hostFor(
      createClaudeCodeAdapter({ command: process.execPath, commandArgsPrefix: [claude] })
    );
    const request = input("normal", { approvalMode: mode });
    const frames = [];
    try {
      for await (const frame of preparedTestInvoke((...args) => preparedFrames(host, ...args))(
        "claude-code",
        request
      )) {
        frames.push(frame);
        if (
          mode === "ask" &&
          frame.kind === "control" &&
          frame.control.type === "interaction" &&
          frame.control.status === "pending"
        ) {
          const reply = {
            requestId: frame.control.requestId,
            payload: {
              type: "control_response",
              response: {
                subtype: "success",
                request_id: frame.control.requestId,
                response: {
                  behavior: "allow",
                  updatedInput: { command: "printf approval-fixture" }
                }
              }
            }
          };
          await host.respondNative(request.invocationId, reply);
          await assert.rejects(host.respondNative(request.invocationId, reply));
        }
      }
      assert.equal(conversions, 0);
      assert.equal(frames.at(-1).control.state, "completed");
      assert.equal(
        frames.find((frame) => frame.kind === "native" && frame.payload.type === "result").payload
          .result,
        "permission:allow"
      );
      assert.ok(
        frames.some(
          (frame) =>
            frame.kind === "native" &&
            frame.messageKind === "request" &&
            frame.payload.request.tool_use_id === "tool-1"
        )
      );
    } finally {
      ClaudeEventNormalizer.prototype.normalize = original;
    }
  });

test("RPC native admission rejects unsupported mode before ACK; genuine native frames cross RPC without payload logs", async () => {
  const host = codexHost();
  let invokes = 0;
  host.register({
    metadata: {
      protocolSupport: {
        protocol: "canonical-only" + ".canonical",
        modes: ["canonical"],
        nativeMethods: []
      },
      type: "canonical-only",
      agentSources: ["provisioned"]
    },
    async *invoke() {
      invokes++;
    }
  });
  const upstream = new PassThrough(),
    downstream = new PassThrough(),
    trace = [];
  new AdapterHostRpcServer({
    host,
    output: downstream,
    trace: (_direction, frame) => trace.push(frame)
  }).listen(upstream);
  const client = new AdapterHostRpcClient({ input: downstream, output: upstream });
  try {
    await assert.rejects(
      collect(
        preparedTestInvoke((...args) => preparedFrames(client, ...args))("canonical-only", input())
      ),
      (error) => error.code === "PROTOCOL_MODE_UNSUPPORTED"
    );
    assert.equal(invokes, 0);
    const frames = await collect(
      preparedTestInvoke((...args) => preparedFrames(client, ...args))("codex", input())
    );
    assert.equal(frames.at(-1).control.state, "completed");
    assert.ok(frames.some((frame) => frame.kind === "native"));
    assert.doesNotMatch(
      trace.join("\n"),
      /not canonical|native-item-id|Provider model input|Keep changes scoped/
    );
  } finally {
    client.close();
    upstream.end();
    downstream.end();
    await host.shutdown();
  }
});

test("bounded driver queue fails overflow and rejects pushes after close", async () => {
  const queue = new DriverQueue({
    limits: {
      adapterQueueItemMaxBytes: 128 * 1024,
      adapterQueueMaxBytes: 256 * 1024,
      adapterQueueMaxItems: 16
    }
  });
  queue.push({ text: "x".repeat(256 * 1024) });
  queue.push({ text: "late" });
  await assert.rejects(collect(queue), /STREAM_QUEUE_ITEM_TOO_LARGE/);
});

test("failed native response delivery invalidates ownership and cannot be retried", async () => {
  const bridge = new NativeInteractionBridge();
  let writes = 0,
    closes = 0;
  bridge.bindTransport(async () => {
    closes++;
  });
  bridge.request(
    1,
    { id: 1 },
    async () => {
      writes++;
      throw new Error("write failed");
    },
    () => {}
  );
  await assert.rejects(bridge.respond({ requestId: 1, payload: {} }), /write failed/);
  await assert.rejects(bridge.respond({ requestId: 1, payload: {} }), /INTERACTION_NOT_ACTIVE/);
  assert.equal(writes, 1);
  assert.equal(closes, 1);
  assert.ok(bridge.queue.drain().some((value) => value.control?.status === "invalidated"));
});

test("in-flight automatic native response has exclusive ownership until its write acknowledgement", async () => {
  const bridge = new NativeInteractionBridge();
  let acknowledge;
  const written = new Promise((resolve) => {
    acknowledge = resolve;
  });
  bridge.request(
    1,
    { id: 1 },
    () => written,
    () => {},
    { result: "automatic" }
  );
  await assert.rejects(bridge.respond({ requestId: 1, payload: {} }), /INTERACTION_NOT_ACTIVE/);
  acknowledge();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    bridge.queue.drain().filter((value) => value.control?.status === "resolved").length,
    1
  );
  await assert.rejects(bridge.respond({ requestId: 1, payload: {} }), /INTERACTION_NOT_ACTIVE/);
  bridge.close();
});

test("cancelling a native pending request invalidates it and rejects late replies", async () => {
  const host = codexHost(),
    request = input("approval", { approvalMode: "ask" }),
    frames = [];
  for await (const frame of preparedTestInvoke((...args) => preparedFrames(host, ...args))(
    "codex",
    request
  )) {
    frames.push(frame);
    if (frame.control?.status === "pending") host.cancel(request.invocationId, "test cancelled");
  }
  assert.ok(frames.some((frame) => frame.control?.status === "invalidated"));
  assert.equal(frames.at(-1).control.state, "cancelled");
  await assert.rejects(
    host.respondNative(request.invocationId, {
      requestId: 42,
      payload: { jsonrpc: "2.0", id: 42, result: { decision: "accept" } }
    })
  );
  await host.shutdown();
});

test("partial JSON lines are bounded before newline and report overflow once", async () => {
  const input = new PassThrough(),
    failures = [];
  const remove = watchLineLimit(input, 8, (error) => failures.push(error));
  input.resume();
  input.write("1234");
  input.write("5678");
  assert.equal(failures.length, 0);
  input.write("9");
  input.write("more");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /PROVIDER_MESSAGE_TOO_LARGE/);
  remove();
  input.destroy();
});

test("invalid driver frames preserve continuous sequence for failure controls", async () => {
  const host = hostFor({
    metadata: {
      type: "invalid",
      agentSources: ["provisioned"],
      protocolSupport: { protocol: "invalid.raw", modes: ["native"], nativeMethods: [] }
    },
    async *invoke() {
      yield { kind: "native", messageKind: "notification", payload: { invalid: undefined } };
    }
  });
  const frames = await collect(
    preparedTestInvoke((...args) => preparedFrames(host, ...args))("invalid", input())
  );
  assert.deepEqual(
    frames.map((frame) => frame.seq),
    frames.map((_, i) => i + 1)
  );
  assert.equal(frames.at(-1).control.state, "failed");
  await host.shutdown();
});

for (const protocolMode of ["native", "canonical"])
  test(`${protocolMode} refuses successful terminal when driver return cleanup fails`, async () => {
    const host = hostFor({
      metadata: {
        type: "cleanup",
        agentSources: ["provisioned"],
        protocolSupport: {
          protocol: "cleanup.raw",
          modes: ["native", "canonical"],
          nativeMethods: []
        }
      },
      invoke() {
        let next = 0;
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          async next() {
            return next++ === 0
              ? {
                  done: false,
                  value:
                    protocolMode === "native"
                      ? { kind: "control", control: { type: "state", state: "completed" } }
                      : { protocolVersion: 2, type: "run.completed", payload: {} }
                }
              : { done: true };
          },
          async return() {
            throw new Error("cleanup failed");
          }
        };
      }
    });
    const frames = await collect(preparedFrames(host, "cleanup", input(), { protocolMode }));
    assert.equal(frames.at(-1).control.state, "failed");
    assert.equal(frames.filter(isHostTerminal).length, 1);
    assert.ok(!frames.some((frame) => frame.event?.type === "run.completed"));
    await host.shutdown();
  });

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AdapterHost,
  HostRunService,
  startHostSocketServer
} from "@mininglamp-oss/octo-runtime-adapter-host";
import { startDaemonServer } from "@mininglamp-oss/octo-runtime-daemon";
import {
  DEFAULT_STREAM_LIMIT_POLICY,
  invocationInput,
  isHostTerminal,
  resolveStreamLimitPolicy
} from "@mininglamp-oss/octo-runtime-protocol";
import { invokeDaemonRun } from "../packages/octo-runtime-daemon/dist/runtime/run-stream.js";
import { invokeRequest, waitFor } from "./runtime-fixture.js";

const MIB = 1024 * 1024;
const reducedPolicy = resolveStreamLimitPolicy({
  hostFrameMaxBytes: 4096,
  replayRunMaxBytes: 8192,
  replayGlobalMaxBytes: 16384
});

function createPolicyAdapter({ type }) {
  return {
    metadata: {
      type,
      agentSources: ["provisioned"],
      protocolSupport: { protocol: "fixture.canonical", modes: ["canonical"], nativeMethods: [] }
    },
    async *invoke(request, context) {
      if (request.prompt === "replay") {
        for (let index = 0; index < 24; index++)
          yield {
            protocolVersion: 2,
            type: "message.delta",
            payload: { channel: "final", text: "x".repeat(1024) }
          };
      } else {
        yield {
          protocolVersion: 2,
          type: "message.delta",
          payload: {
            channel: "final",
            text:
              request.prompt === "large"
                ? "x".repeat(21 * 1024 * 1024)
                : JSON.stringify(context.streamLimits)
          }
        };
      }
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    }
  };
}

function largeToolOutput() {
  return "大".repeat(476_921) + "xy";
}

function createSdkAdapter({ type }) {
  return {
    metadata: {
      type,
      agentSources: ["provisioned"],
      protocolSupport: {
        protocol: "fixture.sdk",
        modes: ["canonical", "native"],
        nativeMethods: []
      }
    },
    async *invoke(_request, context) {
      const output = largeToolOutput();
      if (context.protocolMode === "native") {
        yield {
          kind: "native",
          messageKind: "notification",
          payload: {
            jsonrpc: "2.0",
            method: "item/completed",
            params: {
              threadId: "thread-sdk",
              turnId: "turn-sdk",
              item: {
                id: "tool-sdk",
                type: "commandExecution",
                status: "completed",
                aggregated_output: output,
                exit_code: 0
              }
            },
            future: { keep: ["原生字段", 7, true, null] }
          }
        };
        yield {
          kind: "native",
          messageKind: "notification",
          payload: {
            jsonrpc: "2.0",
            method: "turn/completed",
            params: { threadId: "thread-sdk", turn: { id: "turn-sdk", status: "completed" } }
          }
        };
        yield { kind: "control", control: { type: "state", state: "completed" } };
        return;
      }
      yield {
        protocolVersion: 2,
        type: "tool_call.create",
        payload: {
          id: "tool-sdk",
          name: "commandExecution",
          args: { command: "fixture-output" },
          status: "running"
        }
      };
      yield {
        protocolVersion: 2,
        type: "tool_call.update",
        payload: {
          id: "tool-sdk",
          status: "completed",
          result: { stdout: output, stderr: "", exitCode: 0 }
        }
      };
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    }
  };
}

function input(adapterType, prompt = "policy", protocolMode = "canonical") {
  return invocationInput(
    invokeRequest({
      runId: randomUUID(),
      invocationId: randomUUID(),
      approvalMode: "full_access",
      prompt
    }),
    protocolMode,
    adapterType
  );
}

async function fixture(context, kind, configurations) {
  const home = await mkdtemp(join(tmpdir(), "octo-policy-"));
  let app;
  context.after(async () => {
    try {
      await app?.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  await writeFile(
    join(home, "adapter.mjs"),
    `export ${createPolicyAdapter.toString()}\n${largeToolOutput.toString()}\nexport ${createSdkAdapter.toString()}`
  );
  const manifestPath = join(home, "adapters.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      adapters: ["limited", "large", "unconfigured", "codex", "sdk"].map((type) => ({
        type,
        module: "./adapter.mjs",
        export: type === "sdk" ? "createSdkAdapter" : "createPolicyAdapter",
        factory: true,
        options: { type }
      }))
    })
  );
  const options = {
    homePath: home,
    socketPath:
      process.platform === "win32"
        ? `\\\\.\\pipe\\octo-policy-${randomUUID()}`
        : join(home, "host.sock"),
    manifestPath,
    hostEntrypoint: fileURLToPath(
      new URL("../packages/octo-runtime-adapter-host/dist/runner.js", import.meta.url)
    )
  };
  app =
    kind === "daemon"
      ? await startDaemonServer({
          ...options,
          localRuntimes: [{ profile: "default", root: home, adapterConfigurations: configurations }]
        })
      : await startHostSocketServer({ ...options, configurations: () => configurations });
  return { host: app.host, socketPath: options.socketPath, hostProcess: app.hostProcess };
}

function assertReducedReplay(host, runId) {
  const info = host.get(runId);
  assert.equal(info.terminal.control.state, "completed");
  assert.ok(info.oldest_seq > 1);
  assert.throws(() => host.read(runId, undefined, 0), /STREAM_GAP/);
  const retained = host.read(runId, info.stream_id, info.oldest_seq - 1).events;
  assert.ok(retained.length > 0);
  assert.equal(retained.at(-1).seq, info.latest_seq);
  assert.ok(
    retained.reduce((bytes, event) => bytes + event.bytes, 0) <= reducedPolicy.replayRunMaxBytes
  );
}

test("HostRunService resolves trusted limits once and freezes before transport starts", async (context) => {
  const provider = new AdapterHost();
  provider.register(createPolicyAdapter({ type: "limited" }));
  const overrides = { ...reducedPolicy };
  let resolutions = 0;
  let transportPolicy;
  const host = new HostRunService(
    {
      async *invokeFrames(request, environment) {
        transportPolicy = environment.streamLimits;
        assert.equal(Object.isFrozen(transportPolicy), true);
        overrides.replayRunMaxBytes = 32 * MIB;
        yield* provider.invokeFrames(request, environment);
      },
      cancel: async (invocationId, reason) => ({ cancelled: provider.cancel(invocationId, reason) })
    },
    () => {
      resolutions++;
      return overrides;
    }
  );
  context.after(async () => {
    await host.close();
    await provider.shutdown();
  });
  const request = input("limited", "replay");
  for await (const frame of host.invokeFrames(request)) void frame;
  assert.equal(resolutions, 1);
  assert.deepEqual(transportPolicy, reducedPolicy);
  assertReducedReplay(host, request.runId);
});

for (const kind of ["daemon", "host socket"]) {
  test(`${kind} applies trusted replay limits before HostRunService admission`, async (context) => {
    const { host } = await fixture(context, kind, {
      limited: { providerOptions: {}, streamLimits: reducedPolicy }
    });
    const request = input("limited", "replay");
    await host.submit(request);
    await waitFor(() => host.get(request.runId).terminal);
    assertReducedReplay(host, request.runId);
  });

  test(`${kind} accepts a legal HostFrame limit above the default throughout execution and replay`, async (context) => {
    const policy = resolveStreamLimitPolicy({ hostFrameMaxBytes: 24 * MIB });
    const { host } = await fixture(context, kind, {
      large: { providerOptions: {}, streamLimits: policy }
    });
    const request = input("large", "large");
    let receivedBytes = 0;
    for await (const frame of host.invokeFrames(request)) {
      if (frame.kind === "canonical" && frame.event.type === "message.delta")
        receivedBytes += Buffer.byteLength(frame.event.payload.text);
    }
    assert.equal(receivedBytes, 21 * MIB);
    const replay = host.read(request.runId, undefined, 0);
    assert.equal(replay.terminal.control.state, "completed");
    const retained = replay.events.find(
      ({ event }) => event.kind === "canonical" && event.event.type === "message.delta"
    );
    assert.ok(retained.bytes > DEFAULT_STREAM_LIMIT_POLICY.hostFrameMaxBytes);
    assert.ok(retained.bytes <= policy.hostFrameMaxBytes);
    assert.equal(retained.event.event.payload.text.length, receivedBytes);
  });

  test(`${kind} uses defaults for unknown configurations and absent overrides, ignoring caller policies`, async (context) => {
    const { host } = await fixture(context, kind, {
      limited: { providerOptions: {} },
      codex: { providerOptions: {}, streamLimits: reducedPolicy }
    });
    for (const adapterType of ["unconfigured", "limited"]) {
      const request = input(adapterType);
      request.contexts.items.push({
        namespace: "extra.test",
        name: "stream_limits",
        payload: { ...reducedPolicy }
      });
      request.agentConfig.providerOptions = { stream_limits: reducedPolicy };
      request.streamLimits = reducedPolicy;
      const received = [];
      for await (const frame of host.invokeFrames(request, { streamLimits: reducedPolicy }))
        received.push(frame);
      const output = received.find(
        (frame) => frame.kind === "canonical" && frame.event.type === "message.delta"
      );
      assert.deepEqual(JSON.parse(output.event.payload.text), DEFAULT_STREAM_LIMIT_POLICY);
      assert.equal(received.at(-1).control.state, "completed");
    }
    const missing = host.invokeFrames(input("missing"));
    await assert.rejects(missing.next(), /unknown adapter: missing/);
  });
}

for (const protocolMode of ["canonical", "native"]) {
  test(`daemon SDK traverses the child Host and real socket with intact large ${protocolMode} tool output and no cancellation`, async (context) => {
    const { host, socketPath, hostProcess } = await fixture(context, "daemon", {});
    assert.ok(Number.isInteger(hostProcess.child.pid));
    assert.notEqual(hostProcess.child.pid, process.pid);
    const cancelRun = context.mock.method(host, "cancelRun");
    const childCancel = context.mock.method(hostProcess.client, "cancel");
    const submit = context.mock.method(host, "submit");
    const request = input("sdk", "sdk-large-tool", protocolMode);
    const frames = [];
    for await (const frame of invokeDaemonRun(socketPath, request)) frames.push(frame);
    const output = largeToolOutput();
    assert.equal(Buffer.byteLength(output), 1_430_765);
    assert.equal(submit.mock.callCount(), 1);
    assert.equal(cancelRun.mock.callCount(), 0);
    assert.equal(childCancel.mock.callCount(), 0);
    assert.ok(frames.every((frame) => frame.protocol_mode === protocolMode));
    assert.deepEqual(
      frames.map((frame) => frame.seq),
      frames.map((_, index) => index + 1)
    );
    assert.equal(frames.filter(isHostTerminal).length, 1);
    assert.equal(frames.at(-1).control.state, "completed");
    assert.equal(
      frames.some((frame) => frame.kind === "control" && frame.control.type === "error"),
      false
    );
    assert.deepEqual(
      host.read(request.runId, undefined, 0).events.map(({ event }) => event),
      frames
    );
    if (protocolMode === "canonical") {
      const updates = frames.filter(
        (frame) => frame.kind === "canonical" && frame.event.type === "tool_call.update"
      );
      assert.equal(updates.length, 1);
      assert.deepEqual(updates[0].event.payload, {
        id: "tool-sdk",
        status: "completed",
        result: { stdout: output, stderr: "", exitCode: 0 }
      });
      assert.equal(
        frames.filter((frame) => frame.kind === "canonical" && frame.event.type === "run.completed")
          .length,
        1
      );
      assert.equal(
        frames.some((frame) => frame.kind === "native"),
        false
      );
    } else {
      const native = frames.filter((frame) => frame.kind === "native");
      assert.equal(native.length, 2);
      assert.ok(native.every((frame) => frame.messageKind === "notification"));
      assert.deepEqual(native[0].payload, {
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId: "thread-sdk",
          turnId: "turn-sdk",
          item: {
            id: "tool-sdk",
            type: "commandExecution",
            status: "completed",
            aggregated_output: output,
            exit_code: 0
          }
        },
        future: { keep: ["原生字段", 7, true, null] }
      });
      assert.deepEqual(native[1].payload, {
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId: "thread-sdk", turn: { id: "turn-sdk", status: "completed" } }
      });
      assert.equal(
        frames.some((frame) => frame.kind === "canonical"),
        false
      );
    }
  });
}

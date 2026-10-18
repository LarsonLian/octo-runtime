import assert from "node:assert/strict";
import test from "node:test";
import { AdapterHost, readAdapterConfigurations } from "@mininglamp-oss/octo-runtime-adapter-host";
import {
  DEFAULT_STREAM_LIMIT_POLICY,
  MAX_STREAM_LIMIT_POLICY,
  failurePayload,
  invocationInput,
  resolveStreamLimitPolicy
} from "@mininglamp-oss/octo-runtime-protocol";
import { invokeRequest } from "./runtime-fixture.js";

test("stream limit policy freezes defaults and rejects unsafe overrides", () => {
  const defaults = resolveStreamLimitPolicy(undefined);
  assert.deepEqual(defaults, DEFAULT_STREAM_LIMIT_POLICY);
  assert.equal(Object.isFrozen(defaults), true);
  assert.throws(
    () =>
      resolveStreamLimitPolicy({
        rawMessageMaxBytes: MAX_STREAM_LIMIT_POLICY.rawMessageMaxBytes + 1
      }),
    /invalid stream_limits.rawMessageMaxBytes/
  );
  assert.throws(
    () =>
      resolveStreamLimitPolicy({
        rawMessageMaxBytes: 24 * 1024 * 1024,
        adapterQueueItemMaxBytes: 20 * 1024 * 1024
      }),
    /rawMessageMaxBytes exceeds adapterQueueItemMaxBytes/
  );
});

test("managed adapter configuration maps and validates trusted stream_limits", () => {
  const configurations = readAdapterConfigurations("/tmp/runtime-profile", {
    codex: {
      execution: {
        provider_options: {},
        stream_limits: {
          raw_message_max_bytes: 8 * 1024 * 1024,
          adapter_queue_item_max_bytes: 12 * 1024 * 1024
        }
      }
    }
  });
  assert.equal(configurations.codex.streamLimits.rawMessageMaxBytes, 8 * 1024 * 1024);
  assert.equal(configurations.codex.streamLimits.adapterQueueItemMaxBytes, 12 * 1024 * 1024);
  assert.equal(
    configurations.codex.streamLimits.replayGlobalMaxBytes,
    DEFAULT_STREAM_LIMIT_POLICY.replayGlobalMaxBytes
  );
  assert.throws(
    () =>
      readAdapterConfigurations("/tmp/runtime-profile", {
        codex: {
          execution: { provider_options: {}, stream_limits: { unexpected_bytes: 1 } }
        }
      }),
    /stream_limits.unexpected_bytes is unknown/
  );
});

test("capacity failures have stable non-retryable public classifications and safe evidence", () => {
  const cases = [
    ["PROVIDER_MESSAGE_TOO_LARGE", "OH-PRV-4009"],
    ["HOST_FRAME_TOO_LARGE", "OH-ADP-3014"],
    ["STREAM_QUEUE_ITEM_TOO_LARGE", "OH-RUN-2009"],
    ["STREAM_QUEUE_BYTES_EXCEEDED", "OH-RUN-2009"],
    ["STREAM_QUEUE_ITEMS_EXCEEDED", "OH-RUN-2009"]
  ];
  for (const [code, publicCode] of cases) {
    const payload = failurePayload(
      {
        code,
        boundary: "fixture.queue",
        measuredBytes: 101,
        limitBytes: 100,
        secret: "must-not-leak"
      },
      {
        stage: "adapter.invoke",
        defaultDomain: "adapter",
        source: { component: "octo-runtime", adapter: "fixture" }
      }
    );
    assert.equal(payload.failure.code, publicCode);
    assert.equal(payload.failure.reasonCode, code);
    assert.equal(payload.failure.retryable, false);
    assert.deepEqual(payload.failure.params, {
      boundary: "fixture.queue",
      measuredBytes: 101,
      limitBytes: 100
    });
    assert.doesNotMatch(JSON.stringify(payload.failure), /must-not-leak|secret/);
  }
});

test("default HostFrame policy accepts the observed 1.43 MB completion payload", async () => {
  const host = new AdapterHost();
  const text = "x".repeat(1_430_765);
  host.register({
    metadata: {
      type: "large-output",
      agentSources: ["provisioned"],
      protocolSupport: {
        protocol: "large-output.canonical",
        modes: ["canonical"],
        nativeMethods: []
      }
    },
    async *invoke() {
      yield {
        protocolVersion: 2,
        type: "message.update",
        payload: { channel: "final", status: "completed", text }
      };
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    }
  });
  const input = invocationInput(
    invokeRequest({ approvalMode: "full_access" }),
    "canonical",
    "large-output"
  );
  const frames = [];
  for await (const frame of host.invokeFrames(input)) frames.push(frame);
  assert.equal(
    frames.find(
      (frame) => frame.kind === "canonical" && typeof frame.event.payload.text === "string"
    )?.event.payload.text.length,
    text.length
  );
  assert.equal(frames.at(-1).control.state, "completed");
  await host.shutdown();
});

test("HostFrame capacity failures retain their precise control reason", async () => {
  const host = new AdapterHost();
  host.register({
    metadata: {
      type: "oversized-frame",
      agentSources: ["provisioned"],
      protocolSupport: {
        protocol: "oversized-frame.canonical",
        modes: ["canonical"],
        nativeMethods: []
      }
    },
    async *invoke() {
      yield {
        protocolVersion: 2,
        type: "message.update",
        payload: { channel: "final", status: "completed", text: "x".repeat(2048) }
      };
    }
  });
  const input = invocationInput(
    invokeRequest({ approvalMode: "full_access" }),
    "canonical",
    "oversized-frame"
  );
  const frames = [];
  for await (const frame of host.invokeFrames(input, {
    streamLimits: resolveStreamLimitPolicy({
      hostFrameMaxBytes: 1024,
      rpcQueueMaxBytes: 2048,
      replayRunMaxBytes: 2048,
      replayGlobalMaxBytes: 4096
    })
  }))
    frames.push(frame);
  assert.equal(
    frames.find((frame) => frame.kind === "control" && frame.control.type === "error")?.control
      .code,
    "HOST_FRAME_TOO_LARGE"
  );
  assert.equal(frames.at(-1).control.state, "failed");
  await host.shutdown();
});

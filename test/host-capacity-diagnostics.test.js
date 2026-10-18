import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  AdapterHost,
  AdapterHostRpcClient,
  AdapterHostRpcServer
} from "@mininglamp-oss/octo-runtime-adapter-host";
import {
  assertHostControl,
  assertHostFrame,
  canonicalEvents,
  failurePayload,
  invocationInput,
  resolveStreamLimitPolicy,
  streamCapacityError
} from "@mininglamp-oss/octo-runtime-protocol";
import { invokeRequest } from "./runtime-fixture.js";

const runId = `run_${"1".repeat(32)}`;
const diagnosticId = `diag_${"1".repeat(32)}`;
const limits = resolveStreamLimitPolicy({
  hostFrameMaxBytes: 2048,
  rpcQueueMaxBytes: 4096,
  replayRunMaxBytes: 4096,
  replayGlobalMaxBytes: 8192
});

function fixture(mode = "canonical", invoke) {
  const host = new AdapterHost();
  host.register({
    metadata: {
      type: "capacity-fixture",
      agentSources: ["provisioned"],
      protocolSupport: {
        protocol: "capacity-fixture.output",
        modes: [mode],
        nativeMethods: []
      }
    },
    invoke:
      invoke ??
      async function* () {
        if (mode === "native") {
          yield {
            kind: "native",
            messageKind: "notification",
            payload: { output: "private-output".repeat(512) }
          };
        } else {
          yield {
            protocolVersion: 2,
            type: "message.update",
            payload: {
              channel: "final",
              status: "completed",
              text: "private-output".repeat(512)
            }
          };
        }
      }
  });
  const input = invocationInput(
    invokeRequest({ runId, approvalMode: "full_access" }),
    mode,
    "capacity-fixture"
  );
  return { host, input };
}

async function collect(source) {
  const values = [];
  for await (const value of source) values.push(value);
  return values;
}

for (const mode of ["canonical", "native"]) {
  test(`HostFrame ${mode} capacity failures preserve safe diagnostics`, async (context) => {
    const { host, input } = fixture(mode);
    context.after(() => host.shutdown());
    const frames = await collect(host.invokeFrames(input, { streamLimits: limits }));
    for (const frame of frames) assertHostFrame(frame);
    const control = frames.find(
      (frame) => frame.kind === "control" && frame.control.type === "error"
    ).control;
    assert.equal(control.code, "HOST_FRAME_TOO_LARGE");
    assert.equal(control.failure.code, "OH-ADP-3014");
    assert.equal(control.failure.reasonCode, control.code);
    assert.equal(control.failure.diagnosticId, diagnosticId);
    assert.equal(control.failure.retryable, false);
    assert.deepEqual(control.failure.source, {
      component: "octo-runtime",
      adapter: "capacity-fixture"
    });
    assert.equal(control.failure.params.boundary, "adapter_host.frame");
    assert.equal(control.failure.params.limitBytes, limits.hostFrameMaxBytes);
    assert.ok(control.failure.params.measuredBytes > limits.hostFrameMaxBytes);
    assert.ok(Number.isFinite(Date.parse(control.failure.occurredAt)));
    assert.doesNotMatch(JSON.stringify(control), /private-output/);
    assert.equal(frames.at(-1).control.state, "failed");
  });
}

test("HostFrame diagnostics survive RPC and canonical errors without inventing a Provider result", async (context) => {
  const { host, input } = fixture();
  const upstream = new PassThrough();
  const downstream = new PassThrough();
  const server = new AdapterHostRpcServer({ host, output: downstream });
  server.listen(upstream);
  const client = new AdapterHostRpcClient({ input: downstream, output: upstream });
  context.after(async () => {
    client.close();
    upstream.destroy();
    downstream.destroy();
    await host.shutdown();
  });
  const frames = await collect(client.invokeFrames(input, { streamLimits: limits }));
  const failure = frames.find((frame) => frame.kind === "control" && frame.control.type === "error")
    .control.failure;
  const events = [];
  await assert.rejects(collectCanonical(), (error) => {
    assert.equal(error.code, "HOST_FRAME_TOO_LARGE");
    assert.deepEqual(error.failure, failure);
    assert.equal(error.boundary, failure.params.boundary);
    assert.equal(error.measuredBytes, failure.params.measuredBytes);
    assert.equal(error.limitBytes, failure.params.limitBytes);
    const normalized = failurePayload(error, {
      stage: "channel.delivery",
      defaultDomain: "adapter",
      preserveExisting: true
    });
    assert.deepEqual(normalized.failure, failure);
    assert.doesNotMatch(JSON.stringify(error), /private-output/);
    return true;
  });
  assert.equal(
    events.some((event) => ["run.completed", "run.failed", "run.cancelled"].includes(event.type)),
    false
  );

  async function collectCanonical() {
    for await (const event of canonicalEvents(
      (async function* () {
        yield* frames;
      })()
    ))
      events.push(event);
  }
});

test("native capacity errors retain existing failure creation and whitelist measurements", async (context) => {
  const evidence = {
    boundary: "fixture.queue",
    measuredBytes: 4097,
    limitBytes: 4096,
    itemCount: 3,
    limitItems: 2
  };
  const { host, input } = fixture("native", async function* () {
    throw Object.assign(streamCapacityError("STREAM_QUEUE_BYTES_EXCEEDED", evidence), {
      rawOutput: "private-output",
      prompt: "secret-prompt"
    });
  });
  context.after(() => host.shutdown());
  const frames = await collect(host.invokeFrames(input));
  const control = frames.find(
    (frame) => frame.kind === "control" && frame.control.type === "error"
  ).control;
  assertHostControl(control);
  assert.equal(control.failure.code, "OH-RUN-2009");
  assert.equal(control.failure.diagnosticId, diagnosticId);
  assert.deepEqual(control.failure.params, evidence);
  assert.doesNotMatch(JSON.stringify(control), /private-output|secret-prompt|rawOutput|prompt/);
  assert.equal(frames.at(-1).control.state, "failed");
});

test("error control validation accepts legacy errors and rejects unsafe diagnostic metadata", () => {
  const legacy = { type: "error", code: "HOST_FRAME_TOO_LARGE", message: "capacity exceeded" };
  assertHostControl(legacy);
  const failure = failurePayload(
    { code: legacy.code, boundary: "adapter_host.frame", measuredBytes: 2049, limitBytes: 2048 },
    { stage: "adapter_host.frame", defaultDomain: "adapter", runId }
  ).failure;
  assertHostControl({ ...legacy, failure });
  for (const params of [
    { ...failure.params, rawOutput: "private-output" },
    { ...failure.params, measuredBytes: -1 },
    { ...failure.params, limitBytes: 1.5 },
    { ...failure.params, boundary: "secret prompt with spaces" }
  ])
    assert.throws(
      () => assertHostControl({ ...legacy, failure: { ...failure, params } }),
      /HOST_CONTROL_INVALID/
    );
  assert.throws(
    () => assertHostControl({ ...legacy, failure: { ...failure, reasonCode: "PROVIDER_ERROR" } }),
    /HOST_CONTROL_INVALID/
  );
  for (const unsafe of [
    { ...failure, rawOutput: "private-output" },
    { ...failure, source: { ...failure.source, prompt: "secret-prompt" } },
    { ...failure, action: { ...failure.action, rawOutput: "private-output" } },
    { ...failure, cause: { ...failure.cause, rawOutput: "private-output" } }
  ])
    assert.throws(() => assertHostControl({ ...legacy, failure: unsafe }), /HOST_CONTROL_INVALID/);
});

import { preparedFrames, preparedSubmit } from "./runtime-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { AdapterHost, HostRunService } from "@mininglamp-oss/octo-runtime-adapter-host";
import { invokeRequest, waitFor } from "./runtime-fixture.js";
function fixture(invoke, modes = ["canonical"]) {
  const provider = new AdapterHost();
  provider.register({
    metadata: {
      protocolSupport: {
        protocol: "fixture" + ".canonical",
        modes,
        nativeMethods: []
      },
      type: "fixture",
      agentSources: ["provisioned"]
    },
    invoke
  });
  return new HostRunService({
    invoke: provider.invoke,
    invokeFrames: provider.invokeFrames.bind(provider),
    list: async () => provider.list(),
    probe: async () => ({}),
    cancel: async (id, reason) => ({ cancelled: provider.cancel(id, reason) }),
    respondInteraction: provider.respondInteraction.bind(provider),
    respondNative: provider.respondNative.bind(provider)
  });
}
const input = () => invokeRequest({ approvalMode: "full_access" });
test("drain waits for direct invocation streams and closes admission", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const host = fixture(async function* () {
    await gate;
    yield { protocolVersion: 2, type: "run.completed", payload: {} };
  });
  const invocation = (async () => {
    for await (const frame of preparedFrames(host, "fixture", input(), {
      protocolMode: "canonical"
    }))
      void frame;
  })();
  try {
    await waitFor(() => host.status.activeRuns === 1);
    await assert.rejects(host.drain(25), /HOST_DRAIN_TIMEOUT/);
    await assert.rejects(
      preparedSubmit(host, "fixture", input(), { protocolMode: "canonical" }),
      /DAEMON_DRAINING/
    );
    release();
    await invocation;
    assert.deepEqual(await host.drain(1000), { drained: true });
  } finally {
    release();
    await invocation;
    await host.close();
  }
});
test("Host counts pending handshakes toward capacity and releases expired terminal runs", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const host = new HostRunService({
    async *invokeFrames(request) {
      await gate;
      const identity = {
        run_id: request.runId,
        invocation_id: request.invocationId,
        stream_id: request.runId,
        agent_session_id: request.sessionId,
        session_generation: 0,
        protocol_mode: "canonical",
        protocol: "fixture.canonical"
      };
      yield { ...identity, seq: 1, kind: "control", control: { type: "state", state: "accepted" } };
      yield {
        ...identity,
        seq: 2,
        kind: "control",
        control: { type: "state", state: "completed" }
      };
    },
    cancel: async () => ({ cancelled: true })
  });
  t.after(() => host.close());
  const pending = Array.from({ length: 128 }, (_, index) =>
    preparedSubmit(host, "fixture", {
      ...input(),
      runId: `capacity-${index}`,
      invocationId: `invocation-${index}`
    })
  );
  assert.equal(host.status.admittingRuns, 128);
  await assert.rejects(
    preparedSubmit(host, "fixture", { ...input(), runId: "overflow" }),
    /RUN_CAPACITY_EXHAUSTED/
  );
  release();
  await Promise.all(pending);
  await waitFor(() => host.status.activeRuns === 0);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 120_000);
  assert.throws(() => host.get("capacity-0"), /RUN_NOT_AVAILABLE/);
  await preparedSubmit(host, "fixture", { ...input(), runId: "fresh", invocationId: "fresh" });
});
test("local submit retains source frames before subscribe and never executes on replay", async () => {
  let count = 0;
  const host = fixture(async function* () {
    count++;
    yield {
      protocolVersion: 2,
      type: "message.delta",
      payload: {
        text: "summary",
        channel: "analysis",
        exposure: "public_summary",
        provenance: { provider: "fixture", nativeEvent: "reasoning" }
      }
    };
    yield {
      protocolVersion: 2,
      type: "message.delta",
      payload: { text: "answer", channel: "final" }
    };
    yield { protocolVersion: 2, type: "run.completed", payload: {} };
  });
  const request = input(),
    accepted = await preparedSubmit(host, "fixture", request, { protocolMode: "canonical" });
  await waitFor(() => host.get(request.runId).terminal);
  const page = host.read(request.runId, accepted.stream_id, 0);
  assert.deepEqual(
    page.events.map((event) => event.seq),
    Array.from({ length: page.events.length }, (_, index) => index + 1)
  );
  assert.ok(
    page.events.some(
      ({ event }) => event.kind === "canonical" && event.event.payload.text === "summary"
    )
  );
  assert.ok(
    page.events.some(
      ({ event }) => event.kind === "canonical" && event.event.payload.text === "answer"
    )
  );
  assert.equal(page.events.at(-1).event.control.state, "completed");
  assert.equal(page.protocol_mode, "canonical");
  await assert.rejects(
    preparedSubmit(host, "fixture", request, { protocolMode: "canonical" }),
    /RUN_ALREADY_ACCEPTED/
  );
  assert.deepEqual(host.read(request.runId, accepted.stream_id, 1).events, page.events.slice(1));
  assert.equal(count, 1);
  assert.throws(() => host.read(request.runId, "stale", 0), /STREAM_EXPIRED/);
  assert.throws(() => host.read(request.runId, accepted.stream_id, 10000), /STREAM_CURSOR_INVALID/);
  await host.close();
});
test("byte pressure reports a gap while terminal state remains independently queryable", async () => {
  const host = fixture(async function* () {
    for (let i = 0; i < 100; i++)
      yield {
        protocolVersion: 2,
        type: "message.delta",
        payload: { text: "x".repeat(65536), channel: "final" }
      };
    yield { protocolVersion: 2, type: "run.completed", payload: {} };
  });
  const request = input();
  await preparedSubmit(host, "fixture", request, {
    protocolMode: "canonical",
    streamLimits: { hostFrameMaxBytes: 128 * 1024, replayRunMaxBytes: 512 * 1024 }
  });
  await waitFor(() => host.get(request.runId).terminal);
  assert.throws(
    () => host.read(request.runId, undefined, 0),
    (error) => error.message === "STREAM_GAP" && error.data.oldest_seq > 1
  );
  const info = host.get(request.runId);
  assert.equal(info.terminal.control.state, "completed");
  assert.ok(host.read(request.runId, undefined, info.oldest_seq - 1).events.length <= 32);
  const leases = Array.from({ length: 16 }, () => host.acquireSubscription());
  assert.throws(() => host.acquireSubscription(), /STREAM_SUBSCRIBER_LIMIT/);
  leases.forEach((release) => {
    release();
    release();
  });
  host.acquireSubscription()();
  await host.close();
});

test("a lower global replay override does not evict another active adapter run", async () => {
  const host = fixture(async function* () {
    for (let i = 0; i < 80; i++)
      yield {
        protocolVersion: 2,
        type: "message.delta",
        payload: { text: "x".repeat(1024), channel: "final" }
      };
    yield { protocolVersion: 2, type: "run.completed", payload: {} };
  });
  const first = input();
  await preparedSubmit(host, "fixture", first, {
    protocolMode: "canonical",
    streamLimits: {
      hostFrameMaxBytes: 4096,
      rpcQueueMaxBytes: 8192,
      replayRunMaxBytes: 256 * 1024,
      replayGlobalMaxBytes: 256 * 1024
    }
  });
  await waitFor(() => host.get(first.runId).terminal);
  assert.equal(host.get(first.runId).oldest_seq, 1);

  const second = {
    ...input(),
    invocationId: "invoke-low-global",
    runId: "run-low-global"
  };
  await preparedSubmit(host, "fixture", second, {
    protocolMode: "canonical",
    streamLimits: {
      hostFrameMaxBytes: 4096,
      rpcQueueMaxBytes: 8192,
      replayRunMaxBytes: 32 * 1024,
      replayGlobalMaxBytes: 32 * 1024
    }
  });
  await waitFor(() => host.get(second.runId).terminal);
  assert.equal(host.get(first.runId).oldest_seq, 1);
  await host.close();
});
test("unsupported native is rejected before acceptance and never invokes a canonical adapter", async () => {
  let count = 0;
  const host = fixture(async function* () {
    count++;
  });
  await assert.rejects(
    preparedSubmit(host, "fixture", input()),
    (error) => error.code === "PROTOCOL_MODE_UNSUPPORTED"
  );
  assert.throws(() => host.get(input().runId), /RUN_NOT_AVAILABLE/);
  assert.equal(count, 0);
  await host.close();
});

test("native replay retains original payload and source identity without executing or converting again", async () => {
  let count = 0;
  const payload = {
    id: 17,
    error: { code: -32123, message: "provider", data: { future: [1, "raw"] } }
  };
  const host = fixture(
    async function* () {
      count++;
      yield { kind: "native", messageKind: "response", payload };
      yield { kind: "control", control: { type: "state", state: "failed" } };
    },
    ["native"]
  );
  const request = input(),
    accepted = await preparedSubmit(host, "fixture", request);
  await waitFor(() => host.get(request.runId).terminal);
  const first = host.read(request.runId, accepted.stream_id, 0);
  assert.equal(first.protocol_mode, "native");
  assert.deepEqual(
    first.events.find(({ event }) => event.kind === "native").event.payload,
    payload
  );
  assert.deepEqual(host.read(request.runId, accepted.stream_id, 0), first);
  assert.equal(count, 1);
  await host.close();
});

import test from "node:test";
import assert from "node:assert/strict";
import { AdapterHost, HostRunService } from "@mininglamp-oss/octo-harness-adapter-host";
import { invokeRequest, waitFor } from "./agent-work-runtime-fixture.js";
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
      capabilities: [],
      agentSources: ["provisioned"],
      executionFeatures: ["approval.full_access"]
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
    accepted = await host.submit("fixture", request, { protocolMode: "canonical" });
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
    host.submit("fixture", request, { protocolMode: "canonical" }),
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
  await host.submit("fixture", request, { protocolMode: "canonical" });
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
test("unsupported native is rejected before acceptance and never invokes a canonical adapter", async () => {
  let count = 0;
  const host = fixture(async function* () {
    count++;
  });
  await assert.rejects(
    host.submit("fixture", input()),
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
    accepted = await host.submit("fixture", request);
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

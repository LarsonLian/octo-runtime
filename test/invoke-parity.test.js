import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  AdapterHost,
  AdapterHostRpcClient,
  AdapterHostRpcServer
} from "@mininglamp-oss/octo-runtime-adapter-host";
import { waitFor } from "./runtime-fixture.js";

function fixture(t, invoke) {
  const host = new AdapterHost();
  host.register({
    metadata: {
      type: "fixture",
      agentSources: ["provisioned"],
      protocolSupport: { protocol: "fixture", modes: ["native", "canonical"], nativeMethods: [] }
    },
    invoke
  });
  const input = new PassThrough(),
    output = new PassThrough(),
    wire = [];
  input.on("data", (chunk) => wire.push(JSON.parse(chunk.toString())));
  new AdapterHostRpcServer({ host, output }).listen(input);
  const client = new AdapterHostRpcClient({ input: output, output: input });
  t.after(async () => {
    client.close();
    input.destroy();
    output.destroy();
    await host.shutdown();
  });
  return { host, client, wire };
}

const input = (mode = "canonical") => ({
  inputs: [{ type: "text", text: "only this turn" }],
  contexts: {
    schema: "octo.context-envelope/v3",
    items: [
      { namespace: "octo.execution", name: "adapter", payload: { type: "fixture" } },
      { namespace: "octo.security", name: "approval_policy", payload: { mode: "full_access" } }
    ]
  },
  protocol_mode: mode,
  invocationId: "parity-invoke",
  runId: "parity-run",
  sessionId: "parity-session"
});

for (const mode of ["native", "canonical"])
  test(`${mode} local and RPC invocations share input and Host defaults`, async (t) => {
    const received = [];
    const invoke = async function* (request, context) {
      received.push(request);
      if (context.protocolMode === "native")
        yield { kind: "native", messageKind: "notification", payload: { exact: "native" } };
      else
        yield {
          protocolVersion: 2,
          type: "message.delta",
          payload: { channel: "final", text: "answer" }
        };
      if (context.protocolMode === "native")
        yield { kind: "control", control: { type: "state", state: "completed" } };
      else yield { protocolVersion: 2, type: "run.completed", payload: {} };
    };
    const local = fixture(t, invoke),
      remote = fixture(t, invoke),
      value = input(mode),
      before = structuredClone(value);
    const localEvents = [],
      remoteEvents = [];
    for await (const event of local.host.invoke(value)) localEvents.push(event);
    for await (const event of remote.client.invoke(value)) remoteEvents.push(event);
    const { signal: _local, ...localRequest } = received[0];
    const { signal: _remote, ...remoteRequest } = received[1];
    assert.deepEqual(remoteRequest, localRequest);
    assert.equal(remoteRequest.workdir, process.cwd());
    assert.deepEqual(value, before);
    const call = remote.wire.find((message) => message.method === "invoke");
    assert.deepEqual(call.params, { input: value });
    assert.ok(localEvents.length > 0 && remoteEvents.length > 0);
    assert.equal(
      mode === "native" ? remoteEvents.at(-1).control.state : remoteEvents.at(-1).type,
      mode === "native" ? "completed" : "run.completed"
    );
  });

test("local and RPC pre-abort never start a Provider or transmit an invocation", async (t) => {
  let calls = 0;
  const { host, client, wire } = fixture(t, async function* () {
    calls++;
  });
  const controller = new AbortController();
  const reason = new Error("cancelled before execution");
  controller.abort(reason);
  for (const invoke of [host.invoke, client.invoke])
    await assert.rejects(
      invoke(input(), { signal: controller.signal }).next(),
      (error) => error === reason
    );
  assert.equal(calls, 0);
  assert.deepEqual(wire, []);
});

test("local and RPC active signal cancellation reaches Provider and closes the stream", async (t) => {
  for (const route of ["host", "client"]) {
    let started = false,
      stopped = false;
    const handles = fixture(t, async function* (request) {
      started = true;
      await new Promise((resolve) =>
        request.signal.addEventListener("abort", resolve, { once: true })
      );
      stopped = true;
      yield { protocolVersion: 2, type: "run.cancelled", payload: {} };
    });
    const controller = new AbortController();
    const reason = new Error("cancel this invocation");
    const consume = (async () => {
      for await (const event of handles[route].invoke(input(), { signal: controller.signal }))
        void event;
    })();
    const rejected = assert.rejects(consume, (error) => error === reason);
    await waitFor(() => started);
    controller.abort(reason);
    await rejected;
    await waitFor(() => stopped);
    if (route === "client") assert.ok(handles.wire.some((message) => message.method === "cancel"));
  }
});

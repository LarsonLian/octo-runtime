import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { AcpClient, spawnAcpClient } from "../packages/octo-runtime-acp-client/dist/index.js";

function fixture() {
  const child = new EventEmitter();
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: 0,
    signalCode: null
  });
  return { child, client: new AcpClient({ child }) };
}

test("ACP spawn failure rejects only that client; a sibling and later client remain usable", async () => {
  const broken = spawnAcpClient({ command: "/octo-test-missing-provider-R05" });
  const sibling = fixture();
  try {
    const good = sibling.client.request("initialize", {});
    await assert.rejects(broken.initialize(), /ENOENT/);
    sibling.child.stdout.write('{"id":1,"result":{"ok":true}}\n');
    assert.deepEqual(await good, { ok: true });
    await assert.rejects(broken.initialize(), /ENOENT/);
    const later = sibling.client.request("initialize", {});
    sibling.child.stdout.write('{"id":2,"result":{}}\n');
    assert.deepEqual(await later, {});
  } finally {
    await broken.close();
    await sibling.client.close();
  }
});

for (const source of ["child", "stdin", "stdout", "stderr"]) {
  test(`ACP ${source} error fails pending and future requests once, without an unhandled error`, async () => {
    const { child, client } = fixture();
    const failure = new Error("synthetic EPIPE");
    const request = client.request("initialize", {});
    const emitter = source === "child" ? child : child[source];
    emitter.emit("error", failure);
    emitter.emit("error", new Error("secondary error"));
    child.emit("exit", 1, null);
    await assert.rejects(request, (error) => error === failure);
    await assert.rejects(client.request("session/new", {}), (error) => error === failure);
    await assert.rejects(client.prompt("s", "hello").next(), (error) => error === failure);
    await client.close();
  });
}

test(
  "ACP missing executable through Host RPC preserves a concurrent run and later invokes",
  { timeout: 5000 },
  async () => {
    const { spawnAdapterHost } = await import("@mininglamp-oss/octo-runtime-adapter-host");
    const { preparedFrames, invokeRequest } = await import("./runtime-fixture.js");
    const host = await spawnAdapterHost({
      entrypoint: new URL("./fixtures/acp-failure-host.js", import.meta.url).pathname
    });
    const collect = async (type, id, ready = () => {}) => {
      const frames = [];
      for await (const frame of preparedFrames(
        host.client,
        type,
        invokeRequest({
          invocationId: id,
          agentSessionId: id,
          runId: id,
          approvalMode: "full_access"
        }),
        { protocolMode: "canonical" }
      )) {
        frames.push(frame);
        if (frame.event?.type === "message.delta") ready();
      }
      return frames;
    };
    try {
      let ready;
      const started = new Promise((resolve) => {
        ready = resolve;
      });
      const good = collect("healthy", "healthy-1", ready);
      await Promise.race([started, good]);
      const bad = await collect("broken-acp", "bad-1");
      assert.equal(bad.filter((frame) => frame.event?.type === "run.failed").length, 1);
      assert.ok((await good).some((frame) => frame.event?.type === "run.completed"));
      assert.ok(
        (await collect("healthy", "healthy-2")).some(
          (frame) => frame.event?.type === "run.completed"
        )
      );
      assert.equal(host.child.exitCode, null);
    } finally {
      await host.close();
    }
  }
);

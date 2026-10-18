import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AdapterHost,
  AdapterHostRpcClient,
  AdapterHostRpcServer
} from "../packages/octo-runtime-adapter-host/dist/index.js";
import {
  INVOKE_REQUEST_MAX_BYTES,
  assertInvokeRequestSize,
  resolveStreamLimitPolicy
} from "../packages/octo-runtime-protocol/dist/index.js";
import { readBoundedLines } from "../packages/octo-runtime-adapter-sdk/dist/index.js";
import { invokeDaemonRun } from "../packages/octo-runtime-daemon/dist/runtime/run-stream.js";
import { createCodexAdapter } from "../packages/octo-runtime-adapter-codex/dist/index.js";
import { invokeRequest } from "./runtime-fixture.js";
import { fileURLToPath } from "node:url";

const input = () => ({
  inputs: [{ type: "text", text: "test" }],
  contexts: {
    schema: "octo.context-envelope/v3",
    items: [{ namespace: "octo.execution", name: "adapter", payload: { type: "size-fixture" } }]
  },
  approvalMode: "full_access",
  protocol_mode: "canonical",
  invocationId: randomUUID(),
  runId: randomUUID(),
  sessionId: randomUUID()
});

function fixture(t, invoke) {
  const host = new AdapterHost();
  host.register({
    metadata: {
      type: "size-fixture",
      agentSources: ["provisioned"],
      protocolSupport: { protocol: "size-fixture", modes: ["canonical"], nativeMethods: [] }
    },
    invoke:
      invoke ??
      async function* () {
        yield { protocolVersion: 2, type: "run.completed", payload: {} };
      }
  });
  const upstream = new PassThrough(),
    downstream = new PassThrough();
  new AdapterHostRpcServer({ host, output: downstream }).listen(upstream);
  const client = new AdapterHostRpcClient({ input: downstream, output: upstream });
  t.after(async () => {
    client.close();
    upstream.destroy();
    downstream.destroy();
    await host.shutdown();
  });
  return { host, client, upstream, downstream };
}
const collect = async (source) => {
  const events = [];
  for await (const e of source) events.push(e);
  return events;
};

test("RPC full frame accepts exactly 32 MiB and rejects one byte more without writing", async (t) => {
  const { client, upstream } = fixture(t);
  let writes = 0;
  upstream.on("data", () => {
    writes++;
  });
  for (const difference of [-1, 0, 1]) {
    const value = input();
    value.runMetadata = { padding: "" };
    const base = JSON.stringify({
      jsonrpc: "2.0",
      id: "x".repeat(36),
      method: "invoke",
      params: { input: value }
    });
    value.runMetadata.padding = "x".repeat(
      INVOKE_REQUEST_MAX_BYTES - Buffer.byteLength(base) + difference
    );
    const before = writes;
    if (difference > 0) {
      await assert.rejects(collect(client.invoke(value)), /INVOKE_REQUEST_TOO_LARGE/);
      assert.equal(writes, before);
    } else assert.equal((await collect(client.invoke(value))).at(-1).type, "run.completed");
  }
  assert.equal((await collect(client.invoke(input()))).at(-1).type, "run.completed");
});

test("direct Host, daemon sender and trusted environment include all submitted bytes", async (t) => {
  let starts = 0;
  const { host } = fixture(t, async function* () {
    starts++;
  });
  const value = input();
  value.runMetadata = { padding: "x".repeat(INVOKE_REQUEST_MAX_BYTES) };
  await assert.rejects(collect(host.invoke(value)), /INVOKE_REQUEST_TOO_LARGE/);
  await assert.rejects(
    collect(invokeDaemonRun("/path/must-not-connect.sock", value)),
    /INVOKE_REQUEST_TOO_LARGE/
  );
  assert.equal(starts, 0);
  assert.throws(
    () =>
      assertInvokeRequestSize(input(), {
        executionEnvOverrides: {
          env_variables: [{ key: "LARGE_VALUE", value: "x".repeat(INVOKE_REQUEST_MAX_BYTES) }]
        }
      }),
    /INVOKE_REQUEST_TOO_LARGE/
  );
  const image = randomBytes(2 * 1024 * 1024);
  const part = {
    type: "image",
    mimeType: "image/png",
    byteSize: image.length,
    sha256: createHash("sha256").update(image).digest("hex"),
    data: image.toString("base64")
  };
  assert.doesNotThrow(() => assertInvokeRequestSize({ ...input(), inputs: [part] }));
  const images = Array.from({ length: 4 }, () => part);
  const full = { ...input(), inputs: images, freshFallbackModelInputParts: images };
  assert.doesNotThrow(() => assertInvokeRequestSize(full));
  assert.throws(
    () =>
      assertInvokeRequestSize({ ...full, runMetadata: { padding: "x".repeat(11 * 1024 * 1024) } }),
    /INVOKE_REQUEST_TOO_LARGE/
  );
});

test("oversized raw line does not abort an active run or the next invocation", async (t) => {
  let started, finish;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const completed = new Promise((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const { client, upstream } = fixture(t, async function* () {
    if (++calls === 1) {
      started();
      await completed;
    }
    yield { protocolVersion: 2, type: "run.completed", payload: {} };
  });
  const active = collect(client.invoke(input()));
  await ready;
  upstream.write(Buffer.alloc(INVOKE_REQUEST_MAX_BYTES, 120));
  upstream.write("overflow");
  upstream.write("\n");
  finish();
  assert.equal((await active).at(-1).type, "run.completed");
  assert.equal((await collect(client.invoke(input()))).at(-1).type, "run.completed");
});

test("bounded receiver preserves split UTF-8 and recovers after discarded records", () => {
  const stream = new PassThrough(),
    lines = [];
  let overflow = 0;
  const stop = readBoundedLines(stream, 8, {
    onLine: (line) => lines.push(line),
    onTooLarge: () => overflow++,
    onError: (e) => {
      throw e;
    },
    onClose() {}
  });
  const utf8 = Buffer.from("汉字\n12345678\n");
  for (const byte of utf8) stream.write(Buffer.from([byte]));
  stream.write("123456789");
  stream.write(" discarded\nok\n");
  assert.deepEqual(lines, ["汉字", "12345678", "ok"]);
  assert.equal(overflow, 1);
  stop();
});

test("unterminated oversized record has a finite discard timeout", async () => {
  const stream = new PassThrough();
  let error;
  const closed = new Promise((resolve) =>
    readBoundedLines(stream, 8, {
      onLine() {},
      onTooLarge() {},
      onError: (e) => {
        error = e;
      },
      onClose: resolve,
      discardTimeoutMs: 20
    })
  );
  const keepAlive = setTimeout(() => {}, 1000);
  stream.write("x".repeat(9));
  try {
    await closed;
    assert.match(error.message, /RPC_OVERSIZED_RECORD_TIMEOUT/);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("oversized response errors are handled by both input and readline", async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  const client = new AdapterHostRpcClient({ input, output, maximumInputBytes: 512 * 1024 });
  const rejected = assert.rejects(client.request("list"), (error) => {
    assert.match(error.message, /HOST_FRAME_TOO_LARGE/);
    assert.equal(error.boundary, "host.rpc_transport");
    assert.equal(error.measuredBytes, 512 * 1024 + 1);
    assert.equal(error.limitBytes, 512 * 1024);
    return true;
  });
  input.write("x".repeat(512 * 1024 + 1));
  await rejected;
  input.destroy();
  output.destroy();
});

test("Codex canonical accepts bounded image echoes and excludes hydrated resume history", async () => {
  const bytes = randomBytes(2 * 1024 * 1024);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  const image = {
    type: "image",
    mimeType: "image/png",
    data: bytes.toString("base64"),
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
  const adapter = createCodexAdapter({
    command: process.execPath,
    appServerArgs: [
      fileURLToPath(new URL("../test-support/fake-codex-image-echo.mjs", import.meta.url))
    ]
  });
  for (const count of [1, 2, 4]) {
    const images = Array.from({ length: count }, () => image);
    const parts = [{ type: "text", text: "images" }, ...images];
    const events = await collect(
      adapter.invoke(
        invokeRequest({ modelInputParts: parts, freshFallbackModelInputParts: parts }),
        { protocolMode: "canonical" }
      )
    );
    assert.equal(events.at(-1).type, "run.completed");
    assert.ok(Buffer.byteLength(JSON.stringify(events)) < 256 * 1024);
  }
  const resumed = await collect(
    adapter.invoke(invokeRequest({ providerSession: { sessionId: "image-thread" } }), {
      protocolMode: "canonical"
    })
  );
  assert.equal(resumed.at(-1).type, "run.completed");
  const invalid = await collect(
    adapter.invoke(
      invokeRequest({
        modelInputParts: [{ type: "text", text: "oversized-other-content" }, image]
      }),
      {
        protocolMode: "canonical",
        streamLimits: resolveStreamLimitPolicy({ rawMessageMaxBytes: 256 * 1024 })
      }
    )
  );
  assert.equal(invalid.at(-1).type, "run.failed");
  assert.match(invalid.at(-1).payload.message, /PROVIDER_MESSAGE_TOO_LARGE/);
});

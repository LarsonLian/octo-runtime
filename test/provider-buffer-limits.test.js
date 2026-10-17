import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { AcpClient } from "@mininglamp-oss/octo-runtime-acp-client";
import { createZcodeGuiAdapter } from "@mininglamp-oss/octo-runtime-adapter-zcode-gui";
import { invokeRequest } from "./runtime-fixture.js";

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: 0,
    signalCode: null
  });
  return {
    child,
    client: new AcpClient({ child }),
    send: (message) => child.stdout.write(JSON.stringify(message) + "\n")
  };
}
for (const limit of ["count", "bytes"]) {
  test(`ACP ${limit} overflow discards queued events, fails only that client and rejects later input`, async () => {
    const { child, client, send } = fixture();
    const stream = client.prompt("s", "input");
    const first = stream.next();
    const update = {
      method: "session/update",
      params: { sessionId: "s", update: { text: limit === "count" ? "x" : "x".repeat(64 * 1024) } }
    };
    send(update);
    await first;
    for (let i = 0; i < (limit === "count" ? 4097 : 65); i++) send(update);
    await assert.rejects(stream.next(), /STREAM_BUFFER_OVERFLOW/);
    await assert.rejects(client.initialize(), /STREAM_BUFFER_OVERFLOW/);
    assert.equal(child.stdout.listenerCount("data"), 0);
    await client.close();
    const sibling = fixture();
    const request = sibling.client.initialize();
    sibling.send({ id: 1, result: {} });
    assert.deepEqual(await request, {});
    await sibling.client.close();
  });
}

test("ACP bounds an unterminated line before JSON parsing", async () => {
  const { child, client } = fixture();
  const request = client.initialize();
  child.stdout.write("x".repeat(256 * 1024));
  child.stdout.write("x");
  await assert.rejects(request, /STREAM_EVENT_TOO_LARGE/);
  assert.equal(child.stdout.destroyed, true);
  await client.close();
});

test("ACP image prompt permits bounded large RPC echo while retaining event queue limits", async () => {
  const { client, send } = fixture();
  const stream = client.prompt("s", [{ type: "image", mimeType: "image/png", data: "fixture" }]);
  const next = stream.next();
  const rpc = client.request("probe", {});
  send({ id: 2, result: { echo: "x".repeat(300 * 1024) } });
  assert.equal((await rpc).echo.length, 300 * 1024);
  send({ id: 1, result: { stopReason: "end_turn" } });
  assert.equal((await next).value.type, "prompt_result");
  assert.equal((await stream.next()).done, true);
  await client.close();
});

for (const mode of ["count", "bytes", "line", "complete"]) {
  test(
    `ZCode slow consumer: ${mode} retains the true terminal outcome`,
    { timeout: 4000 },
    async () => {
      let child, exited;
      const adapter = createZcodeGuiAdapter({
        spawnFn: (command, args, options) => {
          child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
          exited = once(child, "exit");
          return child;
        },
        command: process.execPath,
        appServerArgs: [
          new URL("../test-support/zcode/fake-zcode-buffer-flood.mjs", import.meta.url).pathname,
          mode
        ]
      });
      const stream = adapter.invoke(
        invokeRequest({ approvalMode: "full_access", signal: AbortSignal.timeout(3000) })
      );
      assert.equal((await stream.next()).value.type, "session.update");
      // 消费者停读，直到容量保护主动关闭 Provider；不靠固定 sleep 制造时序。
      await exited;
      const events = [];
      for await (const event of stream) events.push(event);
      if (mode === "complete") {
        assert.equal(events.filter((event) => event.type === "run.completed").length, 1);
        assert.equal(
          events.some((event) => event.type === "run.failed"),
          false
        );
        return;
      }
      const failures = events.filter((event) => event.type === "run.failed");
      assert.equal(failures.length, 1);
      assert.equal(
        failures[0].payload.code,
        mode === "line" ? "STREAM_EVENT_TOO_LARGE" : "STREAM_BUFFER_OVERFLOW"
      );
      assert.equal(
        events.some((event) => event.type === "run.completed"),
        false
      );
    }
  );
}

test("ACP preserves accepted prompt completion when the process exits before the consumer resumes", async () => {
  const { client, send, child } = fixture();
  const stream = client.prompt("s", "input");
  const first = stream.next();
  send({ method: "session/update", params: { sessionId: "s", update: { text: "answer" } } });
  await first;
  send({ id: 1, result: { stopReason: "end_turn" } });
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("exit", 0, null);
  assert.equal((await stream.next()).value.type, "prompt_result");
  assert.equal((await stream.next()).done, true);
  await client.close();
});

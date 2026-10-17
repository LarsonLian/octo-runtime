import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawnJsonLines } from "../packages/octo-runtime-adapter-sdk/dist/index.js";
import { spawnAcpClient } from "@mininglamp-oss/octo-runtime-acp-client";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
async function ready(path) {
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw new Error("fixture did not become ready");
}

for (const transport of ["ACP", "NDJSON", "Host"])
  for (const mode of transport === "Host"
    ? ["normal"]
    : ["normal", "ignore-term", "parent-exits"]) {
    test(
      `${transport} reaps group after ${mode}; concurrent closes await same cleanup`,
      { skip: process.platform === "win32", timeout: 5000 },
      async () => {
        const directory = await mkdtemp(join(tmpdir(), "octo-review-tree-"));
        const readyPath = join(directory, "ready.json"),
          tickPath = join(directory, "ticks");
        let pids, client, close, stream;
        try {
          const options = {
            command: process.execPath,
            args: [
              new URL("../test-support/fake-owned-process-tree.mjs", import.meta.url).pathname,
              readyPath,
              tickPath,
              mode
            ]
          };
          if (transport === "Host") {
            const { spawnAdapterHost } = await import("@mininglamp-oss/octo-runtime-adapter-host");
            client = await spawnAdapterHost({
              entrypoint: options.args[0],
              env: { ...process.env, OCTO_REVIEW_READY: readyPath, OCTO_REVIEW_TICKS: tickPath }
            });
            close = () => client.close();
          } else if (transport === "ACP") {
            client = spawnAcpClient(options);
            close = () => client.close();
          } else {
            stream = spawnJsonLines({
              ...options,
              parseLine: JSON.parse,
              onSpawn: (cleanup) => {
                close = cleanup;
              }
            });
            await stream.next();
          }
          pids = await ready(readyPath);
          if (mode === "parent-exits") {
            for (let i = 0; i < 100 && alive(pids.parentPid); i++) await delay(10);
            assert.equal(alive(pids.parentPid), false);
          }
          const first = close(),
            second = close();
          assert.equal(first, second);
          await Promise.all([first, second]);
          assert.equal(alive(pids.parentPid), false);
          assert.equal(alive(pids.childPid), false);
          const bytes = (await readFile(tickPath)).length;
          await delay(50);
          assert.equal((await readFile(tickPath)).length, bytes);
          if (stream) await stream.return();
        } finally {
          if (pids)
            for (const pid of [pids.parentPid, pids.childPid])
              if (alive(pid)) process.kill(pid, "SIGKILL");
          if (client) await client.close().catch(() => {});
          await rm(directory, { recursive: true, force: true });
        }
      }
    );
  }

test("cleanup reports timeout instead of success when an owned process cannot be reaped", async () => {
  const { createProcessCleanup } =
    await import("../packages/octo-runtime-adapter-sdk/dist/process-cleanup.js");
  const signals = [];
  const child = {
    pid: 123,
    exitCode: null,
    signalCode: null,
    kill: (signal) => signals.push(signal)
  };
  const close = createProcessCleanup(child, { termGraceMs: 5, killGraceMs: 5 });
  await assert.rejects(close(), { code: "PROCESS_CLEANUP_TIMEOUT" });
  await assert.rejects(close(), { code: "PROCESS_CLEANUP_TIMEOUT" });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test(
  "ZCode completed turn reaps tools even after the provider leader exits",
  { skip: process.platform === "win32", timeout: 5000 },
  async () => {
    const { createZcodeGuiAdapter } =
      await import("@mininglamp-oss/octo-runtime-adapter-zcode-gui");
    const { invokeRequest } = await import("./runtime-fixture.js");
    const directory = await mkdtemp(join(tmpdir(), "octo-zcode-tree-"));
    const readyPath = join(directory, "ready.json"),
      tickPath = join(directory, "ticks");
    let pids;
    try {
      const adapter = createZcodeGuiAdapter({
        command: process.execPath,
        appServerArgs: [
          new URL("../test-support/fake-owned-process-tree.mjs", import.meta.url).pathname,
          readyPath,
          tickPath,
          "zcode"
        ]
      });
      const events = [];
      for await (const event of adapter.invoke(
        invokeRequest({ approvalMode: "full_access", signal: AbortSignal.timeout(4000) })
      ))
        events.push(event);
      pids = await ready(readyPath);
      assert.equal(alive(pids.parentPid), false);
      assert.equal(alive(pids.childPid), false);
      assert.equal(
        events.filter((event) => ["run.completed", "run.failed"].includes(event.type)).length,
        1
      );
    } finally {
      pids ??= await ready(readyPath).catch(() => undefined);
      if (pids)
        for (const pid of [pids.parentPid, pids.childPid])
          if (alive(pid)) process.kill(pid, "SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  }
);

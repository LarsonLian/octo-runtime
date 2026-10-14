import { createHostInvoke as preparedTestInvoke } from "@mininglamp-oss/octo-runtime-protocol";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnAdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";
import { startDaemonServer } from "@mininglamp-oss/octo-runtime-daemon";
import { invokeRequest } from "./runtime-fixture.js";

const entrypoint = resolve("apps/adapter-host/dist/index.js");
const manifest = resolve("test/fixtures/adapters.json");

for (const debug of [undefined, "0", "true", "1"]) {
  test(`Host file logging requires OCTO_RUNTIME_DEBUG=1 (value=${debug})`, async () => {
    const home = await mkdtemp(join(tmpdir(), "oh-debug-"));
    const env = { ...process.env, OCTO_RUNTIME_HOME: home };
    delete env.OCTO_RUNTIME_DEBUG;
    if (debug !== undefined) env.OCTO_RUNTIME_DEBUG = debug;
    let host;
    try {
      host = await spawnAdapterHost({ entrypoint, manifest, env });
      assert.equal(host.child.stdio.length, 3);
      const events = [];
      for await (const event of preparedTestInvoke((...args) => host.client.invokeFrames(...args))("test", invokeRequest({ prompt: "debug-log-fixture", approvalMode: "full_access" }), { protocolMode: "canonical" })) events.push(event);
      assert.equal(events.at(-1).type, "run.completed");
      await host.close();
      if (debug === "1") {
        const path = join(home, "logs/adapter-host.log");
        const records = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
        assert.ok(records.some(record => record.event === "receive" && record.data.includes("debug-log-fixture")));
        assert.ok(records.some(record => record.event === "send" && record.data.includes("run.completed")));
        assert.ok(records.every(record => record.pid === host.child.pid));
        if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
      } else {
        await assert.rejects(stat(join(home, "logs")), { code: "ENOENT" });
      }
    } finally {
      await host?.close();
      await rm(home, { recursive: true, force: true });
    }
  });
}

test("debug logging failure does not prevent Host readiness or invocation", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-debug-failure-"));
  let host;
  try {
    await writeFile(join(home, "logs"), "not a directory");
    host = await spawnAdapterHost({ entrypoint, manifest, env: { ...process.env, OCTO_RUNTIME_HOME: home, OCTO_RUNTIME_DEBUG: "1" } });
    const events = [];
    for await (const event of preparedTestInvoke((...args) => host.client.invokeFrames(...args))("test", invokeRequest({ approvalMode: "full_access" }), { protocolMode: "canonical" })) events.push(event);
    assert.equal(events.at(-1).type, "run.completed");
    assert.match(host.stderr(), /unable to write adapter-host debug log/);
  } finally {
    await host?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("daemon passes the selected Home and debug environment through Host restarts", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-debug-daemon-"));
  const previous = process.env.OCTO_RUNTIME_DEBUG;
  process.env.OCTO_RUNTIME_DEBUG = "1";
  let app;
  try {
    app = await startDaemonServer({ homePath: home, socketPath: join(home, "daemon.sock"),
      homePath: home, hostEntrypoint: entrypoint, manifestPath: manifest,
      adapterHostRestartDelaysMs: [10] });
    const firstPid = app.hostProcess.child.pid;
    app.hostProcess.child.kill("SIGKILL");
    const deadline = Date.now() + 5000;
    while (app.hostProcess.child.pid === firstPid || app.runtime.adapterHost.state !== "ready") {
      if (Date.now() >= deadline) throw new Error("Host did not restart");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const secondPid = app.hostProcess.child.pid;
    assert.equal("observability" in app, false);
    assert.equal("events" in app, false);
    assert.equal("inspectUrl" in app, false);
    await app.close();
    app = undefined;
    const records = (await readFile(join(home, "logs/adapter-host.log"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(records.some(record => record.pid === firstPid));
    assert.ok(records.some(record => record.pid === secondPid));
  } finally {
    await app?.close();
    if (previous === undefined) delete process.env.OCTO_RUNTIME_DEBUG;
    else process.env.OCTO_RUNTIME_DEBUG = previous;
    await rm(home, { recursive: true, force: true });
  }
});

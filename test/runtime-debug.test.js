import { preparedFrames, preparedTestInvoke, invokeRequest } from "./runtime-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnAdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";
import { startDaemonServer } from "@mininglamp-oss/octo-runtime-daemon";

const entrypoint = resolve("packages/octo-runtime-adapter-host/dist/runner.js");
const manifest = resolve("test/fixtures/adapters.json");
const logPath = async (directory) =>
  join(
    directory,
    (await readdir(directory)).find((name) => /^kernel-\d{8}T\d{2}\.log$/.test(name))
  );
async function invoke(host, id = "log-test") {
  const events = [];
  for await (const event of preparedTestInvoke((...args) => preparedFrames(host.client, ...args))(
    "test",
    invokeRequest({
      invocationId: id,
      runId: id,
      prompt: "private-log-fixture",
      approvalMode: "full_access"
    }),
    { protocolMode: "canonical" }
  ))
    events.push(event);
  assert.equal(events.at(-1).type, "run.completed");
}

for (const enabled of [false, true]) {
  test(`F31 Host logging requires an explicit directory (enabled=${enabled})`, async () => {
    const home = await mkdtemp(join(tmpdir(), "oh-metadata-")),
      directory = join(home, "logs");
    let host;
    try {
      host = await spawnAdapterHost({
        entrypoint,
        manifest,
        env: {
          ...process.env,
          OCTO_RUNTIME_HOME: home,
          OCTO_RUNTIME_DEBUG: "1",
          OCTO_RUNTIME_LOGS_DIRECTORY: enabled ? directory : ""
        }
      });
      assert.equal(host.child.stdio.length, 3);
      await invoke(host);
      await host.close();
      if (enabled) {
        const path = await logPath(directory);
        const records = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
        assert.ok(records.some((record) => record.event === "rpc.invoke_received"));
        assert.ok(
          records.some(
            (record) => record.event === "invoke.finished" && record.data.status === "completed"
          )
        );
        assert.doesNotMatch(
          JSON.stringify(records),
          /private-log-fixture|payload|executionEnvOverrides/
        );
        if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
      } else {
        await assert.rejects(stat(directory), { code: "ENOENT" });
      }
    } finally {
      await host?.close();
      await rm(home, { recursive: true, force: true });
    }
  });
}

test("F31 unavailable log directory does not prevent Host readiness or invocation", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-log-failure-"));
  let host;
  try {
    const directory = join(home, "logs");
    await writeFile(directory, "not a directory");
    host = await spawnAdapterHost({
      entrypoint,
      manifest,
      env: {
        ...process.env,
        OCTO_RUNTIME_HOME: home,
        OCTO_RUNTIME_LOGS_DIRECTORY: directory
      }
    });
    await invoke(host);
    await host.close();
    assert.equal(await readFile(directory, "utf8"), "not a directory");
    assert.doesNotMatch(host.stderr(), /private-log-fixture/);
  } finally {
    await host?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("F31 daemon preserves the explicit logging directory across Host restarts", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-log-daemon-"));
  const directory = join(home, "selected-logs");
  let app;
  try {
    app = await startDaemonServer({
      homePath: home,
      socketPath: join(home, "daemon.sock"),
      hostEntrypoint: entrypoint,
      manifestPath: manifest,
      logging: { directory },
      adapterHostRestartDelaysMs: [10]
    });
    await invoke(app.hostProcess, "before-restart");
    const firstPid = app.hostProcess.child.pid;
    app.hostProcess.child.kill("SIGTERM");
    const deadline = Date.now() + 5000;
    while (app.hostProcess.child.pid === firstPid || app.runtime.adapterHost.state !== "ready") {
      if (Date.now() >= deadline) throw new Error("Host did not restart");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await invoke(app.hostProcess, "after-restart");
    await app.close();
    app = undefined;
    const records = (await readFile(await logPath(directory), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    for (const id of ["before-restart", "after-restart"])
      assert.ok(
        records.some(
          (record) => record.event === "invoke.finished" && record.data.invocation_id === id
        ),
        JSON.stringify(records)
      );
    await assert.rejects(stat(join(home, "logs")), { code: "ENOENT" });
  } finally {
    await app?.close();
    await rm(home, { recursive: true, force: true });
  }
});

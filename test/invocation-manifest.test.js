import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InvocationManifest,
  processStartIdentity,
  reapOrphanedInvocationManifest
} from "../packages/octo-runtime-daemon/dist/invocation-manifest.js";

test("invocation manifest persists only process and invocation metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-invocation-manifest-"));
  const path = join(directory, "run", "invocations.json");
  const { manifest, reap } = await InvocationManifest.open(path);
  try {
    assert.deepEqual(reap, { found: false, reaped: false });
    await manifest.setAdapterHost(process.pid, "/test/adapter-host.js");
    await manifest.begin({ invocationId: "invoke-1", runId: "run-1", adapterType: "codex" });
    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.equal(persisted.schemaVersion, 1);
    assert.equal(persisted.daemonPid, process.pid);
    assert.equal(persisted.adapterHost.pid, process.pid);
    assert.deepEqual(Object.keys(persisted.invocations[0]).sort(), ["adapterType", "invocationId", "runId", "startedAt"]);
    assert.doesNotMatch(JSON.stringify(persisted), /prompt|token|secret|providerOptions/);
    await manifest.end("invoke-1");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).invocations, []);
  } finally {
    await manifest.close();
    await assert.rejects(readFile(path, "utf8"), error => error.code === "ENOENT");
    await rm(directory, { recursive: true, force: true });
  }
});

test("orphan reaper requires matching process start identity before killing the process group", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "oh-invocation-orphan-"));
  const path = join(directory, "invocations.json");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  try {
    const started = await processStartIdentity(child.pid);
    assert.ok(started);
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      daemonPid: 2_147_483_646,
      updatedAt: new Date().toISOString(),
      adapterHost: { pid: child.pid, started, entrypoint: "/test/adapter-host.js" },
      invocations: [{ invocationId: "invoke-orphan", runId: "run-orphan", adapterType: "codex", startedAt: new Date().toISOString() }]
    }));
    const result = await reapOrphanedInvocationManifest(path);
    assert.deepEqual(result, { found: true, reaped: true, pid: child.pid });
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => child.once("exit", resolve));
    }
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already reaped. */ }
    await rm(directory, { recursive: true, force: true });
  }
});

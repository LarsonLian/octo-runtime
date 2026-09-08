import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemonServer } from "@mininglamp-oss/octo-harness-daemon-app";

const execute = promisify(execFile);

test("CLI exposes Runtime operations and unified AgentSession/AgentRun inspection only", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "oh-cli-"));
  const app = await startDaemonServer({
    socketPath: join(home, "sockets", "octo-harness-daemon.sock"),
    storePath: join(home, "state.db"),
    manifestPath: join(root, "test/fixtures/adapters.json"),
    hostEntrypoint: join(root, "apps/adapter-host/dist/index.js")
  });
  const cli = async args => JSON.parse((await execute(
    process.execPath, [join(root, "apps/cli/dist/index.js"), ...args],
    { cwd: root, env: { ...process.env, OCTO_HARNESS_HOME: home } }
  )).stdout);
  try {
    const status = await cli(["status"]);
    assert.equal(status.ready, true);
    assert.deepEqual(status.counts, { agentSessions: 0, agentRuns: 0 });
    assert.deepEqual((await cli(["adapter", "list"])).map(adapter => adapter.type), ["test"]);
    assert.deepEqual(await cli(["agent-session", "list"]), []);
    assert.deepEqual(await cli(["agent-run", "list"]), []);
    await assert.rejects(cli(["chat", "create", "--agent", "a-1"]), /unknown command/);
    await assert.rejects(cli(["task", "list"]), /unknown command/);
    await assert.rejects(cli(["trigger", "list"]), /unknown command/);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("CLI explains how to start a missing daemon", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "oh-cli-missing-"));
  try {
    await assert.rejects(execute(
      process.execPath, [join(root, "apps/cli/dist/index.js"), "status"],
      { cwd: root, env: { ...process.env, OCTO_HARNESS_HOME: home } }
    ), /cannot connect to Octo Harness daemon/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

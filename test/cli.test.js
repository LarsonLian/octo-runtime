import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemonServer } from "@orbtex-ai/daemon-app";

const execute = promisify(execFile);

test("CLI drives daemon socket through trigger to terminal run", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "orbtex-cli-test-"));
  const app = await startDaemonServer({
    socketPath: join(home, "daemon.sock"), storePath: join(home, "state.json"),
    manifestPath: join(root, "config/adapters.json"), hostEntrypoint: join(root, "apps/adapter-host/dist/index.js")
  });
  const cli = async args => JSON.parse((await execute(process.execPath, [join(root, "apps/cli/dist/index.js"), ...args], { cwd: root, env: { ...process.env, ORBTEX_HOME: home } })).stdout);
  try {
    assert.equal((await cli(["status"])).ready, true);
    assert.equal((await cli(["--", "status"])).ready, true);
    const agent = await cli(["agent", "create", "--name", "cli-mock", "--adapter", "mock", "--workdir", root]);
    const trigger = await cli(["trigger", "create", "--name", "cli-trigger", "--agent", agent.id, "--title", "T", "--instruction", "Do T"]);
    const ack = await cli(["trigger", "fire", trigger.id, "--event-id", "cli-event-1"]);
    assert.equal(ack.accepted, true);
    const completed = await cli(["run", "wait", ack.runId]);
    assert.equal(completed.run.status, "completed");
    assert.equal(completed.events.at(-1).type, "run.finished");
  } finally {
    await app.close(); await rm(home, { recursive: true, force: true });
  }
});

test("CLI explains how to start a missing daemon", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "orbtex-cli-missing-daemon-"));
  try {
    await assert.rejects(
      execute(process.execPath, [join(root, "apps/cli/dist/index.js"), "status"], {
        cwd: root,
        env: { ...process.env, ORBTEX_HOME: home }
      }),
      error => error.stderr.includes("start it from the repository root with: pnpm daemon")
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

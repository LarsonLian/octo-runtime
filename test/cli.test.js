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

test("CLI drives daemon socket through trigger to terminal run", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "oh-cli-"));
  const app = await startDaemonServer({
    socketPath: join(home, "sockets", "octo-harness-daemon.sock"), storePath: join(home, "state.db"),
    manifestPath: join(root, "test/fixtures/adapters.json"), hostEntrypoint: join(root, "apps/adapter-host/dist/index.js")
  });
  const cli = async args => JSON.parse((await execute(process.execPath, [join(root, "apps/cli/dist/index.js"), ...args], { cwd: root, env: { ...process.env, OCTO_HARNESS_HOME: home } })).stdout);
  try {
    const status = await cli(["status"]);
    assert.equal(status.ready, true);
    assert.equal(status.pid, process.pid);
    assert.equal(status.socketPath, join(home, "sockets", "octo-harness-daemon.sock"));
    assert.equal(status.storePath, join(home, "state.db"));
    assert.equal(status.manifestPath, join(root, "test/fixtures/adapters.json"));
    assert.equal(status.adapterHost.entrypoint, join(root, "apps/adapter-host/dist/index.js"));
    assert.equal(status.adapterHost.pid, app.hostProcess.child.pid);
    assert.deepEqual(status.adapters, ["test"]);
    assert.equal((await cli(["--", "status"])).ready, true);
    const agent = await cli(["agent", "create", "--name", "cli-test", "--adapter", "test", "--workdir", root]);
    const trigger = await cli(["trigger", "create", "--name", "cli-trigger", "--agent", agent.id, "--title", "T", "--instruction", "Do T"]);
    const ack = await cli(["trigger", "fire", trigger.id, "--event-id", "cli-event-1"]);
    assert.equal(ack.accepted, true);
    const completed = await cli(["run", "wait", ack.runId]);
    assert.equal(completed.run.status, "completed");
    assert.equal(completed.events.at(-1).type, "run.finished");

    const chat = await cli(["chat", "create", "--agent", agent.id, "--title", "Follow test"]);
    const followed = await execute(
      process.execPath,
      [join(root, "apps/cli/dist/index.js"), "chat", "send", chat.id, "--prompt", "stream me", "--follow"],
      { cwd: root, env: { ...process.env, OCTO_HARNESS_HOME: home } }
    );
    const frames = followed.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(frames[0].kind, "ack");
    assert.equal(frames[0].result.agent.id, agent.id);
    assert.equal(frames[0].result.agent.adapterType, "test");
    const eventFrames = frames.filter(frame => frame.kind === "event");
    assert.deepEqual(eventFrames.map(frame => frame.event.seq), eventFrames.map((_frame, index) => index + 1));
    assert.equal(eventFrames[0].event.type, "run.queued");
    assert.equal(eventFrames.at(-1).event.type, "run.finished");
    assert.equal(frames.at(-1).kind, "done");
    assert.equal(frames.at(-1).result.run.status, "completed");
  } finally {
    await app.close(); await rm(home, { recursive: true, force: true });
  }
});

test("CLI explains how to start a missing daemon", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "octo-harness-cli-missing-daemon-"));
  try {
    await assert.rejects(
      execute(process.execPath, [join(root, "apps/cli/dist/index.js"), "status"], {
        cwd: root,
        env: { ...process.env, OCTO_HARNESS_HOME: home }
      }),
      error => error.stderr.includes("start it with: octo-harness daemon")
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

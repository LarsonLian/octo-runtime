import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import WebSocket from "ws";
import {
  adapterHostRestartDelayMs,
  startDaemonServer
} from "@mininglamp-oss/octo-harness-daemon-app";
import { waitFor } from "./agent-work-runtime-fixture.js";

const execute = promisify(execFile);
const emptyContext = () => ({ schema: "octo.context-envelope/v3", items: [] });
const defaultContext = () => ({
  schema: "octo.context-envelope/v3",
  items: [ { namespace: "octo.execution", name: "adapter", payload: { type: "test" } }, { namespace: "octo.execution", name: "workspace", payload: { mode: "fixed", path: process.cwd() } }, { namespace: "octo.security", name: "approval_policy", payload: { mode: "full_access" } } ]
});

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
    await assert.rejects(cli(["agent-run", "events", "missing"]), /unknown command/);
    await assert.rejects(cli(["agent-run", "stream", "missing"]), /unknown command/);
    await assert.rejects(cli(["logs", "open"]), /unknown command/);
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

test("CLI command help is local and describes adapter operations", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cli = join(root, "apps/cli/dist/index.js");

  const adapterHelp = await execute(process.execPath, [cli, "adapter", "--help"]);
  assert.match(adapterHelp.stdout, /adapter connect openclaw/);
  assert.doesNotMatch(adapterHelp.stdout, /adapter setup/);
  assert.doesNotMatch(adapterHelp.stdout, /openclaw configure|openclaw init/);
  await assert.rejects(
    execute(process.execPath, [cli, "adapter", "setup", "codex"]),
    /unknown command/
  );
});

async function unusedLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test listener has no TCP port");
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

test("daemon PID file enforces one process per Harness Home and is removed on clean shutdown", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "oh-daemon-pid-"));
  const pidPath = join(home, "octo-daemon.pid");
  const options = {
    homePath: home,
    pidPath,
    socketPath: join(home, "sockets", "octo-harness-daemon.sock"),
    storePath: join(home, "state.db"),
    manifestPath: join(root, "test/fixtures/adapters.json"),
    hostEntrypoint: join(root, "apps/adapter-host/dist/index.js")
  };
  const app = await startDaemonServer(options);
  try {
    assert.equal((await readFile(pidPath, "utf8")).trim(), String(process.pid));
    await assert.rejects(startDaemonServer(options), /already running/);

    const cli = join(root, "apps/cli/dist/index.js");
    const concise = await execute(process.execPath, [cli, "--home", home, "daemon", "run"])
      .then(() => undefined, error => error);
    assert.equal(concise.code, 1);
    assert.match(concise.stderr, /^❌ Octo Harness daemon is already running with pid \d+\n$/);
    assert.doesNotMatch(concise.stderr, /\n\s+at /);

    const verbose = await execute(process.execPath, [cli, "--verbose", "--home", home, "daemon", "run"])
      .then(() => undefined, error => error);
    assert.equal(verbose.code, 1);
    assert.match(verbose.stderr, /Error: Octo Harness daemon is already running with pid \d+/);
    assert.match(verbose.stderr, /\n\s+at /);
  } finally {
    await app.close();
    await assert.rejects(access(pidPath), error => error.code === "ENOENT");
    await rm(home, { recursive: true, force: true });
  }
});

test("adapter-host restart delay follows a capped staircase", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map(attempt => adapterHostRestartDelayMs(attempt)),
    [1_000, 5_000, 10_000, 20_000, 20_000]
  );
});

test("daemon terminalizes in-flight work and restarts adapter-host without exiting", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "oh-host-"));
  const app = await startDaemonServer({
    socketPath: join(home, "sockets", "octo-harness-daemon.sock"),
    storePath: join(home, "state.db"),
    manifestPath: join(root, "test/fixtures/adapters.json"),
    hostEntrypoint: join(root, "apps/adapter-host/dist/index.js"),
    adapterHostRestartDelaysMs: [500, 100, 100, 100]
  });
  try {
    const agent = await app.engine.registerAgent({ agentSource: "provisioned", name: "test", defaultContext: defaultContext() });
    const submitted = await app.daemon.submitAgentRun({
      namespace: "test",
      agentId: agent.id,
      sessionKey: "v1/adapter-host-restart",
      trigger: { kind: "test", occurrenceId: "host-exit-1" },
      input: { prompt: "wait-for-host-exit" },
      context: emptyContext()
    });
    await waitFor(() => app.daemon.status.activeRuns === 1);
    const originalPid = app.hostProcess.child.pid;
    assert.equal(app.hostProcess.child.kill("SIGKILL"), true);
    const terminal = await app.daemon.waitForRun(submitted.runId);
    assert.equal(terminal.run.status, "failed");
    await waitFor(() => app.runtime.adapterHost.state === "restarting");
    const restartingStatus = JSON.parse((await execute(
      process.execPath, [join(root, "apps/cli/dist/index.js"), "status"],
      { cwd: root, env: { ...process.env, OCTO_HARNESS_HOME: home } }
    )).stdout);
    assert.equal(restartingStatus.ready, false);
    assert.equal(restartingStatus.adapterHost.state, "restarting");
    const unavailable = await app.daemon.submitAgentRun({
      namespace: "test",
      agentId: agent.id,
      sessionKey: "v1/adapter-host-restarting",
      trigger: { kind: "test", occurrenceId: "host-exit-2" },
      input: { prompt: "must-fail-while-restarting" },
      context: emptyContext()
    });
    assert.equal((await app.daemon.waitForRun(unavailable.runId)).run.status, "failed");
    await waitFor(() => app.runtime.adapterHost.state === "ready" && app.hostProcess.child.pid !== originalPid);
    assert.equal(app.runtime.adapterHost.restartAttempt, 1);
    assert.deepEqual((await app.hostProcess.client.list()).map(adapter => adapter.type), ["test"]);
    const firstReplacementPid = app.hostProcess.child.pid;
    assert.equal(app.hostProcess.child.kill("SIGKILL"), true);
    await waitFor(() => app.runtime.adapterHost.state === "restarting");
    assert.equal(app.runtime.adapterHost.restartAttempt, 2);
    await waitFor(() => app.runtime.adapterHost.state === "ready" && app.hostProcess.child.pid !== firstReplacementPid);
    assert.equal(app.runtime.adapterHost.restartAttempt, 2);
    const recoveredStatus = JSON.parse((await execute(
      process.execPath, [join(root, "apps/cli/dist/index.js"), "status"],
      { cwd: root, env: { ...process.env, OCTO_HARNESS_HOME: home } }
    )).stdout);
    assert.equal(recoveredStatus.ready, true);
    assert.equal(recoveredStatus.adapterHost.state, "ready");
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("adapter-host readiness timeout advances the restart staircase", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "oh-host-timeout-"));
  const manifestPath = join(home, "adapters.json");
  await writeFile(manifestPath, JSON.stringify({
    version: 1,
    adapters: [{
      type: "test",
      module: join(root, "test/fixtures/test-adapter.js"),
      export: "testAdapter"
    }]
  }));
  const app = await startDaemonServer({
    socketPath: join(home, "d.sock"),
    storePath: join(home, "state.db"),
    manifestPath,
    hostEntrypoint: join(root, "test/fixtures/restart-hanging-adapter-host.js"),
    adapterHostRestartDelaysMs: [10, 10],
    adapterHostReadyTimeoutMs: 500
  });
  try {
    const originalPid = app.hostProcess.child.pid;
    assert.equal(app.hostProcess.child.kill("SIGKILL"), true);
    await waitFor(
      () => app.runtime.adapterHost.state === "ready"
        && app.runtime.adapterHost.restartAttempt === 2
        && app.hostProcess.child.pid !== originalPid,
      3_000
    );
    assert.equal(readFileSync(`${manifestPath}.host-attempt`, "utf8"), "3");
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("daemon close cancels a hung adapter-host replacement handshake", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "oh-host-cancel-"));
  const manifestPath = join(home, "adapters.json");
  await writeFile(manifestPath, JSON.stringify({
    version: 1,
    adapters: [{
      type: "test",
      module: join(root, "test/fixtures/test-adapter.js"),
      export: "testAdapter"
    }]
  }));
  const app = await startDaemonServer({
    socketPath: join(home, "d.sock"),
    storePath: join(home, "state.db"),
    manifestPath,
    hostEntrypoint: join(root, "test/fixtures/restart-hanging-adapter-host.js"),
    adapterHostRestartDelaysMs: [10],
    adapterHostReadyTimeoutMs: 60_000
  });
  let closed = false;
  try {
    assert.equal(app.hostProcess.child.kill("SIGKILL"), true);
    const attemptPath = `${manifestPath}.host-attempt`;
    await waitFor(() => existsSync(attemptPath) && readFileSync(attemptPath, "utf8") === "2");
    const startedAt = Date.now();
    await app.close();
    closed = true;
    assert.ok(Date.now() - startedAt < 1_000, "daemon close waited for host readiness timeout");
  } finally {
    if (!closed) await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

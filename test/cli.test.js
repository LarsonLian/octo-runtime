import { preparedSubmit } from "./runtime-fixture.js";
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
} from "@mininglamp-oss/octo-runtime-daemon-app";
import { waitFor, invokeRequest } from "./runtime-fixture.js";

const execute = promisify(execFile);
const emptyContext = () => ({ schema: "octo.context-envelope/v3", items: [] });
const defaultContext = () => ({
  schema: "octo.context-envelope/v3",
  items: [
    { namespace: "octo.execution", name: "adapter", payload: { type: "test" } },
    {
      namespace: "octo.execution",
      name: "workspace",
      payload: { mode: "fixed", path: process.cwd() }
    },
    { namespace: "octo.security", name: "approval_policy", payload: { mode: "full_access" } }
  ]
});

test("CLI exposes Runtime operations and process-local Run controls", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "oh-cli-"));
  const app = await startDaemonServer({
    socketPath: join(home, "sockets", "octo-runtime-daemon.sock"),
    homePath: home,
    manifestPath: join(root, "test/fixtures/adapters.json"),
    hostEntrypoint: join(root, "packages/octo-runtime-adapter-host/dist/runner.js")
  });
  const cli = async (args) =>
    JSON.parse(
      (
        await execute(process.execPath, [join(root, "apps/cli/dist/index.js"), ...args], {
          cwd: root,
          env: { ...process.env, OCTO_RUNTIME_HOME: home }
        })
      ).stdout
    );
  try {
    const status = await cli(["status"]);
    assert.equal(status.ready, true);
    assert.equal(status.counts, undefined);
    assert.deepEqual(
      (await cli(["adapter", "list"])).map((adapter) => adapter.type),
      ["test"]
    );
    await assert.rejects(cli(["agent-session", "list"]), /unknown command/);
    await assert.rejects(cli(["agent-run", "list"]), /unknown command/);
    await assert.rejects(cli(["agent-run", "events", "missing"]), /unknown command/);
    await assert.rejects(cli(["agent-run", "stream", "missing"]), /unknown command/);
    await assert.rejects(cli(["inspect"]), /unknown command/);
    await assert.rejects(cli(["inspect", "stop"]), /unknown command/);
    await assert.rejects(cli(["events"]), /unknown command/);
    await assert.rejects(cli(["logs"]), /unknown command/);
    await assert.rejects(cli(["logs", "open"]), /unknown command/);
    await assert.rejects(cli(["logs", "path"]), /unknown command/);
    await assert.rejects(cli(["logs", "query"]), /unknown command/);
    await assert.rejects(cli(["diagnostics"]), /unknown command/);
    await assert.rejects(cli(["diagnostics", "bundle"]), /unknown command/);
    await assert.rejects(cli(["chat", "create", "--agent", "a-1"]), /unknown option/);
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
    await assert.rejects(
      execute(process.execPath, [join(root, "apps/cli/dist/index.js"), "status"], {
        cwd: root,
        env: { ...process.env, OCTO_RUNTIME_HOME: home }
      }),
      /cannot connect to Octo Runtime daemon/
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("CLI command help is local and describes adapter operations", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cli = join(root, "apps/cli/dist/index.js");

  for (const group of ["daemon"]) {
    const help = await execute(process.execPath, [cli, group, "--help"]);
    assert.doesNotMatch(help.stdout, /--force|--timeout-ms|--wait-drained/);
  }
  await assert.rejects(execute(process.execPath, [cli, "login"]), /unknown command/);
  const help = await execute(process.execPath, [cli, "--help"]);
  assert.doesNotMatch(help.stdout, /octo-runtime login/);
  for (const option of ["--force", "--timeout-ms=5000", "--wait-drained"]) {
    await assert.rejects(
      execute(process.execPath, [cli, "daemon", "stop", option]),
      /unknown option/
    );
  }

  const adapterHelp = await execute(process.execPath, [cli, "adapter", "--help"]);
  assert.match(adapterHelp.stdout, /Available Commands:\n  list\s+.*\n  probe/);
  assert.doesNotMatch(adapterHelp.stdout, /connect/);
  assert.doesNotMatch(adapterHelp.stdout, /adapter setup/);
  assert.doesNotMatch(adapterHelp.stdout, /openclaw configure|openclaw init/);
  await assert.rejects(
    execute(process.execPath, [cli, "adapter", "setup", "codex"]),
    /unknown command/
  );
});

test("CLI help, version and removed commands never initialize Home or start a daemon", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cli = join(root, "apps/cli/dist/index.js");
  const directory = await mkdtemp(join(tmpdir(), "oh-cli-help-"));
  const home = join(directory, "absent");
  const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  const build = JSON.parse(await readFile(join(root, "apps/cli/dist/build-info.json"), "utf8"));
  const commit = `commit:${build.commit?.slice(0, 12) ?? "unknown"}${build.dirty ? " (dirty)" : ""}`;
  const buildTime = `build:${build.buildTime}`;
  const run = (args) =>
    execute(process.execPath, [cli, "--home", home, ...args], { timeout: 5000, cwd: directory });
  try {
    for (const args of [[], ["--help"], ["-h"], ["help"]]) {
      const { stdout, stderr } = await run(args);
      assert.ok(stdout.startsWith(`Octo Runtime CLI (${version})\n`));
      assert.ok(stdout.includes(`\n${commit}\n`));
      assert.ok(stdout.includes(`\n${buildTime}\n`));
      assert.match(stdout, /Manage the local Agent runtime/);
      assert.match(stdout, /Usage:\n/);
      assert.match(stdout, /Flags:\n/);
      assert.doesNotMatch(stdout, /agent-run|adapter connect|extra status/);
      assert.equal(stderr, "");
      const list = stdout.split("Available Commands:\n")[1].split("\n\n")[0];
      assert.match(list, /\n  playboard\s+[^\n]+$/);
    }
    for (const args of [["--version"], ["-v"], ["version"]]) {
      assert.equal((await run(args)).stdout.trim(), `${version}\n${commit}\n${buildTime}`);
    }
    const daemon = (await run(["daemon"])).stdout;
    assert.equal(daemon, (await run(["daemon", "--help"])).stdout);
    assert.equal(daemon, (await run(["help", "daemon"])).stdout);
    assert.deepEqual(
      [...daemon.matchAll(/^  (start|stop|restart|status|install|uninstall|run)\s/gm)].map(
        (match) => match[1]
      ),
      ["start", "stop", "restart", "status", "install", "uninstall", "run"]
    );
    for (const action of ["start", "stop", "restart", "status", "install", "uninstall", "run"]) {
      assert.match(
        (await run(["daemon", action, "--help"])).stdout,
        new RegExp(`Usage:\\n  octo-runtime daemon ${action}`)
      );
    }
    const playboard = (await run(["playboard", "--help"])).stdout;
    assert.match(playboard, /Examples:/);
    assert.match(playboard, /octo.context-envelope\/v3/);
    assert.match(playboard, /Reference:/);
    for (const args of [
      ["extra", "status"],
      ["extra", "load", "x"],
      ["extra", "unload", "x"],
      ["adapter", "connect", "openclaw"],
      ["agent-run", "get", "x"],
      ["agent-run", "cancel", "x"],
      ["daemon", "missing", "--help"],
      ["help", "missing"]
    ]) {
      await assert.rejects(run(args), /unknown command/);
    }
    for (const args of [
      ["daemon", "--quiet"],
      ["daemon", "start", "--bogus"],
      ["--home"],
      ["status", "extra"]
    ]) {
      await assert.rejects(run(args));
    }
    assert.equal(existsSync(home), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function unusedLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test listener has no TCP port");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

test("daemon PID file enforces one process per Runtime Home and is removed on clean shutdown", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "oh-daemon-pid-"));
  const pidPath = join(home, "octo-daemon.pid");
  const options = {
    homePath: home,
    pidPath,
    socketPath: join(home, "sockets", "octo-runtime-daemon.sock"),
    homePath: home,
    manifestPath: join(root, "test/fixtures/adapters.json"),
    hostEntrypoint: join(root, "packages/octo-runtime-adapter-host/dist/runner.js")
  };
  const app = await startDaemonServer(options);
  try {
    assert.equal((await readFile(pidPath, "utf8")).trim(), String(process.pid));
    await assert.rejects(startDaemonServer(options), /already running/);

    const cli = join(root, "apps/cli/dist/index.js");
    const concise = await execute(process.execPath, [cli, "--home", home, "daemon", "run"]).then(
      () => undefined,
      (error) => error
    );
    assert.equal(concise.code, 1);
    assert.match(concise.stderr, /extras discovered/);
    assert.match(concise.stderr, /❌ Octo Runtime daemon is already running with pid \d+\n$/);
    assert.doesNotMatch(concise.stderr, /\n\s+at /);

    const verbose = await execute(process.execPath, [
      cli,
      "--verbose",
      "--home",
      home,
      "daemon",
      "run"
    ]).then(
      () => undefined,
      (error) => error
    );
    assert.equal(verbose.code, 1);
    assert.match(verbose.stderr, /Error: Octo Runtime daemon is already running with pid \d+/);
    assert.match(verbose.stderr, /\n\s+at /);
  } finally {
    await app.close();
    await assert.rejects(access(pidPath), (error) => error.code === "ENOENT");
    await rm(home, { recursive: true, force: true });
  }
});

test("adapter-host restart delay follows a capped staircase", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((attempt) => adapterHostRestartDelayMs(attempt)),
    [1_000, 5_000, 10_000, 20_000, 20_000]
  );
});

test("daemon terminalizes in-flight work and restarts adapter-host without exiting", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "oh-host-"));
  const app = await startDaemonServer({
    socketPath: join(home, "sockets", "octo-runtime-daemon.sock"),
    homePath: home,
    manifestPath: join(root, "test/fixtures/adapters.json"),
    hostEntrypoint: join(root, "packages/octo-runtime-adapter-host/dist/runner.js"),
    adapterHostRestartDelaysMs: [500, 100, 100, 100]
  });
  try {
    const request = invokeRequest({
      modelInput: "wait-for-host-exit",
      prompt: "wait-for-host-exit",
      approvalMode: "full_access"
    });
    await preparedSubmit(app.host, "test", request, { protocolMode: "canonical" });
    await waitFor(() => app.host.status.activeRuns === 1);
    const originalPid = app.hostProcess.child.pid;
    assert.equal(app.hostProcess.child.kill("SIGKILL"), true);
    await waitFor(() => app.host.get(request.runId).terminal);
    assert.equal(app.host.get(request.runId).terminal.control.state, "lost");
    await waitFor(() => app.runtime.adapterHost.state === "restarting");
    const restartingStatus = JSON.parse(
      (
        await execute(process.execPath, [join(root, "apps/cli/dist/index.js"), "status"], {
          cwd: root,
          env: { ...process.env, OCTO_RUNTIME_HOME: home }
        })
      ).stdout
    );
    assert.equal(restartingStatus.ready, false);
    assert.equal(restartingStatus.adapterHost.state, "restarting");
    await assert.rejects(
      preparedSubmit(
        app.host,
        "test",
        invokeRequest({
          runId: "unavailable",
          invocationId: "unavailable-invocation",
          approvalMode: "full_access"
        }),
        { protocolMode: "canonical" }
      ),
      /restarting/
    );
    await waitFor(
      () => app.runtime.adapterHost.state === "ready" && app.hostProcess.child.pid !== originalPid
    );
    assert.equal(app.runtime.adapterHost.restartAttempt, 1);
    assert.deepEqual(
      (await app.hostProcess.client.list()).map((adapter) => adapter.type),
      ["test"]
    );
    const firstReplacementPid = app.hostProcess.child.pid;
    assert.equal(app.hostProcess.child.kill("SIGKILL"), true);
    await waitFor(() => app.runtime.adapterHost.state === "restarting");
    assert.equal(app.runtime.adapterHost.restartAttempt, 2);
    await waitFor(
      () =>
        app.runtime.adapterHost.state === "ready" &&
        app.hostProcess.child.pid !== firstReplacementPid
    );
    assert.equal(app.runtime.adapterHost.restartAttempt, 2);
    const recoveredStatus = JSON.parse(
      (
        await execute(process.execPath, [join(root, "apps/cli/dist/index.js"), "status"], {
          cwd: root,
          env: { ...process.env, OCTO_RUNTIME_HOME: home }
        })
      ).stdout
    );
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
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      adapters: [
        {
          type: "test",
          module: join(root, "test/fixtures/test-adapter.js"),
          export: "testAdapter"
        }
      ]
    })
  );
  const app = await startDaemonServer({
    socketPath: join(home, "d.sock"),
    homePath: home,
    manifestPath,
    hostEntrypoint: join(root, "test/fixtures/restart-hanging-adapter-host.js"),
    adapterHostRestartDelaysMs: [10, 10],
    adapterHostReadyTimeoutMs: 500
  });
  try {
    const originalPid = app.hostProcess.child.pid;
    assert.equal(app.hostProcess.child.kill("SIGKILL"), true);
    await waitFor(
      () =>
        app.runtime.adapterHost.state === "ready" &&
        app.runtime.adapterHost.restartAttempt === 2 &&
        app.hostProcess.child.pid !== originalPid,
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
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      adapters: [
        {
          type: "test",
          module: join(root, "test/fixtures/test-adapter.js"),
          export: "testAdapter"
        }
      ]
    })
  );
  const app = await startDaemonServer({
    socketPath: join(home, "d.sock"),
    homePath: home,
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

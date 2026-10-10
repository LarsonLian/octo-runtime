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
  LiveEventBus,
  startDaemonServer
} from "@mininglamp-oss/octo-harness-daemon-app";
import { InspectServer } from "../apps/daemon/dist/inspect-server.js";
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

test("CLI command help is local and describes logs versus doctor", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cli = join(root, "apps/cli/dist/index.js");
  const help = await execute(process.execPath, [cli, "logs", "--help"]);
  assert.match(help.stdout, /logs path\|query/);
  assert.doesNotMatch(help.stdout, /\|open/);
  assert.match(help.stdout, /use doctor for service startup failures/i);
  const adapterHelp = await execute(process.execPath, [cli, "adapter", "--help"]);
  assert.match(adapterHelp.stdout, /adapter setup openclaw/);
  assert.match(adapterHelp.stdout, /Only OpenClaw currently needs setup/);
  assert.doesNotMatch(adapterHelp.stdout, /openclaw configure|openclaw init/);
  await assert.rejects(
    execute(process.execPath, [cli, "adapter", "setup", "codex"]),
    /adapter setup is not supported for codex/
  );
});

test("CLI exposes bounded events and daemon-owned loopback inspect", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "oh-events-"));
  const app = await startDaemonServer({
    socketPath: join(home, "sockets", "octo-harness-daemon.sock"),
    storePath: join(home, "state.db"),
    manifestPath: join(root, "test/fixtures/adapters.json"),
    hostEntrypoint: join(root, "apps/adapter-host/dist/index.js")
  });
  const cli = join(root, "apps/cli/dist/index.js");
  try {
    const agent = await app.engine.registerAgent({ agentSource: "provisioned", name: "test", defaultContext: defaultContext() });
    const submitted = await app.daemon.submitAgentRun({
      namespace: "test",
      agentKey: agent.id,
      sessionKey: "v1/events",
      trigger: { kind: "test", occurrenceKey: "events-1" },
      input: { prompt: "emit events" },
      context: emptyContext()
    });
    await app.daemon.waitForRun(submitted.runKey);
    const events = await execute(process.execPath, [cli, "events", "--json"], {
      cwd: root, env: { ...process.env, OCTO_HARNESS_HOME: home }
    });
    const frames = events.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.ok(frames.some(frame => frame.type === "daemon.ready"));
    assert.ok(frames.some(frame => frame.source === "adapter-rpc"));
    assert.ok(frames.some(frame => frame.source === "provider-native"));
    assert.ok(frames.some(frame => frame.source === "adapter-canonical"));
    assert.ok(frames.some(frame => frame.source === "host-canonical"));
    assert.ok(frames.filter(frame => frame.run_key === submitted.runKey).length > 0);

    const inspected = await execute(process.execPath, [cli, "inspect"], {
      cwd: root, env: { ...process.env, OCTO_HARNESS_HOME: home }
    });
    await assert.rejects(
      execute(process.execPath, [cli, "inspect", "url"], {
        cwd: root, env: { ...process.env, OCTO_HARNESS_HOME: home }
      }),
      /unknown command/
    );
    await assert.rejects(
      execute(process.execPath, [cli, "inspect", "--no-open"], {
        cwd: root, env: { ...process.env, OCTO_HARNESS_HOME: home }
      }),
      /unknown command/
    );
    const inspectedAgain = await Promise.all([
      execute(process.execPath, [cli, "inspect"], { cwd: root, env: { ...process.env, OCTO_HARNESS_HOME: home } }),
      execute(process.execPath, [cli, "inspect"], { cwd: root, env: { ...process.env, OCTO_HARNESS_HOME: home } })
    ]);
    assert.ok(inspectedAgain.every(result => result.stdout.trim() === inspected.stdout.trim()));
    const url = new URL(inspected.stdout.trim());
    assert.equal(url.hostname, "127.0.0.1");
    assert.ok(Number(url.port) > 20_000);
    assert.ok((url.searchParams.get("token") ?? "").length > 10);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /id="root"/);
    const scriptPath = html.match(/src="([^"]+\.js)"/)?.[1];
    assert.ok(scriptPath);
    const scriptResponse = await fetch(new URL(scriptPath, url));
    assert.equal(scriptResponse.status, 200);
    assert.match(scriptResponse.headers.get("content-type") ?? "", /javascript/);
    assert.match(scriptResponse.headers.get("cache-control") ?? "", /immutable/);
    const helpResponse = await fetch(new URL("/help", url));
    assert.equal(helpResponse.status, 200);
    assert.match(await helpResponse.text(), /id="root"/);
    const token = url.searchParams.get("token");
    assert.ok(token);
    const logsUrl = new URL("/api/logs", url);
    assert.equal((await fetch(logsUrl)).status, 401);
    const logsResponse = await fetch(logsUrl, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(logsResponse.status, 200);
    assert.ok(Array.isArray(await logsResponse.json()));
    const diagnosticsUrl = new URL("/api/diagnostics", url);
    assert.equal((await fetch(diagnosticsUrl)).status, 401);
    const diagnosticsResponse = await fetch(diagnosticsUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(diagnosticsResponse.status, 200);
    const diagnostics = await diagnosticsResponse.json();
    assert.equal(diagnostics.schema, "octo-harness.diagnostic-bundle/v1");
    assert.equal(diagnostics.dataClass, "metadata_only");
    const cliDiagnostics = JSON.parse((await execute(process.execPath, [cli, "diagnostics"], {
      cwd: root, env: { ...process.env, OCTO_HARNESS_HOME: home }
    })).stdout);
    assert.equal(cliDiagnostics.schema, "octo-harness.diagnostic-bundle/v1");
    const metricsUrl = new URL("/api/metrics", url);
    assert.equal((await fetch(metricsUrl)).status, 401);
    const metricsResponse = await fetch(metricsUrl, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(metricsResponse.status, 200);
    assert.match(await metricsResponse.text(), /octo_harness_runtime_connection_state/);
    const wsUrl = new URL("/events", url);
    wsUrl.protocol = "ws:";
    wsUrl.searchParams.set("token", token);
    const client = new WebSocket(wsUrl, { origin: url.origin });
    const message = await new Promise((resolve, reject) => {
      client.once("message", value => resolve(JSON.parse(value.toString())));
      client.once("error", reject);
    });
    assert.equal(message.kind, "status");
    client.close();
    await waitFor(() => app.events.stats.subscribers === 0);

    const forbidden = new WebSocket(wsUrl, { origin: "http://127.0.0.1:1" });
    const statusCode = await new Promise((resolve, reject) => {
      forbidden.once("unexpected-response", (_request, invalid) => resolve(invalid.statusCode));
      forbidden.once("open", () => reject(new Error("invalid origin opened inspect websocket")));
      forbidden.once("error", () => undefined);
    });
    assert.equal(statusCode, 403);

    const invalidTokenUrl = new URL(wsUrl);
    invalidTokenUrl.searchParams.set("token", "invalid");
    const invalidToken = new WebSocket(invalidTokenUrl, { origin: url.origin });
    const closeCode = await new Promise((resolve, reject) => {
      invalidToken.once("close", resolve);
      invalidToken.once("error", reject);
    });
    assert.equal(closeCode, 4401);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("inspect honors an explicit wildcard host and fixed port", async () => {
  const port = await unusedLoopbackPort();
  const inspect = new InspectServer(
    new LiveEventBus(),
    () => ({ ready: true }),
    async () => [{ message: "x".repeat(3 * 1024 * 1024) }],
    {
    host: "0.0.0.0",
    port
    }
  );
  try {
    const advertised = new URL((await inspect.start()).url);
    assert.equal(advertised.hostname, "0.0.0.0");
    assert.equal(Number(advertised.port), port);
    advertised.hostname = "127.0.0.1";
    assert.equal((await fetch(advertised)).status, 200);
    const token = advertised.searchParams.get("token");
    assert.ok(token);
    const logs = await fetch(new URL("/api/logs", advertised), {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(logs.headers.get("x-octo-truncated"), "true");
    assert.deepEqual(await logs.json(), []);
  } finally {
    await inspect.close();
  }
});

test("inspect permits only one log query at a time", async () => {
  let releaseLogs;
  const waiting = new Promise(resolve => { releaseLogs = resolve; });
  let queryStarted;
  const started = new Promise(resolve => { queryStarted = resolve; });
  const inspect = new InspectServer(
    new LiveEventBus(),
    () => ({ ready: true }),
    async () => {
      queryStarted();
      await waiting;
      return [];
    }
  );
  try {
    const advertised = new URL((await inspect.start()).url);
    const token = advertised.searchParams.get("token");
    assert.ok(token);
    const logsUrl = new URL("/api/logs", advertised);
    const first = fetch(logsUrl, { headers: { Authorization: `Bearer ${token}` } });
    await started;
    const second = await fetch(logsUrl, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(second.status, 429);
    assert.equal(second.headers.get("retry-after"), "1");
    releaseLogs();
    assert.equal((await first).status, 200);
  } finally {
    releaseLogs?.();
    await inspect.close();
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
      agentKey: agent.id,
      sessionKey: "v1/adapter-host-restart",
      trigger: { kind: "test", occurrenceKey: "host-exit-1" },
      input: { prompt: "wait-for-host-exit" },
      context: emptyContext()
    });
    await waitFor(() => app.daemon.status.activeRuns === 1);
    const originalPid = app.hostProcess.child.pid;
    assert.equal(app.hostProcess.child.kill("SIGKILL"), true);
    const terminal = await app.daemon.waitForRun(submitted.runKey);
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
      agentKey: agent.id,
      sessionKey: "v1/adapter-host-restarting",
      trigger: { kind: "test", occurrenceKey: "host-exit-2" },
      input: { prompt: "must-fail-while-restarting" },
      context: emptyContext()
    });
    assert.equal((await app.daemon.waitForRun(unavailable.runKey)).run.status, "failed");
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

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  daemonRuntimeArguments,
  resolveDaemonRuntimePaths
} from "../apps/daemon/dist/runtime-options.js";

const unmanagedHome = resolve(".tmp/runtime-options-unmanaged-home");

async function writeManagedRuntime(home) {
  const profileRoot = join(home, "profiles", "default");
  await mkdir(profileRoot, { recursive: true });
  await mkdir(join(home, "identity"), { recursive: true });
  await mkdir(join(home, "credentials"), { recursive: true });
  await writeFile(join(home, "config.json"), JSON.stringify({
    schema_version: 1,
    default_profile: "default",
    enabled_profiles: ["default"],
    channel: "stable"
  }));
  await writeFile(join(profileRoot, "config.json"), JSON.stringify({
    schema_version: 1,
    profile: "default",
    server_url: "https://server.example",
    agent_work_url: "https://worker.example",
    runtime_name: "runtime default"
  }));
  await writeFile(join(home, "identity/runtime.json"), JSON.stringify({
    schema_version: 1,
    runtime_id: "runtime-default",
    credential_id: "credential-default",
    system_id: "system-default",
    enrolled_at: new Date().toISOString()
  }));
  await writeFile(join(home, "credentials/runtime-token.json"), JSON.stringify({
    schema_version: 1,
    access_token: "device-token-default",
    issued_at: new Date().toISOString()
  }));
}

test("daemon runtime options resolve environment defaults to absolute paths", () => {
  const home = resolve(".tmp/runtime-home");
  const paths = resolveDaemonRuntimePaths([], { OCTO_HARNESS_HOME: home });

  assert.equal(paths.socketPath, `${home}/sockets/octo-harness-daemon.sock`);
  assert.equal(paths.storePath, `${home}/state.db`);
  assert.equal(paths.manifestPath, resolve("config/adapters.json"));
  assert.equal(paths.hostEntrypoint, resolve("apps/adapter-host/dist/index.js"));
  assert.equal(paths.logging.directory, `${home}/logs`);
  assert.equal(paths.logging.fileLog, true);
});

test("daemon runtime keeps all local paths under one supplied Harness Home", () => {
  const paths = resolveDaemonRuntimePaths(["--home", unmanagedHome], {});

  assert.equal(paths.socketPath, resolve(unmanagedHome, "sockets/octo-harness-daemon.sock"));
  assert.equal(paths.storePath, resolve(unmanagedHome, "state.db"));
});

test("daemon runtime argv uses explicit options and normalizes the legacy host alias", () => {
  const paths = resolveDaemonRuntimePaths([
    "--socket", "runtime/custom.sock",
    "--store", "runtime/custom.json",
    "--manifest", "runtime/adapters.json",
    "--host-entrypoint", "runtime/host.js"
  ], {
    OCTO_HARNESS_HOME: "ignored",
    OCTO_HARNESS_ADAPTER_HOST: "ignored-host.js"
  });

  assert.deepEqual(daemonRuntimeArguments(paths), [
    "--home", resolve("ignored"),
    "--pid-file", resolve("ignored/octo-daemon.pid"),
    "--socket", resolve("runtime/custom.sock"),
    "--store", resolve("runtime/custom.json"),
    "--manifest", resolve("runtime/adapters.json"),
    "--adapter-host", resolve("runtime/host.js"),
    "--log-dir", resolve("ignored/logs"),
    "--log-level", "info",
    "--log-retention-days", "14",
    "--trace-retention-days", "3",
    "--crash-retention-days", "30",
    "--log-max-file-bytes", String(64 * 1024 * 1024),
    "--log-max-total-bytes", String(1024 * 1024 * 1024)
  ]);
});

test("verbose is an atomic preset for debug, RPC tracing and full provider capture", () => {
  const paths = resolveDaemonRuntimePaths([
    "--verbose",
    "--require-provider-capture",
    "--log-dir", ".tmp/verbose-logs"
  ], { OCTO_HARNESS_HOME: unmanagedHome });

  assert.equal(paths.logging.logLevel, "debug");
  assert.equal(paths.logging.verbose, true);
  assert.equal(paths.logging.traceRpc, true);
  assert.equal(paths.logging.captureProviderIo, "full");
  assert.equal(paths.logging.requireProviderCapture, true);
  assert.equal(paths.logging.directory, resolve(".tmp/verbose-logs"));
  const args = daemonRuntimeArguments(paths);
  assert.ok(args.includes("--verbose"));
  assert.ok(args.includes("--require-provider-capture"));
});

test("logging options reject contradictory or non-durable capture configurations", () => {
  assert.throws(
    () => resolveDaemonRuntimePaths(["--verbose", "--log-level", "info"], { OCTO_HARNESS_HOME: unmanagedHome }),
    /verbose conflicts/
  );
  assert.throws(
    () => resolveDaemonRuntimePaths(["--verbose", "--capture-provider-io", "input"], { OCTO_HARNESS_HOME: unmanagedHome }),
    /verbose conflicts/
  );
  assert.throws(
    () => resolveDaemonRuntimePaths(["--require-provider-capture"], { OCTO_HARNESS_HOME: unmanagedHome }),
    /requires --capture-provider-io/
  );
  assert.throws(
    () => resolveDaemonRuntimePaths(["--no-file-log", "--trace-rpc"], { OCTO_HARNESS_HOME: unmanagedHome }),
    /cannot be combined/
  );
});

test("Agent Work runtime mode is opt-in and rejects environment credentials", () => {
  const home = resolve(".tmp/runtime-home");
  assert.equal(resolveDaemonRuntimePaths([], { OCTO_HARNESS_HOME: home }).agentWork, undefined);
  assert.throws(
    () => resolveDaemonRuntimePaths([], {
      OCTO_HARNESS_HOME: home,
      OCTO_HARNESS_AGENT_WORK_URL: "http://127.0.0.1:8092",
      OCTO_HARNESS_AGENT_WORK_RUNTIME_TOKEN: "environment-token-must-be-ignored"
    }),
    /credential is missing from the managed Harness Home/
  );
});

test("managed Runtime binding ignores process-level endpoint and identity overrides", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-managed-overrides-"));
  try {
    await writeManagedRuntime(home);
    const paths = resolveDaemonRuntimePaths([
      "--home", home,
      "--agent-work-url", "http://127.0.0.1:9092",
      "--agent-work-runtime-id", "runtime-from-flag",
      "--agent-work-runtime-name", "linked-runtime",
      "--agent-work-fingerprint", "linked:fingerprint"
    ], { OCTO_HARNESS_AGENT_WORK_URL: "http://ignored:8092" });

    assert.equal(paths.agentWork.baseUrl, "https://worker.example");
    assert.equal(paths.agentWork.token, "device-token-default");
    assert.equal(paths.agentWork.runtimeId, "runtime-default");
    assert.equal(paths.agentWork.runtimeName, "linked-runtime");
    assert.equal(paths.agentWork.fingerprint, "system-default");
    const args = daemonRuntimeArguments(paths);
    assert.ok(args.includes("--agent-work-url"));
    assert.ok(args.includes("https://worker.example"));
    assert.ok(!args.includes("http://127.0.0.1:9092"));
    assert.ok(!args.includes("device-token-default"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Agent Work reconnect timing is configurable and survives launcher argv serialization", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-managed-reconnect-"));
  try {
    await writeManagedRuntime(home);
    const paths = resolveDaemonRuntimePaths([
      "--home", home,
      "--agent-work-reconnect-first-ms", "750",
      "--agent-work-reconnect-min-ms", "15000"
    ], { OCTO_HARNESS_AGENT_WORK_RECONNECT_MAX_MS: "45000" });

    assert.equal(paths.agentWork.reconnectFirstMs, 750);
    assert.equal(paths.agentWork.reconnectMs, 15_000);
    assert.equal(paths.agentWork.reconnectMaxMs, 45_000);
    const args = daemonRuntimeArguments(paths);
    assert.deepEqual(args.slice(args.indexOf("--agent-work-reconnect-first-ms")), [
      "--agent-work-reconnect-first-ms", "750",
      "--agent-work-reconnect-min-ms", "15000",
      "--agent-work-reconnect-max-ms", "45000"
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("channel context rollout flags are independent and use a separate database", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-managed-context-"));
  try {
    await writeManagedRuntime(home);
    const paths = resolveDaemonRuntimePaths([
    "--home", home,
    "--channel-context-store", "sqlite",
    "--channel-context-projection", "delta",
    "--channel-context-provider-persistence", "append_only",
    "--channel-context-db", ".tmp/channel-context-custom.db",
    "--channel-context-snapshot-retention-ms", "604800000",
    "--channel-context-active-snapshot-timeout-ms", "86400000",
    "--channel-context-max-projected-messages", "25"
    ], {});
    assert.deepEqual(paths.agentWork.channelContext, {
      store: "sqlite",
      projection: "delta",
      providerPersistence: "append_only",
      storePath: resolve(".tmp/channel-context-custom.db"),
      snapshotRetentionMs: 604800000,
      activeSnapshotTimeoutMs: 86400000,
      maxProjectedMessages: 25
    });
    const args = daemonRuntimeArguments(paths);
    assert.equal(args[args.indexOf("--channel-context-store") + 1], "sqlite");
    assert.equal(args[args.indexOf("--channel-context-snapshot-retention-ms") + 1], "604800000");
    assert.equal(args[args.indexOf("--channel-context-active-snapshot-timeout-ms") + 1], "86400000");
    assert.equal(args[args.indexOf("--channel-context-max-projected-messages") + 1], "25");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("managed Home loads exactly one Runtime without putting its credential in argv", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-managed-profiles-"));
  try {
    await writeFile(join(home, "config.json"), JSON.stringify({
      schema_version: 1,
      default_profile: "default",
      enabled_profiles: ["default"],
      channel: "stable"
    }));
    await writeManagedRuntime(home);

    const paths = resolveDaemonRuntimePaths(["--home", home], {});
    assert.deepEqual(
      [paths.agentWork.profile, paths.agentWork.runtimeId, paths.agentWork.fingerprint],
      ["default", "runtime-default", "system-default"]
    );
    const args = daemonRuntimeArguments(paths);
    assert.ok(!args.includes("device-token-default"));
    assert.deepEqual(args.slice(0, 2), ["--home", home]);

    assert.throws(
      () => resolveDaemonRuntimePaths(["--home", home, "--profile", "work"], {}),
      /managed profile work is not enabled/
    );

    await writeFile(join(home, "config.json"), JSON.stringify({
      schema_version: 1,
      default_profile: "default",
      enabled_profiles: ["default", "work"],
      channel: "stable"
    }));
    assert.throws(
      () => resolveDaemonRuntimePaths(["--home", home], {}),
      /exactly one enabled profile/
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

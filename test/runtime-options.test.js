import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  daemonRuntimeArguments,
  resolveDaemonRuntimePaths
} from "../apps/daemon/dist/runtime-options.js";

const unmanagedHome = resolve(".tmp/runtime-options-unmanaged-home");

async function writeManagedRuntime(home, profile = "default") {
  const profileRoot = join(home, profile);
  await mkdir(join(profileRoot, "identity"), { recursive: true });
  await mkdir(join(profileRoot, "credentials"), { recursive: true });
  if (profile === "default") await writeFile(join(home, "config.json"), JSON.stringify({
    schema_version: 1,
    default_profile: "default",
    channel: "stable"
  }));
  await writeFile(join(profileRoot, "config.json"), JSON.stringify({
    schema_version: 1,
    profile,
    server_url: "https://server.example",
    agent_work_url: "https://worker.example",
    runtime_name: `runtime ${profile}`
  }));
  await writeFile(join(profileRoot, "identity/runtime.json"), JSON.stringify({
    schema_version: 1,
    runtime_id: `runtime-${profile}`,
    profile,
    credential_id: `credential-${profile}`,
    enrolled_at: new Date().toISOString()
  }));
  await writeFile(join(profileRoot, "credentials/runtime-token.json"), JSON.stringify({
    schema_version: 1,
    access_token: `device-token-${profile}`,
    issued_at: new Date().toISOString()
  }));
}

test("managed Runtime requires the bound profile and discovers 128-character names", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-managed-profile-binding-"));
  const profile = "a".repeat(128);
  try {
    await writeManagedRuntime(home);
    await writeManagedRuntime(home, profile);
    assert.deepEqual(resolveDaemonRuntimePaths(["--home", home], {}).agentWorks.map(runtime => runtime.profile), ["default", profile]);
    for (const wrong of [undefined, "other"]) {
      await writeFile(join(home, profile, "identity/runtime.json"), JSON.stringify({ schema_version: 1, runtime_id: "runtime_fixture", profile: wrong }));
      assert.throws(() => resolveDaemonRuntimePaths(["--home", home], {}), /managed Runtime identity.*invalid/);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("managed Runtime passes only its connection root, never Gateway credentials or an Agent target", async t => {
  const home = await mkdtemp(join(tmpdir(), "oh-managed-openclaw-"));
  t.after(() => rm(home, {recursive:true,force:true}));
  await writeManagedRuntime(home);
  const paths = resolveDaemonRuntimePaths(["--home",home], {});
  assert.deepEqual(paths.agentWorks[0].adapterConfigurations.openclaw, {providerOptions:{OPENCLAW_RUNTIME_ROOT:join(home,"default")}});
  assert.equal(daemonRuntimeArguments(paths).some(value=>value.includes("TOKEN")),false);
});

test("daemon runtime options resolve environment defaults to absolute paths", () => {
  const home = resolve(".tmp/runtime-home");
  const paths = resolveDaemonRuntimePaths([], { OCTO_RUNTIME_HOME: home });

  assert.equal(paths.socketPath, `${home}/sockets/octo-runtime-daemon.sock`);
  assert.equal(Object.hasOwn(paths, "storePath"), false);
  assert.equal(paths.manifestPath, resolve("config/adapters.json"));
  assert.equal(paths.hostEntrypoint, resolve("apps/adapter-host/dist/index.js"));
});

test("daemon runtime keeps all local paths under one supplied Runtime Home", () => {
  const paths = resolveDaemonRuntimePaths(["--home", unmanagedHome], {});

  assert.equal(paths.socketPath, resolve(unmanagedHome, "sockets/octo-runtime-daemon.sock"));
  assert.equal(Object.hasOwn(paths, "storePath"), false);
});

test("foreground console output survives launcher argv serialization", () => {
  const paths = resolveDaemonRuntimePaths(["--home", unmanagedHome, "--console"], {});

  assert.equal(paths.consoleOutput, true);
  assert.ok(daemonRuntimeArguments(paths).includes("--console"));
});

test("daemon runtime argv uses explicit options and normalizes the legacy host alias", () => {
  const paths = resolveDaemonRuntimePaths([
    "--socket", "runtime/custom.sock",
    "--manifest", "runtime/adapters.json",
    "--host-entrypoint", "runtime/host.js"
  ], {
    OCTO_RUNTIME_HOME: "ignored",
    OCTO_RUNTIME_ADAPTER_HOST: "ignored-host.js"
  });

  assert.deepEqual(daemonRuntimeArguments(paths), [
    "--home", resolve("ignored"),
    "--pid-file", resolve("ignored/octo-daemon.pid"),
    "--socket", resolve("runtime/custom.sock"),
    "--manifest", resolve("runtime/adapters.json"),
    "--adapter-host", resolve("runtime/host.js"),

  ]);
});

test("Agent Work runtime mode is opt-in and rejects environment credentials", () => {
  const home = resolve(".tmp/runtime-home");
  assert.equal(resolveDaemonRuntimePaths([], { OCTO_RUNTIME_HOME: home }).agentWork, undefined);
  assert.throws(
    () => resolveDaemonRuntimePaths([], {
      OCTO_RUNTIME_HOME: home,
      OCTO_RUNTIME_AGENT_WORK_URL: "http://127.0.0.1:8092",
      OCTO_RUNTIME_AGENT_WORK_RUNTIME_TOKEN: "environment-token-must-be-ignored"
    }),
    /credential is missing from the managed Runtime Home/
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
    ], { OCTO_RUNTIME_AGENT_WORK_URL: "http://ignored:8092" });

    const runtime = paths.agentWorks[0];
    assert.equal(runtime.baseUrl, "https://worker.example");
    assert.equal(runtime.token, "device-token-default");
    assert.equal(runtime.runtimeId, "runtime-default");
    assert.equal(runtime.runtimeName, "linked-runtime");
    assert.equal("fingerprint" in runtime, false);
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
    ], { OCTO_RUNTIME_AGENT_WORK_RECONNECT_MAX_MS: "45000" });

    assert.equal(paths.agentWorks[0].reconnectFirstMs, 750);
    assert.equal(paths.agentWorks[0].reconnectMs, 15_000);
    assert.equal(paths.agentWorks[0].reconnectMaxMs, 45_000);
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

test("managed Home discovers multiple profile Runtimes without putting credentials in argv", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-managed-profiles-"));
  try {
    await writeManagedRuntime(home);
    await writeManagedRuntime(home, "work");

    const paths = resolveDaemonRuntimePaths([
      "--home", home,
      "--agent-work-runtime-name", "shared machine runtime",
      "--agent-work-reconnect-first-ms", "725",
      "--agent-work-max-concurrent-runs", "5",
      "--agent-work-minimum-free-bytes", "1048576",
      "--agent-work-disk-check-ms", "15000"
    ], {});
    assert.deepEqual(
      paths.agentWorks.map(runtime => [runtime.profile, runtime.runtimeId]),
      [
        ["default", "runtime-default"],
        ["work", "runtime-work"]
      ]
    );
    const args = daemonRuntimeArguments(paths);
    assert.ok(!args.includes("device-token-default"));
    assert.ok(!args.includes("device-token-work"));
    assert.deepEqual(args.slice(0, 2), ["--home", home]);
    assert.equal(args[args.indexOf("--agent-work-runtime-name") + 1], "shared machine runtime");
    assert.equal(args[args.indexOf("--agent-work-reconnect-first-ms") + 1], "725");
    assert.equal(args[args.indexOf("--agent-work-max-concurrent-runs") + 1], "5");
    assert.equal(args[args.indexOf("--agent-work-minimum-free-bytes") + 1], "1048576");
    assert.equal(args[args.indexOf("--agent-work-disk-check-ms") + 1], "15000");
    assert.ok(!args.includes("--agent-work-url"));
    assert.ok(!args.includes("--agent-work-db"));
    assert.ok(!args.includes("--channel-context-db"));

    assert.throws(
      () => resolveDaemonRuntimePaths(["--home", home, "--profile", "missing"], {}),
      /managed profile missing does not exist/
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

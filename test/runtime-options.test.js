import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  daemonRuntimeArguments,
  resolveDaemonRuntimePaths
} from "../apps/daemon/dist/runtime-options.js";

test("daemon runtime options resolve environment defaults to absolute paths", () => {
  const home = resolve(".tmp/runtime-home");
  const paths = resolveDaemonRuntimePaths([], { ORBTEX_HOME: home });

  assert.equal(paths.socketPath, `${home}/sockets/orbtex-daemon.sock`);
  assert.equal(paths.storePath, `${home}/state.json`);
  assert.equal(paths.manifestPath, resolve("config/adapters.json"));
  assert.equal(paths.hostEntrypoint, resolve("apps/adapter-host/dist/index.js"));
});

test("daemon runtime defaults to the user-level Orbtex directory", () => {
  const paths = resolveDaemonRuntimePaths([], {});

  assert.equal(paths.socketPath, resolve(homedir(), ".orbtex/sockets/orbtex-daemon.sock"));
  assert.equal(paths.storePath, resolve(homedir(), ".orbtex/state.json"));
});

test("daemon runtime argv uses explicit options and normalizes the legacy host alias", () => {
  const paths = resolveDaemonRuntimePaths([
    "--socket", "runtime/custom.sock",
    "--store", "runtime/custom.json",
    "--manifest", "runtime/adapters.json",
    "--host-entrypoint", "runtime/host.js"
  ], {
    ORBTEX_HOME: "ignored",
    ORBTEX_ADAPTER_HOST: "ignored-host.js"
  });

  assert.deepEqual(daemonRuntimeArguments(paths), [
    "--socket", resolve("runtime/custom.sock"),
    "--store", resolve("runtime/custom.json"),
    "--manifest", resolve("runtime/adapters.json"),
    "--adapter-host", resolve("runtime/host.js")
  ]);
});

test("Agent Work runtime mode is opt-in and validates required identity", () => {
  const paths = resolveDaemonRuntimePaths([], {
    ORBTEX_HOME: resolve(".tmp/runtime-home"),
    ORBTEX_AGENT_WORK_URL: "http://127.0.0.1:8092",
    ORBTEX_AGENT_WORK_RUNTIME_TOKEN: "runtime-token",
    ORBTEX_AGENT_WORK_TENANT_ID: "tenant-1",
    ORBTEX_AGENT_WORK_SUBJECT_ID: "device-1",
    ORBTEX_AGENT_WORK_RUNTIME_ID: "runtime-1"
  });
  assert.deepEqual(paths.agentWork, {
    baseUrl: "http://127.0.0.1:8092",
    token: "runtime-token",
    tenantId: "tenant-1",
    subjectId: "device-1",
    runtimeId: "runtime-1",
    runtimeName: "orbtex-local",
    fingerprint: `orbtex:${process.platform}:${process.arch}`
  });
});

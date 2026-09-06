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
  const paths = resolveDaemonRuntimePaths([], { OCTO_HARNESS_HOME: home });

  assert.equal(paths.socketPath, `${home}/sockets/octo-harness-daemon.sock`);
  assert.equal(paths.storePath, `${home}/state.db`);
  assert.equal(paths.manifestPath, resolve("config/adapters.json"));
  assert.equal(paths.hostEntrypoint, resolve("apps/adapter-host/dist/index.js"));
});

test("daemon runtime defaults to the user-level Octo Harness directory", () => {
  const paths = resolveDaemonRuntimePaths([], {});

  assert.equal(paths.socketPath, resolve(homedir(), ".octo-harness/sockets/octo-harness-daemon.sock"));
  assert.equal(paths.storePath, resolve(homedir(), ".octo-harness/state.db"));
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
    "--socket", resolve("runtime/custom.sock"),
    "--store", resolve("runtime/custom.json"),
    "--manifest", resolve("runtime/adapters.json"),
    "--adapter-host", resolve("runtime/host.js")
  ]);
});

test("Agent Work runtime mode is opt-in and validates required identity", () => {
  const paths = resolveDaemonRuntimePaths([], {
    OCTO_HARNESS_HOME: resolve(".tmp/runtime-home"),
    OCTO_HARNESS_AGENT_WORK_URL: "http://127.0.0.1:8092",
    OCTO_HARNESS_AGENT_WORK_RUNTIME_TOKEN: "runtime-token",
    OCTO_HARNESS_AGENT_WORK_TENANT_ID: "tenant-1",
    OCTO_HARNESS_AGENT_WORK_SUBJECT_ID: "device-1",
    OCTO_HARNESS_AGENT_WORK_RUNTIME_ID: "runtime-1"
  });
  assert.deepEqual(paths.agentWork, {
    baseUrl: "http://127.0.0.1:8092",
    token: "runtime-token",
    tenantId: "tenant-1",
    subjectId: "device-1",
    runtimeId: "runtime-1",
    runtimeName: "octo-harness-local",
    fingerprint: `octo-harness:${process.platform}:${process.arch}`,
    storePath: resolve(".tmp/runtime-home", "agent-work.db"),
    channelContext: {
      store: "memory",
      projection: "window",
      providerPersistence: "ephemeral",
      storePath: resolve(".tmp/runtime-home", "channel-context.db")
    }
  });
});

test("Agent Work connection flags override non-secret environment settings", () => {
  const paths = resolveDaemonRuntimePaths([
    "--agent-work-url", "http://127.0.0.1:9092",
    "--agent-work-tenant-id", "tenant-from-flag",
    "--agent-work-subject-id", "device-from-flag",
    "--agent-work-runtime-id", "runtime-from-flag",
    "--agent-work-runtime-name", "linked-runtime",
    "--agent-work-fingerprint", "linked:fingerprint"
  ], {
    OCTO_HARNESS_HOME: resolve(".tmp/runtime-home"),
    OCTO_HARNESS_AGENT_WORK_URL: "http://ignored:8092",
    OCTO_HARNESS_AGENT_WORK_RUNTIME_TOKEN: "environment-only-token",
    OCTO_HARNESS_AGENT_WORK_TENANT_ID: "ignored-tenant",
    OCTO_HARNESS_AGENT_WORK_SUBJECT_ID: "ignored-device"
  });

  assert.deepEqual(paths.agentWork, {
    baseUrl: "http://127.0.0.1:9092",
    token: "environment-only-token",
    tenantId: "tenant-from-flag",
    subjectId: "device-from-flag",
    runtimeId: "runtime-from-flag",
    runtimeName: "linked-runtime",
    fingerprint: "linked:fingerprint",
    storePath: resolve(".tmp/runtime-home", "agent-work.db"),
    channelContext: {
      store: "memory",
      projection: "window",
      providerPersistence: "ephemeral",
      storePath: resolve(".tmp/runtime-home", "channel-context.db")
    }
  });
  const args = daemonRuntimeArguments(paths);
  assert.ok(args.includes("--agent-work-url"));
  assert.ok(args.includes("http://127.0.0.1:9092"));
  assert.ok(!args.includes("environment-only-token"));
});

test("channel context rollout flags are independent and use a separate database", () => {
  const paths = resolveDaemonRuntimePaths([
    "--agent-work-url", "http://127.0.0.1:9092",
    "--agent-work-tenant-id", "tenant-1",
    "--agent-work-subject-id", "device-1",
    "--channel-context-store", "sqlite",
    "--channel-context-projection", "delta",
    "--channel-context-provider-persistence", "append_only",
    "--channel-context-db", ".tmp/channel-context-custom.db",
    "--channel-context-max-projected-messages", "25"
  ], {
    OCTO_HARNESS_AGENT_WORK_RUNTIME_TOKEN: "runtime-token"
  });
  assert.deepEqual(paths.agentWork.channelContext, {
    store: "sqlite",
    projection: "delta",
    providerPersistence: "append_only",
    storePath: resolve(".tmp/channel-context-custom.db"),
    maxProjectedMessages: 25
  });
  const args = daemonRuntimeArguments(paths);
  assert.equal(args[args.indexOf("--channel-context-store") + 1], "sqlite");
  assert.equal(args[args.indexOf("--channel-context-max-projected-messages") + 1], "25");
});

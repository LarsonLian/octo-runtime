#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readAdapterConfigurations } from "@mininglamp-oss/octo-runtime-adapter-host";
import { startDaemonServer } from "../server.js";
import type { DaemonModuleRegistration } from "../modules.js";
import { extraRegistration } from "../extra-config.js";
import { readJson, writeJsonAtomic } from "./home.js";
import type { DaemonRunnerSession } from "./runtime-contract.js";

const sessionIndex = process.argv.indexOf("--session");
const sessionPath = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : undefined;
if (!sessionPath) throw new Error("usage: octo-runtime-daemon-runner --session <path>");
const session = readJson<DaemonRunnerSession>(sessionPath);
if (session.schema_version !== 1 || !session.nonce || !Number.isSafeInteger(session.parent_pid)) {
  throw new Error("embedded runner session is invalid");
}

const manifestPath =
  session.manifest_path ?? fileURLToPath(new URL("./config/adapters.json", import.meta.url));
const hostEntrypoint =
  session.adapter_host_entrypoint ??
  fileURLToPath(import.meta.resolve("@mininglamp-oss/octo-runtime-adapter-host/runner"));
const profiles = session.profiles.map((profile) => {
  const root = join(session.account_root, profile);
  const identity = readJson<{ runtime_id: string; octo_space_id: string }>(
    join(root, "identity", "runtime.json")
  );
  const config = readJson<{ adapters?: unknown }>(join(root, "config.json"));
  return {
    tenantId: identity.octo_space_id,
    profile,
    root,
    runtimeId: identity.runtime_id,
    adapterConfigurations: readAdapterConfigurations(root, config.adapters)
  };
});
let stopping = false;

const stop = (): void => {
  if (stopping) return;
  stopping = true;
  clearInterval(controlTimer);
  void (async () => {
    await application.close();
  })().then(
    () => process.exit(0),
    (error) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exit(1);
    }
  );
};

const application = await startDaemonServer({
  homePath: session.account_root,
  socketPath: session.socket_path,
  manifestPath,
  hostEntrypoint,
  localRuntimes: profiles,
  extras: (session.extras ?? []).map(extraRegistration),
  account: {
    subject: session.subject,
    profiles,
    machineId: readJson<{ machine_id: string }>(join(session.home, "machine.json")).machine_id
  },
  modules: session.modules.map((descriptor) => ({
    id: descriptor.id,
    create: async (context, config) => {
      const loaded = (await import(descriptor.module)) as Record<string, unknown>;
      const create = loaded[descriptor.exportName] as DaemonModuleRegistration["create"];
      if (typeof create !== "function") throw new Error("DAEMON_MODULE_FACTORY_MISSING");
      return create(context, config);
    }
  }))
});
writeJsonAtomic(session.supervisor_state, {
  schema_version: 1,
  nonce: session.nonce,
  parent_pid: session.parent_pid,
  runner_pid: process.pid,
  host_pid: process.pid,
  adapter_host_pid: application.hostProcess.child.pid ?? null,
  started_at: new Date().toISOString()
});

const controlTimer = setInterval(() => {
  if (existsSync(session.shutdown_file)) {
    try {
      const shutdown = readJson<{ nonce?: unknown }>(session.shutdown_file);
      if (shutdown.nonce === session.nonce) stop();
    } catch {
      // A partial or foreign shutdown file is not authority for this session.
    }
    return;
  }
  try {
    process.kill(session.parent_pid, 0);
  } catch {
    stop();
  }
}, 500);
controlTimer.unref();

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop);

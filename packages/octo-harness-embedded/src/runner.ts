#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  loadManagedAgentWorksFromRoot,
  startDaemonServer,
  type DaemonApplication
} from "@mininglamp-oss/octo-harness-daemon";
import { readJson, writeJsonAtomic } from "./home.js";
import type { EmbeddedRunnerSession } from "./runtime-contract.js";

const sessionIndex = process.argv.indexOf("--session");
const sessionPath = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : undefined;
if (!sessionPath) throw new Error("usage: octo-harness-embedded-runner --session <path>");
const session = readJson<EmbeddedRunnerSession>(sessionPath);
if (session.schema_version !== 1 || !session.nonce || !Number.isSafeInteger(session.parent_pid)) {
  throw new Error("embedded runner session is invalid");
}

const manifestPath = session.manifest_path ?? fileURLToPath(new URL("./config/adapters.json", import.meta.url));
const hostEntrypoint = session.adapter_host_entrypoint ?? fileURLToPath(import.meta.resolve("@mininglamp-oss/octo-harness-adapter-host/runner"));
const agentWorks = loadManagedAgentWorksFromRoot(session.account_root, session.profiles);
let application: DaemonApplication | undefined;
let stopping = false;

const stop = (): void => {
  if (stopping) return;
  stopping = true;
  clearInterval(controlTimer);
  void application?.close().then(
    () => process.exit(0),
    error => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    }
  );
};

application = await startDaemonServer({
  homePath: session.home,
  pidPath: session.pid_path,
  socketPath: session.socket_path,
  storePath: session.store_path,
  manifestPath,
  hostEntrypoint,
  inspectHost: "127.0.0.1",
  agentWorks
});
writeJsonAtomic(session.supervisor_state, {
  schema_version: 1,
  nonce: session.nonce,
  parent_pid: session.parent_pid,
  runner_pid: process.pid,
  daemon_pid: process.pid,
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

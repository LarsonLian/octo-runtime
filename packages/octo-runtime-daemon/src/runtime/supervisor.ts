import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonRuntimeError } from "./errors.js";
import {
  removeFile,
  writeJsonAtomic,
  type DaemonAccountPaths,
  type DaemonHomePaths
} from "./home.js";
import {
  callDaemon,
  probeDaemon,
  type DaemonStatus,
  type DaemonRunnerSession
} from "./runtime-contract.js";
import type { AccountSubject, DaemonRuntimeOptions } from "./types.js";
const closedChildren = new WeakSet<ChildProcess>();

export interface SupervisedRuntime {
  child: ChildProcess;
  nonce: string;
  paths: DaemonHomePaths;
}

export async function startManagedDaemon(options: {
  sdk: DaemonRuntimeOptions;
  paths: DaemonHomePaths;
  account: DaemonAccountPaths;
  profiles: readonly string[];
  subject: AccountSubject;
  nonce: string;
}): Promise<{ supervised: SupervisedRuntime; status: DaemonStatus }> {
  const nodePath = resolveNode(options.sdk);
  const runnerPath =
    options.sdk.distribution?.runnerPath ?? fileURLToPath(new URL("./runner.js", import.meta.url));
  if (!existsSync(runnerPath)) {
    throw new DaemonRuntimeError(
      "DISTRIBUTION_MISSING",
      "distribution",
      false,
      `embedded runner is missing: ${runnerPath}`
    );
  }
  removeFile(options.paths.shutdownFile);
  const session: DaemonRunnerSession = {
    schema_version: 1,
    nonce: options.nonce,
    parent_pid: process.pid,
    home: options.paths.home,
    account_root: options.account.root,
    profiles: [...options.profiles],
    subject: options.subject,
    modules: options.sdk.modules ?? [],
    extras: options.sdk.extras ?? [],
    socket_path: options.paths.socket,
    pid_path: options.paths.pidFile,
    ...(options.sdk.logging ? { log_directory: options.sdk.logging.directory } : {}),
    shutdown_file: options.paths.shutdownFile,
    supervisor_state: options.paths.supervisorState,
    ...(options.sdk.distribution?.manifestPath
      ? { manifest_path: options.sdk.distribution.manifestPath }
      : {}),
    ...(options.sdk.distribution?.adapterHostEntrypoint
      ? { adapter_host_entrypoint: options.sdk.distribution.adapterHostEntrypoint }
      : {})
  };
  writeJsonAtomic(options.paths.sessionFile, session, true);
  const child = spawn(nodePath, [runnerPath, "--session", options.paths.sessionFile], {
    argv0: "octo-runtime-daemon",
    cwd: dirname(runnerPath),
    detached: false,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "ignore", "inherit"],
    env: childEnvironment(options.paths)
  });
  child.once("close", () => {
    closedChildren.add(child);
  });
  const supervised: SupervisedRuntime = { child, nonce: options.nonce, paths: options.paths };
  const startupTimeout = options.sdk.startupTimeoutMs ?? 30_000;
  const deadline = Date.now() + startupTimeout;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new DaemonRuntimeError(
        "DAEMON_EXITED",
        "daemon",
        true,
        `embedded runner exited before readiness (code=${child.exitCode ?? "none"}, signal=${child.signalCode ?? "none"})`
      );
    }
    const status = await probeDaemon(options.paths.socket);
    if (status?.ready) return { supervised, status };
    if (Date.now() >= deadline) {
      await stopManagedDaemon(supervised).catch(() => undefined);
      throw new DaemonRuntimeError(
        "DAEMON_START_TIMEOUT",
        "daemon",
        true,
        `embedded runtime was not ready within ${startupTimeout}ms`
      );
    }
    await delay(250);
  }
}

export async function stopManagedDaemon(supervised: SupervisedRuntime): Promise<void> {
  let cleanupFailed = false;
  try {
    await callDaemon(
      supervised.paths.socket,
      { method: "lifecycle.drain", params: { timeoutMs: 5_000 } },
      7_000
    );
  } catch (error) {
    cleanupFailed = error instanceof Error && error.message === "EXTRA_DISPOSE_FAILED";
    // Shutdown must continue even if cleanup fails or the endpoint is unavailable.
  }
  writeJsonAtomic(supervised.paths.shutdownFile, {
    nonce: supervised.nonce,
    requested_at: new Date().toISOString()
  });
  if (await waitForExit(supervised.child, 5_000)) {
    cleanup(supervised.paths);
    if (cleanupFailed)
      throw new DaemonRuntimeError(
        "EXTRA_DISPOSE_FAILED",
        "shutdown",
        false,
        "Extra cleanup failed before process exit"
      );
    return;
  }
  await terminateOwnedChild(supervised.child);
  if (!(await waitForExit(supervised.child, 5_000))) {
    throw new DaemonRuntimeError(
      "SHUTDOWN_INCOMPLETE",
      "shutdown",
      false,
      "embedded runtime process tree did not exit"
    );
  }
  if (await probeDaemon(supervised.paths.socket, 500)) {
    throw new DaemonRuntimeError(
      "SHUTDOWN_INCOMPLETE",
      "shutdown",
      false,
      "embedded daemon IPC is still reachable after shutdown"
    );
  }
  cleanup(supervised.paths);
  if (cleanupFailed)
    throw new DaemonRuntimeError(
      "EXTRA_DISPOSE_FAILED",
      "shutdown",
      false,
      "Extra cleanup failed before process exit"
    );
}

export async function runtimeStatus(
  supervised: SupervisedRuntime
): Promise<DaemonStatus | undefined> {
  if (supervised.child.exitCode !== null || supervised.child.signalCode !== null) return undefined;
  return probeDaemon(supervised.paths.socket);
}

function resolveNode(options: DaemonRuntimeOptions): string {
  const explicit = options.distribution?.nodePath;
  if (explicit) return assertNode24(explicit);
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const executable = process.platform === "win32" ? "node.exe" : "node";
    for (const candidate of [
      join(resourcesPath, "runtime", "node", "bin", executable),
      join(resourcesPath, "embedded-runtime", "node", "bin", executable)
    ]) {
      if (existsSync(candidate)) return assertNode24(candidate);
    }
    if (!options.development) {
      throw new DaemonRuntimeError(
        "NODE_RUNTIME_MISSING",
        "distribution",
        false,
        "packaged embedded runtime is missing its pinned Node.js 24 executable"
      );
    }
  }
  if (!process.versions.electron && Number(process.versions.node.split(".")[0]) >= 24)
    return process.execPath;
  if (options.development) {
    const pathNode = findOnPath(process.platform === "win32" ? "node.exe" : "node");
    if (pathNode) return assertNode24(pathNode);
  }
  throw new DaemonRuntimeError(
    "NODE_RUNTIME_MISSING",
    "distribution",
    false,
    "Embedded Runtime requires a pinned Node.js 24 runtime"
  );
}

function assertNode24(path: string): string {
  if (!existsSync(path))
    throw new DaemonRuntimeError(
      "NODE_RUNTIME_MISSING",
      "distribution",
      false,
      `Node executable is missing: ${path}`
    );
  const result = spawnSync(path, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    shell: false
  });
  const version = String(result.stdout || result.stderr).trim();
  if (result.status !== 0 || Number(/^v?(\d+)/.exec(version)?.[1] ?? 0) < 24) {
    throw new DaemonRuntimeError(
      "NODE_RUNTIME_INVALID",
      "distribution",
      false,
      `Embedded Runtime requires Node.js 24+: ${path} (${version || "unavailable"})`
    );
  }
  return path;
}

function findOnPath(executable: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = directory ? join(directory, executable) : undefined;
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function childEnvironment(paths: DaemonHomePaths): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? process.env.USERPROFILE ?? "",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    OCTO_RUNTIME_HOME: paths.home,
    ...(process.env.OCTO_RUNTIME_DEBUG === "1" ? { OCTO_RUNTIME_DEBUG: "1" } : {})
  };
  // Preserve the host's explicit network routing, including loopback bypasses.
  // Do not inherit arbitrary application credentials into the runtime process.
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy"
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (process.platform === "win32") {
    for (const key of [
      "SystemRoot",
      "SystemDrive",
      "COMSPEC",
      "PATHEXT",
      "TEMP",
      "TMP",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "NUMBER_OF_PROCESSORS",
      "PROCESSOR_ARCHITECTURE"
    ]) {
      const value = environmentValue(key);
      if (value) env[key] = value;
    }
  }
  return env;
}

function environmentValue(name: string): string | undefined {
  const key = Object.keys(process.env).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase()
  );
  return key ? process.env[key] : undefined;
}

async function terminateOwnedChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        shell: false,
        stdio: "ignore"
      });
      killer.once("error", reject);
      killer.once("exit", (code) =>
        code === 0 || code === 128 ? resolve() : reject(new Error(`taskkill exited with ${code}`))
      );
    });
  } else {
    child.kill("SIGTERM");
    if (!(await waitForExit(child, 2_000))) child.kill("SIGKILL");
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (closedChildren.has(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanupListener();
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      cleanupListener();
      resolve(true);
    };
    const cleanupListener = (): void => {
      child.off("close", onExit);
    };
    child.once("close", onExit);
  });
}

function cleanup(paths: DaemonHomePaths): void {
  for (const path of [paths.shutdownFile, paths.sessionFile, paths.supervisorState])
    removeFile(path);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

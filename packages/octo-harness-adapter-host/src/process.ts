import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { HostedAdapterMetadata } from "./index.js";
import { AdapterHostRpcClient } from "./rpc.js";

export interface SpawnAdapterHostOptions {
  entrypoint: string;
  manifest: string;
  env?: NodeJS.ProcessEnv;
  /** Cancels readiness and terminates the complete child process group. */
  signal?: AbortSignal;
  /** Maximum time allowed for the initial RPC readiness handshake. */
  readyTimeoutMs?: number;
}

type HostedChild = ChildProcessByStdio<Writable, Readable, Readable>;

export interface AdapterHostProcess {
  client: AdapterHostRpcClient;
  child: HostedChild;
  adapters: HostedAdapterMetadata[];
  close(): Promise<void>;
  stderr(): string;
}

/**
 * Spawn the adapter-host as a child process and return a ready-to-use RPC
 * client. It waits for the first `list` to succeed as a readiness handshake, so
 * a failed spawn (bad manifest, missing binary) surfaces here with the child's
 * captured stderr rather than at first invoke. The child inherits the debug
 * environment and writes its own Host log.
 */
export async function spawnAdapterHost({
  entrypoint,
  manifest,
  env = process.env,
  signal,
  readyTimeoutMs = 15_000
}: SpawnAdapterHostOptions): Promise<AdapterHostProcess> {
  if (signal?.aborted) throw new Error("adapter-host spawn cancelled");
  if (!Number.isFinite(readyTimeoutMs) || readyTimeoutMs < 1) {
    throw new Error("adapter-host readyTimeoutMs must be positive");
  }
  const child = spawn(process.execPath, [entrypoint, "--manifest", manifest], {
    argv0: "octo-harness-adapter-host",
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (value: string | Buffer) => {
    // Keep only the tail so a chatty child cannot grow this buffer unbounded.
    stderr = (stderr + value.toString()).slice(-8192);
  });
  const client = new AdapterHostRpcClient({
    input: child.stdout,
    output: child.stdin
  });
  let adapters: HostedAdapterMetadata[];
  try {
    adapters = await waitForReady(client.list(), readyTimeoutMs, signal);
  } catch (error) {
    client.close(error instanceof Error ? error : new Error(errorMessage(error)));
    await terminateProcessTree(child);
    throw new Error(`${errorMessage(error)}${stderr ? `: ${stderr}` : ""}`, { cause: error });
  }
  return {
    client,
    child,
    adapters,
    async close(): Promise<void> {
      await terminateProcessTree(child);
    },
    stderr: () => stderr
  };
}

function waitForReady<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new Error("adapter-host spawn cancelled"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(new Error("adapter-host spawn cancelled")));
    const timer = setTimeout(
      () =>
        finish(() => reject(new Error(`adapter-host readiness timed out after ${timeoutMs}ms`))),
      timeoutMs
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) =>
        finish(() => reject(error instanceof Error ? error : new Error(errorMessage(error))))
    );
  });
}

async function terminateProcessTree(child: HostedChild): Promise<void> {
  if (hasExited(child)) return;
  signalProcessTree(child, "SIGTERM");
  await waitForExit(child, 1_000);
  if (hasExited(child)) return;
  signalProcessTree(child, "SIGKILL");
  await waitForExit(child, 1_000);
}

function hasExited(child: HostedChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: HostedChild, timeoutMs: number): Promise<void> {
  if (hasExited(child)) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

function signalProcessTree(child: HostedChild, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  child.kill(signal);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

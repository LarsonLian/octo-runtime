import { createProcessCleanup } from "@mininglamp-oss/octo-runtime-adapter-sdk/process-cleanup";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { HostedAdapterMetadata } from "./index.js";
import { AdapterHostRpcClient } from "./rpc.js";

export interface SpawnAdapterHostOptions {
  entrypoint: string;
  /** CLI JSON 来源；SDK 的直接 import 入口不需要此参数。 */
  manifest?: string;
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
  // 跨进程只传程序入口及可选文件路径，不序列化 Adapter 实例或工厂函数。
  const child = spawn(
    process.execPath,
    [entrypoint, ...(manifest ? ["--manifest", manifest] : [])],
    {
      argv0: "octo-runtime-adapter-host",
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32"
    }
  );
  const cleanup = createProcessCleanup(child, { processGroup: process.platform !== "win32" });
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
  // S05：spawn error 必须在 readiness 阶段归属本次启动，不能终止宿主。
  // .octospec/tasks/pr1-yujiawei-review/assessment.md
  child.on("error", (error) => client.close(error));
  let adapters: HostedAdapterMetadata[];
  try {
    adapters = await waitForReady(client.list(), readyTimeoutMs, signal);
  } catch (error) {
    client.close(error instanceof Error ? error : new Error(errorMessage(error)));
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${errorMessage(error)}${stderr ? `: ${stderr}` : ""}; cleanup: ${errorMessage(cleanupError)}`,
        { cause: cleanupError }
      );
    }
    throw new Error(`${errorMessage(error)}${stderr ? `: ${stderr}` : ""}`, { cause: error });
  }
  return {
    client,
    child,
    adapters,
    // S02：关闭 RPC 后等待本次进程组，不以 leader exit 结束回收。
    // .octospec/tasks/pr1-yujiawei-review/assessment.md
    close(): Promise<void> {
      client.close();
      return cleanup();
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AdapterHostRpcClient, type RpcTrace } from "./rpc.js";

export interface SpawnAdapterHostOptions {
  entrypoint: string;
  manifest: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Optional caller-owned wire observer. The daemon supplies a structured,
   * redacting trace sink; this helper deliberately does not infer tracing from
   * environment variables or write raw RPC frames to stderr.
   */
  trace?: RpcTrace;
}

export interface AdapterHostProcess {
  client: AdapterHostRpcClient;
  child: ChildProcessWithoutNullStreams;
  close(): Promise<void>;
  stderr(): string;
}

/**
 * Spawn the adapter-host as a child process and return a ready-to-use RPC
 * client. It waits for the first `list` to succeed as a readiness handshake, so
 * a failed spawn (bad manifest, missing binary) surfaces here with the child's
 * captured stderr rather than at first invoke. Wire tracing is injected by the
 * caller so all frames pass through the same retention and redaction policy as
 * other daemon logs.
 */
export async function spawnAdapterHost({
  entrypoint,
  manifest,
  env = process.env,
  trace
}: SpawnAdapterHostOptions): Promise<AdapterHostProcess> {
  const child = spawn(process.execPath, [entrypoint, "--manifest", manifest], {
    argv0: "octo-harness-adapter-host",
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (value: string | Buffer) => {
    // Keep only the tail so a chatty child cannot grow this buffer unbounded.
    stderr = (stderr + value.toString()).slice(-8192);
  });
  const client = new AdapterHostRpcClient({
    input: child.stdout,
    output: child.stdin,
    ...(trace ? { trace } : {})
  });
  try {
    await client.list();
  } catch (error) {
    child.kill();
    throw new Error(`${errorMessage(error)}${stderr ? `: ${stderr}` : ""}`, { cause: error });
  }
  return {
    client,
    child,
    async close(): Promise<void> {
      if (child.exitCode !== null) return;
      // Ask politely with SIGTERM, then escalate to SIGKILL if it has not exited within the grace window.
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>(resolve => child.once("exit", () => resolve())),
        new Promise<void>(resolve => setTimeout(resolve, 1000))
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
    stderr: () => stderr
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

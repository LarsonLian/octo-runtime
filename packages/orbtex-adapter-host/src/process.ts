import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AdapterHostRpcClient, type RpcTrace } from "./rpc.js";

export interface SpawnAdapterHostOptions {
  entrypoint: string;
  manifest: string;
  env?: NodeJS.ProcessEnv;
}

export interface AdapterHostProcess {
  client: AdapterHostRpcClient;
  child: ChildProcessWithoutNullStreams;
  close(): Promise<void>;
  stderr(): string;
}

export async function spawnAdapterHost({
  entrypoint,
  manifest,
  env = process.env
}: SpawnAdapterHostOptions): Promise<AdapterHostProcess> {
  const child = spawn(process.execPath, [entrypoint, "--manifest", manifest], {
    argv0: "orbtex-adapter-host",
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (value: string | Buffer) => {
    stderr = (stderr + value.toString()).slice(-8192);
  });
  const trace = rpcTrace(env);
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

function rpcTrace(env: NodeJS.ProcessEnv): RpcTrace | undefined {
  if (env.ORBTEX_TRACE_RPC !== "1") return undefined;
  return (direction, frame) => {
    const route = direction === "send" ? "daemon -> adapter-host" : "adapter-host -> daemon";
    process.stderr.write(`[orbtex rpc ${route}] ${frame}\n`);
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

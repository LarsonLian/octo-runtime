import { createConnection } from "node:net";

export interface EmbeddedRunnerSession {
  schema_version: 1;
  nonce: string;
  parent_pid: number;
  home: string;
  account_root: string;
  profiles: string[];
  socket_path: string;
  pid_path: string;
  store_path: string;
  log_directory: string;
  shutdown_file: string;
  supervisor_state: string;
  manifest_path?: string;
  adapter_host_entrypoint?: string;
}

export interface DaemonStatus {
  ready?: boolean;
  pid?: number;
  adapterHost?: { pid?: number | null; state?: string };
  agentWork?: {
    enabled?: boolean;
    connected?: boolean;
    totalProfiles?: number;
    connectedProfiles?: number;
    runtimes?: Array<{
      profile?: string;
      runtimeId?: string;
      connected?: boolean;
      error?: string;
    }>;
  };
}

export async function callDaemon<T = unknown>(
  socketPath: string,
  request: { method: string; params?: Record<string, unknown> },
  timeoutMs = 5_000
): Promise<T> {
  const socket = createConnection(socketPath);
  const id = `embedded-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("daemon connection timed out")), timeoutMs);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", error => { clearTimeout(timer); reject(error); });
    });
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...request })}\n`);
    return await new Promise<T>((resolve, reject) => {
      let buffered = "";
      const timer = setTimeout(() => reject(new Error("daemon response timed out")), timeoutMs);
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffered += chunk;
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        try {
          const response = JSON.parse(buffered.slice(0, newline)) as { result?: T; error?: { message?: string } };
          if (response.error) throw new Error(response.error.message ?? "daemon request failed");
          resolve(response.result as T);
        } catch (error) {
          reject(error);
        }
      });
      socket.once("end", () => { clearTimeout(timer); reject(new Error("daemon closed before responding")); });
    });
  } finally {
    socket.destroy();
  }
}

export async function probeDaemon(socketPath: string, timeoutMs = 2_000): Promise<DaemonStatus | undefined> {
  try {
    return await callDaemon<DaemonStatus>(socketPath, { method: "status" }, timeoutMs);
  } catch {
    return undefined;
  }
}

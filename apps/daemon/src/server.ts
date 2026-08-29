import net, { type Server } from "node:net";
import { createInterface } from "node:readline";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  HarnessEngine,
  JsonFileStore,
  type CreateTriggerInput,
  type RegisterAgentInput,
  type Store
} from "@orbtex-ai/orbtex-core";
import { HarnessDaemon } from "@orbtex-ai/orbtex-daemon";
import {
  spawnAdapterHost,
  type AdapterHostProcess,
  type AdapterHostRpcClient
} from "@orbtex-ai/orbtex-adapter-host";

interface StartDaemonServerOptions {
  socketPath: string;
  storePath: string;
  manifestPath: string;
  hostEntrypoint: string;
}

interface DaemonRequest {
  id?: unknown;
  method: string;
  params?: Record<string, unknown>;
}

interface DaemonApplication {
  server: Server;
  store: JsonFileStore;
  daemon: HarnessDaemon;
  engine: HarnessEngine;
  hostProcess: AdapterHostProcess;
  close(): Promise<void>;
}

export async function startDaemonServer({
  socketPath,
  storePath,
  manifestPath,
  hostEntrypoint
}: StartDaemonServerOptions): Promise<DaemonApplication> {
  await mkdir(dirname(socketPath), { recursive: true });
  try {
    const stat = await lstat(socketPath);
    if (!stat.isSocket()) throw new Error(`refusing to replace non-socket path: ${socketPath}`);
    await rm(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const store = await JsonFileStore.open(storePath);
  const hostProcess = await spawnAdapterHost({ entrypoint: hostEntrypoint, manifest: manifestPath });
  const engine = new HarnessEngine({ store, host: hostProcess.client });
  const daemon = new HarnessDaemon({ engine, store });

  const server = net.createServer(socket => {
    createInterface({ input: socket }).once("line", line => {
      void handleRequestLine({ line, socket, daemon, engine, store, host: hostProcess.client });
    });
  });

  try {
    await daemon.recover();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    // Unix socket 是本地控制面的权限边界，只允许当前宿主账号访问。
    await chmod(socketPath, 0o600);
  } catch (error) {
    daemon.stop();
    await hostProcess.close();
    await rm(socketPath, { force: true });
    throw error;
  }

  return {
    server,
    store,
    daemon,
    engine,
    hostProcess,
    async close(): Promise<void> {
      daemon.stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await hostProcess.close();
      await rm(socketPath, { force: true });
    }
  };
}

async function handleRequestLine({
  line,
  socket,
  daemon,
  engine,
  store,
  host
}: {
  line: string;
  socket: net.Socket;
  daemon: HarnessDaemon;
  engine: HarnessEngine;
  store: Store;
  host: AdapterHostRpcClient;
}): Promise<void> {
  let request: DaemonRequest | undefined;
  try {
    request = parseRequest(line);
    const result = await dispatch({ request, daemon, engine, store, host });
    socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
  } catch (error) {
    const rpcError = error as NodeJS.ErrnoException;
    socket.end(`${JSON.stringify({
      id: request?.id,
      error: { message: errorMessage(error), code: rpcError.code }
    })}\n`);
  }
}

async function dispatch({
  request,
  daemon,
  engine,
  store,
  host
}: {
  request: DaemonRequest;
  daemon: HarnessDaemon;
  engine: HarnessEngine;
  store: Store;
  host: AdapterHostRpcClient;
}): Promise<unknown> {
  const params = request.params ?? {};
  switch (request.method) {
    case "status":
      return {
        ready: true,
        pid: process.pid,
        counts: Object.fromEntries(
          (["agents", "triggers", "tasks", "runs"] as const).map(name => [name, store[name].size])
        )
      };
    case "adapter.list":
      return host.list();
    case "adapter.probe":
      return host.probe(requiredString(params.adapterType, "adapterType"));
    case "agent.create":
      return engine.registerAgent(params as unknown as RegisterAgentInput);
    case "agent.list":
      return [...store.agents.values()];
    case "chat.create":
      return engine.createChatSession(params as unknown as { agentId: string; title?: string; channel?: string });
    case "chat.list":
      return [...store.sessions.values()].filter(item => item.type === "chat");
    case "chat.get":
      return store.sessions.get(requiredString(params.sessionId, "sessionId")) ?? null;
    case "chat.send":
      return daemon.submitChat(
        requiredString(params.sessionId, "sessionId"),
        requiredString(params.prompt, "prompt"),
        optionalString(params.instructions) ?? ""
      );
    case "trigger.create": {
      const trigger = await engine.createTrigger(params as unknown as CreateTriggerInput);
      daemon.startSchedulers();
      return trigger;
    }
    case "trigger.list":
      return [...store.triggers.values()];
    case "trigger.fire":
      return daemon.submitTrigger(requiredString(params.triggerId, "triggerId"), {
        externalEventId: requiredString(params.externalEventId, "externalEventId"),
        payload: optionalRecord(params.payload)
      });
    case "event.ingest":
      return daemon.ingestEvent({
        eventType: requiredString(params.eventType, "eventType"),
        externalEventId: requiredString(params.externalEventId, "externalEventId"),
        payload: optionalRecord(params.payload)
      });
    case "task.list":
      return [...store.tasks.values()];
    case "task.get":
      return store.tasks.get(requiredString(params.taskId, "taskId")) ?? null;
    case "task.continue":
      return daemon.continueTask(requiredString(params.taskId, "taskId"), {
        sourceType: optionalString(params.sourceType) ?? "comment",
        sourceId: optionalString(params.sourceId),
        instructions: optionalString(params.instructions) ?? ""
      });
    case "run.get":
      return store.runs.get(requiredString(params.runId, "runId")) ?? null;
    case "run.events":
      return store.events.get(requiredString(params.runId, "runId")) ?? [];
    case "run.wait":
      return daemon.waitForRun(requiredString(params.runId, "runId"));
    case "run.cancel":
      return daemon.cancelRun(requiredString(params.runId, "runId"), optionalString(params.reason));
    default:
      throw Object.assign(new Error(`unknown daemon method: ${request.method}`), { code: "method_not_found" });
  }
}

function parseRequest(line: string): DaemonRequest {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || typeof value.method !== "string") throw new TypeError("daemon request requires method");
  return value as unknown as DaemonRequest;
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

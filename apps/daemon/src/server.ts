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
import { AgentWorkRuntime, type AgentWorkRuntimeOptions } from "./agent-work-runtime.js";

export interface StartDaemonServerOptions {
  socketPath: string;
  storePath: string;
  manifestPath: string;
  hostEntrypoint: string;
  agentWork?: AgentWorkRuntimeOptions;
}

export interface DaemonRuntimeInfo {
  socketPath: string;
  storePath: string;
  manifestPath: string;
  adapterHost: {
    pid: number | null;
    entrypoint: string;
  };
  adapters: string[];
}

interface DaemonRequest {
  id?: unknown;
  method: string;
  params?: Record<string, unknown>;
}

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const TERMINAL_EVENT_TYPES = new Set(["run.finished", "run.error", "run.stopped"]);
const STREAM_POLL_MS = 25;

export interface DaemonApplication {
  server: Server;
  store: JsonFileStore;
  daemon: HarnessDaemon;
  engine: HarnessEngine;
  hostProcess: AdapterHostProcess;
  runtime: DaemonRuntimeInfo;
  agentWorkRuntime?: AgentWorkRuntime;
  close(): Promise<void>;
}

export async function startDaemonServer({
  socketPath,
  storePath,
  manifestPath,
  hostEntrypoint,
  agentWork
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
  let adapters: string[];
  try {
    adapters = (await hostProcess.client.list()).map(adapter => adapter.type);
  } catch (error) {
    await hostProcess.close();
    throw error;
  }
  const runtime: DaemonRuntimeInfo = {
    socketPath,
    storePath,
    manifestPath,
    adapterHost: {
      pid: hostProcess.child.pid ?? null,
      entrypoint: hostEntrypoint
    },
    adapters
  };
  const engine = new HarnessEngine({ store, host: hostProcess.client });
  const daemon = new HarnessDaemon({ engine, store });
  const agentWorkRuntime = agentWork ? new AgentWorkRuntime(agentWork, hostProcess.client) : undefined;

  const server = net.createServer(socket => {
    createInterface({ input: socket }).once("line", line => {
      void handleRequestLine({ line, socket, daemon, engine, store, host: hostProcess.client, runtime, agentWorkRuntime });
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
    await agentWorkRuntime?.start();
  } catch (error) {
    daemon.stop();
    await agentWorkRuntime?.close();
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
    runtime,
    agentWorkRuntime,
    async close(): Promise<void> {
      daemon.stop();
      await agentWorkRuntime?.close();
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
  host,
  runtime,
  agentWorkRuntime
}: {
  line: string;
  socket: net.Socket;
  daemon: HarnessDaemon;
  engine: HarnessEngine;
  store: Store;
  host: AdapterHostRpcClient;
  runtime: DaemonRuntimeInfo;
  agentWorkRuntime?: AgentWorkRuntime;
}): Promise<void> {
  let request: DaemonRequest | undefined;
  try {
    request = parseRequest(line);
    if (request.method === "run.stream") {
      await streamRunEvents({ request, socket, store });
      return;
    }
    const result = await dispatch({ request, daemon, engine, store, host, runtime, agentWorkRuntime });
    socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
  } catch (error) {
    const rpcError = error as NodeJS.ErrnoException;
    socket.end(`${JSON.stringify({
      id: request?.id,
      error: { message: errorMessage(error), code: rpcError.code }
    })}\n`);
  }
}

async function streamRunEvents({
  request,
  socket,
  store
}: {
  request: DaemonRequest;
  socket: net.Socket;
  store: Store;
}): Promise<void> {
  const params = request.params ?? {};
  const runId = requiredString(params.runId, "runId");
  let nextSeq = positiveInteger(params.fromSeq, "fromSeq", 1);
  if (!store.runs.has(runId)) throw new Error(`run not found: ${runId}`);

  while (!socket.destroyed) {
    for (const event of store.events.get(runId) ?? []) {
      if (event.seq < nextSeq) continue;
      await writeSocketLine(socket, { id: request.id, event });
      nextSeq = event.seq + 1;
      if (TERMINAL_EVENT_TYPES.has(event.type)) {
        await writeSocketLine(socket, {
          id: request.id,
          result: { done: true, run: store.runs.get(runId), nextSeq }
        });
        socket.end();
        return;
      }
    }

    const run = store.runs.get(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      await writeSocketLine(socket, { id: request.id, result: { done: true, run, nextSeq } });
      socket.end();
      return;
    }
    await new Promise<void>(resolve => setTimeout(resolve, STREAM_POLL_MS));
  }
}

async function writeSocketLine(socket: net.Socket, value: unknown): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>((resolve, reject) => {
    socket.write(`${JSON.stringify(value)}\n`, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function dispatch({
  request,
  daemon,
  engine,
  store,
  host,
  runtime,
  agentWorkRuntime
}: {
  request: DaemonRequest;
  daemon: HarnessDaemon;
  engine: HarnessEngine;
  store: Store;
  host: AdapterHostRpcClient;
  runtime: DaemonRuntimeInfo;
  agentWorkRuntime?: AgentWorkRuntime;
}): Promise<unknown> {
  const params = request.params ?? {};
  switch (request.method) {
    case "status":
      return {
        ready: true,
        pid: process.pid,
        ...runtime,
        agentWork: agentWorkRuntime?.status ?? { enabled: false },
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

function positiveInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

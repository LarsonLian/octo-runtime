import net, { type Server } from "node:net";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { chmod, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DEFAULT_OBSERVABILITY_CONFIGURATION,
  LocalObservability,
  observabilityEnvironment,
  type ObservabilityConfiguration
} from "@mininglamp-oss/octo-harness-observability";
import {
  HarnessEngine,
  SqliteStore,
  type Store
} from "@mininglamp-oss/octo-harness-core";
import { HarnessDaemon } from "@mininglamp-oss/octo-harness-daemon";
import {
  spawnAdapterHost,
  type AdapterHostRpc,
  type AdapterHostProcess,
} from "@mininglamp-oss/octo-harness-adapter-host";
import { AgentWorkRuntime, type AgentWorkRuntimeOptions } from "./agent-work-runtime.js";
import { ViewerLogIndex, viewerTraceSnapshot } from "./log-viewer.js";

export interface StartDaemonServerOptions {
  homePath?: string;
  pidPath?: string;
  socketPath: string;
  storePath: string;
  manifestPath: string;
  hostEntrypoint: string;
  logging?: ObservabilityConfiguration;
  agentWork?: AgentWorkRuntimeOptions;
  /** Test/embedding override for the capped adapter-host restart schedule. */
  adapterHostRestartDelaysMs?: readonly number[];
}

/** Non-secret process metadata returned by `status` and suitable for support output. */
export interface DaemonRuntimeInfo {
  homePath?: string;
  pidPath?: string;
  socketPath: string;
  storePath: string;
  manifestPath: string;
  adapterHost: {
    pid: number | null;
    entrypoint: string;
    state: "ready" | "restarting";
    restartAttempt: number;
  };
  adapters: string[];
}

interface DaemonRequest {
  id?: unknown;
  method: string;
  params?: Record<string, unknown>;
}

// Terminal sets are intentionally duplicated across protocol/engine/daemon/server;
// keep them in sync. Here they let the streamer stop on either a terminal event or
// a terminal run status.
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const TERMINAL_EVENT_TYPES = new Set(["run.finished", "run.error", "run.stopped"]);
const STREAM_POLL_MS = 25;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_ADAPTER_HOST_RESTART_DELAYS_MS = [1_000, 5_000, 10_000, 20_000] as const;
const ADAPTER_HOST_STABLE_RESET_MS = 5 * 60_000;

/** Everything the daemon owns for one process lifetime; `close()` tears the whole
 * stack down in the reverse order it was brought up and removes the socket file. */
export interface DaemonApplication {
  server: Server;
  store: SqliteStore;
  daemon: HarnessDaemon;
  engine: HarnessEngine;
  hostProcess: AdapterHostProcess;
  runtime: DaemonRuntimeInfo;
  agentWorkRuntime?: AgentWorkRuntime;
  observability: LocalObservability;
  close(): Promise<void>;
}

/**
 * Bring up the full daemon: open the SQLite store, spawn the adapter-host child,
 * build engine + daemon, optionally start the Agent Work runtime, and listen on
 * the Unix control socket. Partial-startup failures unwind in reverse. Each socket
 * connection carries exactly one request line (see `handleRequestLine`).
 */
export async function startDaemonServer({
  homePath,
  pidPath,
  socketPath,
  storePath,
  manifestPath,
  hostEntrypoint,
  logging,
  agentWork,
  adapterHostRestartDelaysMs = DEFAULT_ADAPTER_HOST_RESTART_DELAYS_MS
}: StartDaemonServerOptions): Promise<DaemonApplication> {
  if (adapterHostRestartDelaysMs.length === 0 || adapterHostRestartDelaysMs.some(delay => delay < 1)) {
    throw new Error("adapterHostRestartDelaysMs must contain positive delays");
  }
  // Construct observability before every other owned resource. Startup failures
  // are otherwise the most difficult failures to diagnose and would leave no
  // durable evidence.
  const loggingConfiguration: ObservabilityConfiguration = logging ?? {
    directory: join(dirname(storePath), "logs"),
    ...DEFAULT_OBSERVABILITY_CONFIGURATION
  };
  const observability = new LocalObservability({ ...loggingConfiguration, component: "daemon" });
  observability.log({
    level: "info",
    scope: "daemon.lifecycle",
    event: "daemon.starting",
    message: "daemon starting",
    data: { socket_path: socketPath, store_path: storePath, manifest_path: manifestPath }
  });
  let releasePid = (): Promise<void> => Promise.resolve();
  try {
    if (pidPath) releasePid = await acquirePidFile(pidPath);
    if (process.platform !== "win32") {
      await mkdir(dirname(socketPath), { recursive: true });
      try {
        const stat = await lstat(socketPath);
        if (!stat.isSocket()) throw new Error(`refusing to replace non-socket path: ${socketPath}`);
        await rm(socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } catch (error) {
    observability.log({
      level: "error",
      scope: "daemon.lifecycle",
      event: "daemon.start.failed",
      message: "daemon failed before opening its store",
      data: { error: errorMessage(error) }
    });
    await releasePid();
    await observability.close();
    throw error;
  }

  let store: SqliteStore;
  try {
    store = SqliteStore.open(storePath);
  } catch (error) {
    await releasePid();
    observability.log({
      level: "error",
      scope: "daemon.lifecycle",
      event: "daemon.start.failed",
      message: "daemon store failed to open",
      data: { error: errorMessage(error) }
    });
    await observability.close();
    throw error;
  }
  const spawnHost = (): Promise<AdapterHostProcess> => spawnAdapterHost({
    entrypoint: hostEntrypoint,
    manifest: manifestPath,
    env: { ...process.env, ...observabilityEnvironment(loggingConfiguration) },
    ...(loggingConfiguration.traceRpc ? {
      trace: (direction, frame) => observability.traceRpc(direction, frame)
    } : {})
  });
  let hostProcess: AdapterHostProcess;
  try {
    // The adapter host writes its own component stream, but inherits the exact
    // same privacy, retention and capture policy as the daemon. RPC frames at
    // this boundary are recorded by the parent so request/response ordering is
    // preserved from the daemon's point of view.
    hostProcess = await spawnHost();
  } catch (error) {
    store.close();
    await releasePid();
    observability.log({
      level: "error",
      scope: "daemon.lifecycle",
      event: "daemon.start.failed",
      message: "adapter host failed to start",
      data: { error: errorMessage(error) }
    });
    await observability.close();
    throw error;
  }
  let adapters: string[];
  try {
    adapters = (await hostProcess.client.list()).map(adapter => adapter.type);
  } catch (error) {
    await hostProcess.close();
    store.close();
    await releasePid();
    observability.log({
      level: "error",
      scope: "daemon.lifecycle",
      event: "daemon.start.failed",
      message: "adapter host readiness check failed",
      data: { error: errorMessage(error) }
    });
    await observability.close();
    throw error;
  }
  const runtime: DaemonRuntimeInfo = {
    homePath,
    pidPath,
    socketPath,
    storePath,
    manifestPath,
    adapterHost: {
      pid: hostProcess.child.pid ?? null,
      entrypoint: hostEntrypoint,
      state: "ready",
      restartAttempt: 0
    },
    adapters
  };
  let shuttingDown = false;
  let hostRestartAttempt = 0;
  let hostRestartAbort: AbortController | undefined;
  let hostRestartTask: Promise<AdapterHostProcess> | undefined;
  let hostStableReset: NodeJS.Timeout | undefined;
  let hostReady: Promise<AdapterHostProcess> = Promise.resolve(hostProcess);
  const host: AdapterHostRpc = {
    list: async () => (await hostReady).client.list(),
    probe: async adapterType => (await hostReady).client.probe(adapterType),
    cancel: async (invocationId, reason) => (await hostReady).client.cancel(invocationId, reason),
    async *invoke(adapterType, request) {
      yield* (await hostReady).client.invoke(adapterType, request);
    }
  };

  const restartAdapterHost = async (signal: AbortSignal): Promise<AdapterHostProcess> => {
    while (!shuttingDown && !signal.aborted) {
      const attempt = ++hostRestartAttempt;
      const restartDelay = adapterHostRestartDelayMs(attempt, adapterHostRestartDelaysMs);
      runtime.adapterHost.restartAttempt = attempt;
      observability.log({
        level: "warn",
        scope: "adapter-host.lifecycle",
        event: "adapter_host.restart_scheduled",
        message: "adapter-host restart scheduled",
        data: { restart_attempt: attempt, restart_delay_ms: restartDelay }
      });
      try {
        await abortableDelay(restartDelay, signal);
        const replacement = await spawnHost();
        if (shuttingDown || signal.aborted) {
          await replacement.close();
          throw new Error("adapter-host restart cancelled");
        }
        let replacementAdapters: string[];
        try {
          replacementAdapters = (await replacement.client.list()).map(adapter => adapter.type);
        } catch (error) {
          await replacement.close();
          throw error;
        }
        if (shuttingDown || signal.aborted) {
          await replacement.close();
          throw new Error("adapter-host restart cancelled");
        }
        hostProcess = replacement;
        runtime.adapterHost.pid = replacement.child.pid ?? null;
        runtime.adapterHost.state = "ready";
        runtime.adapters = replacementAdapters;
        monitorAdapterHost(replacement);
        observability.log({
          level: "info",
          scope: "adapter-host.lifecycle",
          event: "adapter_host.restarted",
          message: "adapter-host restarted",
          data: { adapter_host_pid: replacement.child.pid ?? null, restart_attempt: attempt }
        });
        hostStableReset = setTimeout(() => {
          if (hostProcess === replacement && runtime.adapterHost.state === "ready") {
            hostRestartAttempt = 0;
            runtime.adapterHost.restartAttempt = 0;
          }
        }, ADAPTER_HOST_STABLE_RESET_MS);
        hostStableReset.unref();
        return replacement;
      } catch (error) {
        if (shuttingDown || signal.aborted) throw error;
        observability.log({
          level: "error",
          scope: "adapter-host.lifecycle",
          event: "adapter_host.restart_failed",
          message: "adapter-host restart attempt failed",
          data: { restart_attempt: attempt, error: errorMessage(error) }
        });
      }
    }
    throw new Error("adapter-host restart cancelled");
  };

  const handleAdapterHostExit = (
    exited: AdapterHostProcess,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void => {
    if (shuttingDown || exited !== hostProcess) return;
    if (hostStableReset) clearTimeout(hostStableReset);
    hostStableReset = undefined;
    const error = new Error(`adapter-host exited unexpectedly (${code ?? signal ?? "unknown"})`);
    exited.client.close(error);
    runtime.adapterHost.pid = null;
    runtime.adapterHost.state = "restarting";
    observability.log({
      level: "error",
      scope: "adapter-host.lifecycle",
      event: "adapter_host.unexpected_exit",
      message: "adapter-host exited unexpectedly; restarting inside daemon",
      data: { exit_code: code, signal }
    });
    const controller = new AbortController();
    hostRestartAbort = controller;
    const restart = restartAdapterHost(controller.signal);
    hostRestartTask = restart;
    hostReady = restart;
    void restart.catch(() => undefined);
  };

  function monitorAdapterHost(process: AdapterHostProcess): void {
    process.child.once("exit", (code, signal) => handleAdapterHostExit(process, code, signal));
  }

  monitorAdapterHost(hostProcess);
  const engine = new HarnessEngine({ store, host });
  const daemon = new HarnessDaemon({ engine, store });
  const agentWorkRuntime = agentWork
    ? new AgentWorkRuntime(agentWork, host, observability)
    : undefined;
  const viewerIndex = new ViewerLogIndex(loggingConfiguration.directory);
  // HarnessDaemon events mark execution, rather than submission, boundaries.
  // A control request can therefore be acknowledged before `run.started` while
  // the resulting Run still remains correlated by its stable runId.
  daemon.on("agent_run.started", ({ agentRunId }: { agentRunId: string }) => {
    const run = store.getAgentRun(agentRunId);
    observability.log({
      level: "info",
      scope: "run.execution",
      event: "run.execution.started",
      message: "run execution started",
      runId: agentRunId,
      agentSessionId: run?.agentSessionId,
      data: { priorStatus: run?.status ?? "unknown" }
    });
  });
  daemon.on("agent_run.terminal", ({ agentRunId, status }: { agentRunId: string; status?: string }) => {
    const run = store.getAgentRun(agentRunId);
    observability.log({
      level: status === "completed" ? "info" : "error",
      scope: "run.execution",
      event: status === "completed" ? "run.execution.completed" : "run.execution.failed",
      message: status === "completed" ? "run execution completed" : "run execution ended unsuccessfully",
      runId: agentRunId,
      agentSessionId: run?.agentSessionId,
      data: { status: status ?? run?.status ?? "unknown" }
    });
  });

  const server = net.createServer(socket => {
    // A connection id scopes transport evidence only. AgentRun, AgentSession and
    // invocation ids retain their domain meanings and may span other transports.
    const connectionId = `conn_${randomUUID()}`;
    observability.log({
      level: "info",
      scope: "transport.unix",
      event: "transport.connection.opened",
      message: "daemon control connection opened",
      data: {
        connection_id: connectionId,
        transport: "unix",
        local_path: socketPath
      }
    });
    socket.once("close", () => observability.log({
      level: "info",
      scope: "transport.unix",
      event: "transport.connection.closed",
      message: "daemon control connection closed",
      data: { connection_id: connectionId, transport: "unix" }
    }));
    createInterface({ input: socket }).once("line", line => {
      void handleRequestLine({
        line,
        socket,
        daemon,
        store,
        host,
        runtime,
        agentWorkRuntime,
        observability,
        viewerIndex,
        connectionId
      });
    });
  });

  try {
    await daemon.recover();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    // The Unix socket is the only local access boundary for the control plane;
    // 0600 restricts it to the current host account (there is no RBAC above it).
    if (process.platform !== "win32") await chmod(socketPath, 0o600);
    await agentWorkRuntime?.start();
    observability.log({
      level: "info",
      scope: "daemon.lifecycle",
      event: "daemon.ready",
      message: "daemon ready",
      data: {
        socket_path: socketPath,
        adapter_host_pid: hostProcess.child.pid ?? null,
        adapters
      }
    });
  } catch (error) {
    shuttingDown = true;
    hostRestartAbort?.abort();
    if (hostStableReset) clearTimeout(hostStableReset);
    observability.log({
      level: "error",
      scope: "daemon.lifecycle",
      event: "daemon.start.failed",
      message: "daemon failed to start",
      data: { error: errorMessage(error) }
    });
    daemon.stop();
    await agentWorkRuntime?.close();
    await hostProcess.close();
    store.close();
    if (process.platform !== "win32") await rm(socketPath, { force: true });
    await releasePid();
    await observability.close();
    throw error;
  }

  return {
    server,
    store,
    daemon,
    engine,
    get hostProcess(): AdapterHostProcess {
      return hostProcess;
    },
    runtime,
    agentWorkRuntime,
    observability,
    async close(): Promise<void> {
      shuttingDown = true;
      hostRestartAbort?.abort();
      if (hostStableReset) clearTimeout(hostStableReset);
      observability.log({
        level: "info",
        scope: "daemon.lifecycle",
        event: "daemon.stopping",
        message: "daemon stopping"
      });
      daemon.stop();
      await agentWorkRuntime?.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await hostRestartTask?.catch(() => undefined);
      await hostProcess.close();
      store.close();
      if (process.platform !== "win32") await rm(socketPath, { force: true });
      await releasePid();
      observability.log({
        level: "info",
        scope: "daemon.lifecycle",
        event: "daemon.stopped",
        message: "daemon stopped"
      });
      await observability.close();
    }
  };
}

/** Handle one request line. `run.stream` keeps the socket open and pushes many
 * lines; every other method sends a single `{ id, result }` (or `{ id, error }`)
 * and ends the socket. Errors carry an optional errno-style `code`. */
async function handleRequestLine({
  line,
  socket,
  daemon,
  store,
  host,
  runtime,
  agentWorkRuntime,
  observability,
  viewerIndex,
  connectionId
}: {
  line: string;
  socket: net.Socket;
  daemon: HarnessDaemon;
  store: Store;
  host: AdapterHostRpc;
  runtime: DaemonRuntimeInfo;
  agentWorkRuntime: AgentWorkRuntime | undefined;
  observability: LocalObservability;
  viewerIndex: ViewerLogIndex;
  connectionId: string;
}): Promise<void> {
  let request: DaemonRequest | undefined;
  try {
    request = parseRequest(line);
    // Do not observe the observation query itself. The Viewer polls this method;
    // recording each poll would create an unbounded feedback loop and bury the
    // application events the operator is trying to inspect.
    const logsItself = request.method !== "logs.query" && request.method !== "logs.viewer";
    if (logsItself) {
      observability.log({
        level: "debug",
        scope: "control.request",
        event: "control.request.received",
        message: "daemon control request received",
        runId: optionalString(request.params?.agentRunId),
        agentSessionId: optionalString(request.params?.agentSessionId),
        data: {
          connection_id: connectionId,
          request_id: typeof request.id === "string" || typeof request.id === "number" ? request.id : null,
          method: request.method
        }
      });
    }
    if (request.method === "agent_run.stream") {
      await streamRunEvents({ request, socket, store, observability, connectionId });
      return;
    }
    const result = await dispatch({
      request, daemon, store, host, runtime, agentWorkRuntime, observability, viewerIndex
    });
    const resultRecord = isRecord(result) ? result : {};
    const resultAgent = isRecord(resultRecord.agent) ? resultRecord.agent : undefined;
    if (logsItself) {
      observability.log({
        level: "info",
        scope: "control.request",
        event: "control.request.completed",
        message: "daemon control request completed",
        runId: optionalString(resultRecord.agentRunId) ?? optionalString(request.params?.agentRunId),
        agentSessionId: optionalString(request.params?.agentSessionId),
        adapterType: resultAgent ? optionalString(resultAgent.adapterType) : undefined,
        data: {
          connection_id: connectionId,
          method: request.method
        }
      });
    }
    socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
  } catch (error) {
    observability.log({
      level: "error",
      scope: "control.request",
      event: "control.request.failed",
      message: "daemon control request failed",
      runId: optionalString(request?.params?.agentRunId),
      agentSessionId: optionalString(request?.params?.agentSessionId),
      data: {
        connection_id: connectionId,
        method: request?.method ?? "unknown",
        error: errorMessage(error),
        code: (error as NodeJS.ErrnoException).code
      }
    });
    const rpcError = error as NodeJS.ErrnoException;
    socket.end(`${JSON.stringify({
      id: request?.id,
      error: { message: errorMessage(error), code: rpcError.code }
    })}\n`);
  }
}

/**
 * Tail an AgentRun's events over the socket. Polls the store, emitting each event with
 * `seq >= fromSeq` in order, then a terminal `{ done, run, nextSeq }` once a
 * terminal event or terminal run status is observed. `nextSeq` lets a client
 * resume without gaps. Stops early if the client disconnects.
 */
async function streamRunEvents({
  request,
  socket,
  store,
  observability,
  connectionId
}: {
  request: DaemonRequest;
  socket: net.Socket;
  store: Store;
  observability: LocalObservability;
  connectionId: string;
}): Promise<void> {
  const params = request.params ?? {};
  const runId = requiredString(params.agentRunId, "agentRunId");
  let nextSeq = positiveInteger(params.fromSeq, "fromSeq", 1);
  if (!store.getAgentRun(runId)) throw new Error(`agent run not found: ${runId}`);

  while (!socket.destroyed) {
    for (const event of store.getEvents(runId)) {
      if (event.seq < nextSeq) continue;
      await writeSocketLine(socket, { id: request.id, event });
      observability.log({
        level: "debug",
        scope: "run.stream",
        event: "run.event.streamed",
        message: "run event streamed to control client",
        runId,
        data: { connection_id: connectionId, event_type: event.type, event_seq: event.seq }
      });
      nextSeq = event.seq + 1;
      if (TERMINAL_EVENT_TYPES.has(event.type)) {
        await writeSocketLine(socket, {
          id: request.id,
          result: { done: true, run: store.getAgentRun(runId), nextSeq }
        });
        socket.end();
        return;
      }
    }

    const run = store.getAgentRun(runId);
    if (!run) throw new Error(`agent run not found: ${runId}`);
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

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("adapter-host restart cancelled"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("adapter-host restart cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Capped staircase for repeated adapter-host crashes. The last delay repeats
 * indefinitely so a local crash loop never exhausts the service-manager burst. */
export function adapterHostRestartDelayMs(
  attempt: number,
  delays: readonly number[] = DEFAULT_ADAPTER_HOST_RESTART_DELAYS_MS
): number {
  if (delays.length === 0) throw new Error("adapter-host restart delays must not be empty");
  const index = Math.max(0, Math.min(delays.length - 1, Math.trunc(attempt) - 1));
  return delays[index] ?? delays[delays.length - 1];
}

/** Route a parsed request to the engine, daemon or store. Read-only queries hit
 * the store directly; anything that mutates run state or scheduling goes through
 * the daemon so queueing and background execution stay centralized. */
async function dispatch({
  request,
  daemon,
  store,
  host,
  runtime,
  agentWorkRuntime,
  observability,
  viewerIndex
}: {
  request: DaemonRequest;
  daemon: HarnessDaemon;
  store: Store;
  host: AdapterHostRpc;
  runtime: DaemonRuntimeInfo;
  agentWorkRuntime: AgentWorkRuntime | undefined;
  observability: LocalObservability;
  viewerIndex: ViewerLogIndex;
}): Promise<unknown> {
  const params = request.params ?? {};
  switch (request.method) {
    case "status":
      return {
        ready: runtime.adapterHost.state === "ready",
        pid: process.pid,
        ...runtime,
        logging: observability.status,
        agentWork: agentWorkRuntime?.status ?? { enabled: false },
        lifecycle: daemon.status,
        counts: {
          agentSessions: store.listAgentSessions().length,
          agentRuns: store.listAgentRuns().length
        }
      };
    case "lifecycle.drain": {
      const timeoutMs = positiveInteger(params.timeoutMs, "timeoutMs", DEFAULT_DRAIN_TIMEOUT_MS);
      daemon.beginDrain();
      agentWorkRuntime?.beginDrain();
      await Promise.all([
        daemon.waitForDrained(timeoutMs),
        ...(agentWorkRuntime ? [agentWorkRuntime.waitForDrained(timeoutMs)] : [])
      ]);
      return {
        drained: true,
        local: daemon.status,
        agentWork: agentWorkRuntime?.status ?? { enabled: false }
      };
    }
    case "logs.path":
      return observability.status;
    case "logs.query":
      // Sensitive provider/RPC streams remain opt-in even though this control
      // socket is local. Callers must explicitly cross the privacy boundary.
      return observability.query({
        runId: optionalString(params.runId),
        invocationId: optionalString(params.invocationId),
        includeSensitive: params.includeSensitive === true,
        ...(typeof params.limit === "number" ? { limit: params.limit } : {})
      });
    case "logs.viewer":
      return viewerTraceSnapshot({ store, index: viewerIndex, params });
    case "adapter.list":
      return host.list();
    case "adapter.probe":
      return host.probe(requiredString(params.adapterType, "adapterType"));
    case "agent_session.list":
      return store.listAgentSessions();
    case "agent_session.get":
      return store.getAgentSession(requiredString(params.agentSessionId, "agentSessionId")) ?? null;
    case "agent_run.list":
      return store.listAgentRuns();
    case "agent_run.get":
      return store.getAgentRun(requiredString(params.agentRunId, "agentRunId")) ?? null;
    case "agent_run.events":
      return store.getEvents(requiredString(params.agentRunId, "agentRunId"));
    case "agent_run.wait":
      return daemon.waitForRun(requiredString(params.agentRunId, "agentRunId"));
    case "agent_run.cancel":
      return daemon.cancelRun(requiredString(params.agentRunId, "agentRunId"), optionalString(params.reason));
    default:
      throw Object.assign(new Error(`unknown daemon method: ${request.method}`), { code: "method_not_found" });
  }
}

function parseRequest(line: string): DaemonRequest {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || typeof value.method !== "string") throw new TypeError("daemon request requires method");
  return value as unknown as DaemonRequest;
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

async function acquirePidFile(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(`${process.pid}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      if (process.platform !== "win32") await chmod(path, 0o600);
      return async () => {
        try {
          const owner = Number((await readFile(path, "utf8")).trim());
          if (owner === process.pid) await rm(path, { force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readPid(path);
      if (owner !== undefined && processAlive(owner)) {
        throw new Error(`Octo Harness daemon is already running with pid ${owner}`, { cause: error });
      }
      await rm(path, { force: true });
    }
  }
  throw new Error(`could not acquire daemon pid file: ${path}`);
}

async function readPid(path: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(path, "utf8")).trim());
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

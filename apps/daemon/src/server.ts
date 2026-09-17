import net, { type Server } from "node:net";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { chmod, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DEFAULT_OBSERVABILITY_CONFIGURATION,
  LocalObservability,
  observabilityEnvironment,
  type ObservabilityConfiguration,
  type RecordEnvelope
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
import type { AgentWorkRuntimeOptions } from "./agent-work-runtime.js";
import { AgentWorkSupervisor } from "./agent-work-supervisor.js";
import { InspectServer } from "./inspect-server.js";
import { LIVE_EVENT_SOURCES, LiveEventBus, type LiveEventSource } from "./live-event-bus.js";

export {
  LiveEventBus,
  LIVE_EVENT_MAX_FRAME_BYTES,
  LIVE_EVENT_MAX_SLOTS,
  LIVE_EVENT_MAX_SUBSCRIBERS,
  LIVE_EVENT_CONTROL_RESERVE_BYTES,
  LIVE_EVENT_MEMORY_BYTES
} from "./live-event-bus.js";

export interface StartDaemonServerOptions {
  homePath?: string;
  pidPath?: string;
  /** Enables the interactive console sink when launched in the foreground. */
  consoleOutput?: boolean;
  socketPath: string;
  storePath: string;
  manifestPath: string;
  hostEntrypoint: string;
  /** Address used by the daemon-owned HTTP/WebSocket inspector. */
  inspectHost?: string;
  /** Fixed inspector port. When omitted, a random port above 20000 is chosen. */
  inspectPort?: number;
  logging?: ObservabilityConfiguration;
  /** Optional foreground-only sink for already-redacted operational records. */
  operationalSink?: (record: RecordEnvelope) => void;
  /** Enabled managed profiles. All runtimes share this daemon and adapter host. */
  agentWorks?: AgentWorkRuntimeOptions[];
  /** Compatibility input for embedders that configure one unmanaged runtime. */
  agentWork?: AgentWorkRuntimeOptions;
  /** Test/embedding override for the capped adapter-host restart schedule. */
  adapterHostRestartDelaysMs?: readonly number[];
  /** Maximum adapter-host RPC readiness handshake time. */
  adapterHostReadyTimeoutMs?: number;
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
  agentWorkSupervisor?: AgentWorkSupervisor;
  observability: LocalObservability;
  events: LiveEventBus;
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
  inspectHost,
  inspectPort,
  logging,
  operationalSink,
  agentWorks,
  agentWork,
  adapterHostRestartDelaysMs = DEFAULT_ADAPTER_HOST_RESTART_DELAYS_MS,
  adapterHostReadyTimeoutMs
}: StartDaemonServerOptions): Promise<DaemonApplication> {
  if (adapterHostRestartDelaysMs.length === 0 ||
      adapterHostRestartDelaysMs.some(delay => !Number.isFinite(delay) || delay < 1)) {
    throw new Error("adapterHostRestartDelaysMs must contain positive delays");
  }
  // Construct observability before every other owned resource. Startup failures
  // are otherwise the most difficult failures to diagnose and would leave no
  // durable evidence.
  const loggingConfiguration: ObservabilityConfiguration = logging ?? {
    directory: join(dirname(storePath), "logs"),
    ...DEFAULT_OBSERVABILITY_CONFIGURATION
  };
  const events = new LiveEventBus();
  const observability = new LocalObservability(
    { ...loggingConfiguration, component: "daemon" },
    { operationalSink, eventSink: record => events.publishRecord(record) }
  );
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
  const spawnHost = (signal?: AbortSignal): Promise<AdapterHostProcess> => spawnAdapterHost({
    entrypoint: hostEntrypoint,
    manifest: manifestPath,
    env: { ...process.env, ...observabilityEnvironment(loggingConfiguration) },
    ...(signal ? { signal } : {}),
    ...(adapterHostReadyTimeoutMs !== undefined ? { readyTimeoutMs: adapterHostReadyTimeoutMs } : {}),
    trace: (direction, frame) => observability.traceRpc(direction, frame),
    observe: frame => publishAdapterObservation(events, frame)
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
    adapters = hostProcess.adapters.map(adapter => adapter.type);
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
  const readyHost = (): AdapterHostProcess => {
    if (runtime.adapterHost.state !== "ready") {
      throw Object.assign(new Error("adapter-host is restarting"), { code: "ADAPTER_HOST_RESTARTING" });
    }
    return hostProcess;
  };
  const host: AdapterHostRpc = {
    list: async () => readyHost().client.list(),
    probe: async adapterType => readyHost().client.probe(adapterType),
    cancel: async (invocationId, reason) => readyHost().client.cancel(invocationId, reason),
    async *invoke(adapterType, request) {
      for await (const event of readyHost().client.invoke(adapterType, request)) {
        events.publish({
          source: "host-canonical",
          stage: "host.canonical",
          direction: "outbound",
          type: event.type,
          profile: optionalString(request.context?.profile),
          runtimeId: optionalString(request.context?.runtimeId),
          runId: request.runId,
          agentSessionId: request.agentSessionId,
          invocationId: request.invocationId,
          adapterType,
          payload: event
        });
        if (["run.finished", "run.error", "run.stopped"].includes(event.type)) {
          observability.clearRpcCorrelationForRun(request.runId);
        }
        yield event;
      }
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
        const replacement = await spawnHost(signal);
        if (shuttingDown || signal.aborted) {
          await replacement.close();
          throw new Error("adapter-host restart cancelled");
        }
        const replacementAdapters = replacement.adapters.map(adapter => adapter.type);
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
    observability.clearRpcCorrelation();
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
    void restart.catch(() => undefined);
  };

  function monitorAdapterHost(process: AdapterHostProcess): void {
    process.child.once("exit", (code, signal) => handleAdapterHostExit(process, code, signal));
  }

  monitorAdapterHost(hostProcess);
  const engine = new HarnessEngine({ store, host });
  const daemon = new HarnessDaemon({ engine, store });
  const configuredAgentWorks = agentWorks ?? (agentWork ? [agentWork] : []);
  const agentWorkSupervisor = configuredAgentWorks.length > 0
    ? new AgentWorkSupervisor(configuredAgentWorks, host, observability)
    : undefined;
  const inspect = new InspectServer(
    events,
    () => ({
      ready: runtime.adapterHost.state === "ready",
      pid: process.pid,
      adapterHost: runtime.adapterHost,
      adapters: runtime.adapters,
      agentWork: agentWorkSupervisor?.status ?? { enabled: false, runtimes: [] },
      lifecycle: daemon.status
    }),
    runId => observability.query({
      ...(runId ? { runId } : {}),
      includeSensitive: false,
      limit: 500,
      maxBytes: 2 * 1024 * 1024
    }),
    { host: inspectHost, port: inspectPort }
  );
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

  const connections = new Set<net.Socket>();
  const server = net.createServer(socket => {
    connections.add(socket);
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
    socket.once("close", () => {
      connections.delete(socket);
      observability.log({
        level: "info",
        scope: "transport.unix",
        event: "transport.connection.closed",
        message: "daemon control connection closed",
        data: { connection_id: connectionId, transport: "unix" }
      });
    });
    createInterface({ input: socket }).once("line", line => {
      void handleRequestLine({
        line,
        socket,
        daemon,
        store,
        host,
        runtime,
        agentWorkSupervisor,
        observability,
        events,
        inspect,
        connectionId
      });
    });
  });

  try {
    const inspectInfo = await inspect.start();
    await daemon.recover();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    // The Unix socket is the only local access boundary for the control plane;
    // 0600 restricts it to the current host account (there is no RBAC above it).
    if (process.platform !== "win32") await chmod(socketPath, 0o600);
    await agentWorkSupervisor?.start();
    observability.log({
      level: "info",
      scope: "daemon.lifecycle",
      event: "daemon.ready",
      message: "daemon ready",
      data: {
        pid: process.pid,
        home_path: homePath,
        log_directory: loggingConfiguration.directory,
        socket_path: socketPath,
        adapter_host_pid: hostProcess.child.pid ?? null,
        adapters,
        inspect: { host: inspectInfo.host, port: inspectInfo.port }
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
    await agentWorkSupervisor?.close();
    await inspect.close();
    await hostRestartTask?.catch(() => undefined);
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
    agentWorkSupervisor,
    observability,
    events,
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
      await agentWorkSupervisor?.close();
      await inspect.close();
      for (const connection of connections) connection.destroy();
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

/** Handle one request line. `events.subscribe` keeps the socket open and pushes many
 * lines; every other method sends a single `{ id, result }` (or `{ id, error }`)
 * and ends the socket. Errors carry an optional errno-style `code`. */
async function handleRequestLine({
  line,
  socket,
  daemon,
  store,
  host,
  runtime,
  agentWorkSupervisor,
  observability,
  events,
  inspect,
  connectionId
}: {
  line: string;
  socket: net.Socket;
  daemon: HarnessDaemon;
  store: Store;
  host: AdapterHostRpc;
  runtime: DaemonRuntimeInfo;
  agentWorkSupervisor: AgentWorkSupervisor | undefined;
  observability: LocalObservability;
  events: LiveEventBus;
  inspect: InspectServer;
  connectionId: string;
}): Promise<void> {
  let request: DaemonRequest | undefined;
  try {
    request = parseRequest(line);
    // Do not observe the observation query itself. The Viewer polls this method;
    // recording each poll would create an unbounded feedback loop and bury the
    // application events the operator is trying to inspect.
    const logsItself = request.method !== "logs.query" && request.method !== "events.subscribe";
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
    if (request.method === "events.subscribe") {
      await streamLiveEvents({ request, socket, events });
      return;
    }
    const result = await dispatch({
      request, daemon, store, host, runtime, agentWorkSupervisor, observability, inspect, events
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
 * Emit the currently retained in-memory event snapshot and optionally follow it.
 * No SQLite query is involved; a disconnected client owns no queued payloads.
 */
async function streamLiveEvents({
  request,
  socket,
  events
}: {
  request: DaemonRequest;
  socket: net.Socket;
  events: LiveEventBus;
}): Promise<void> {
  const params = request.params ?? {};
  const runId = optionalString(params.runId);
  const source = optionalLiveEventSource(params.source);
  const follow = params.follow === true;
  let count = 0;
  const controller = new AbortController();
  socket.once("close", () => controller.abort());
  for await (const event of events.subscribeBytes({ runId, source }, follow, controller.signal)) {
    if (socket.destroyed) return;
    await writeSocketEvent(socket, request.id, event);
    count += 1;
  }
  await writeSocketLine(socket, { id: request.id, result: { done: true, count, memory: events.stats } });
  socket.end();
}

async function writeSocketEvent(socket: net.Socket, id: unknown, event: Buffer): Promise<void> {
  const prefix = Buffer.from(`{"id":${JSON.stringify(id)},"event":`);
  const parts = [prefix, ...bufferChunks(event, 16 * 1024), Buffer.from("}\n")];
  for (const chunk of parts) {
    if (socket.destroyed) return;
    if (!socket.write(chunk)) await waitForDrain(socket, 5_000);
  }
}

function bufferChunks(value: Buffer, size: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < value.byteLength; offset += size) {
    chunks.push(value.subarray(offset, Math.min(offset + size, value.byteLength)));
  }
  return chunks;
}

async function writeSocketLine(socket: net.Socket, value: unknown): Promise<void> {
  if (socket.destroyed) return;
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`);
  for (let offset = 0; offset < encoded.byteLength; offset += 16 * 1024) {
    if (socket.destroyed) return;
    const chunk = encoded.subarray(offset, Math.min(offset + 16 * 1024, encoded.byteLength));
    const writable = socket.write(chunk);
    if (!writable) await waitForDrain(socket, 5_000);
  }
}

function waitForDrain(socket: net.Socket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("drain", onDrain);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onClose = (): void => { cleanup(); reject(new Error("daemon event client disconnected")); };
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(Object.assign(new Error("daemon event client drain timed out"), { code: "EVENT_DRAIN_TIMEOUT" }));
    }, timeoutMs);
    timer.unref();
    socket.once("drain", onDrain);
    socket.once("error", onError);
    socket.once("close", onClose);
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
  if (delays.length === 0 || delays.some(delay => !Number.isFinite(delay) || delay < 1)) {
    throw new Error("adapter-host restart delays must contain positive values");
  }
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
  agentWorkSupervisor,
  observability,
  inspect,
  events
}: {
  request: DaemonRequest;
  daemon: HarnessDaemon;
  store: Store;
  host: AdapterHostRpc;
  runtime: DaemonRuntimeInfo;
  agentWorkSupervisor: AgentWorkSupervisor | undefined;
  observability: LocalObservability;
  inspect: InspectServer;
  events: LiveEventBus;
}): Promise<unknown> {
  const params = request.params ?? {};
  switch (request.method) {
    case "status":
      return {
        ready: runtime.adapterHost.state === "ready",
        pid: process.pid,
        ...runtime,
        logging: observability.status,
        agentWork: agentWorkSupervisor?.status ?? { enabled: false, runtimes: [] },
        lifecycle: daemon.status,
        events: events.stats,
        counts: {
          agentSessions: store.listAgentSessions().length,
          agentRuns: store.listAgentRuns().length
        }
      };
    case "lifecycle.drain": {
      const timeoutMs = positiveInteger(params.timeoutMs, "timeoutMs", DEFAULT_DRAIN_TIMEOUT_MS);
      daemon.beginDrain();
      agentWorkSupervisor?.beginDrain();
      await Promise.all([
        daemon.waitForDrained(timeoutMs),
        ...(agentWorkSupervisor ? [agentWorkSupervisor.waitForDrained(timeoutMs)] : [])
      ]);
      return {
        drained: true,
        local: daemon.status,
        agentWork: agentWorkSupervisor?.status ?? { enabled: false, runtimes: [] }
      };
    }
    case "logs.path":
      return observability.status;
    case "logs.query":
      // Sensitive provider/RPC streams remain opt-in even though this control
      // socket is local. Callers must explicitly cross the privacy boundary.
      return observability.query({
        requestId: optionalString(params.requestId),
        runId: optionalString(params.runId),
        invocationId: optionalString(params.invocationId),
        includeSensitive: params.includeSensitive === true,
        ...(typeof params.limit === "number" ? { limit: params.limit } : {})
      });
    case "inspect.info": {
      const info = inspect.info;
      if (!info) throw new Error("inspect server is not listening");
      return info;
    }
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

function optionalLiveEventSource(value: unknown): LiveEventSource | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(LIVE_EVENT_SOURCES as readonly string[]).includes(value)) {
    throw new TypeError("source must be a supported live event source");
  }
  return value as LiveEventSource;
}

function publishAdapterObservation(events: LiveEventBus, value: unknown): void {
  if (!isRecord(value)) return;
  if (typeof value.droppedBefore === "number" && value.droppedBefore > 0) {
    events.publish({
      source: "control",
      type: "adapter_observation.dropped",
      payload: { count: value.droppedBefore, affected_source: value.source }
    });
  }
  if (value.source === "control" && typeof value.type === "string") {
    events.publish({ source: "control", type: value.type, payload: value.payload ?? {} });
    return;
  }
  if (value.source === "provider-native" && isRecord(value.record)) {
    events.publishRecord(value.record as RecordEnvelope, "provider-native");
    return;
  }
  if (value.source !== "adapter-canonical" || typeof value.type !== "string") return;
  events.publish({
    source: "adapter-canonical",
    stage: "adapter.canonical",
    direction: "outbound",
    type: value.type,
    profile: optionalString(value.profile),
    runtimeId: optionalString(value.runtimeId),
    runId: optionalString(value.runId),
    agentSessionId: optionalString(value.agentSessionId),
    invocationId: optionalString(value.invocationId),
    adapterType: optionalString(value.adapterType),
    payload: value.payload
  });
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

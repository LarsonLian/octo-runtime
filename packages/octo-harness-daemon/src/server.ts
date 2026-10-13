import {
  spawnAdapterHost,
  type AdapterHostProcess,
  type AdapterHostRpc
} from "@mininglamp-oss/octo-harness-adapter-host";
import { HarnessEngine, SqliteStore, type Store } from "@mininglamp-oss/octo-harness-core";
import { ImChannelManager, type ImBotConfig, type ImCredentialSource } from "@mininglamp-oss/octo-harness-channel-im";
import {
  assertInteractionResponse,
  assertNativeInteractionResponse,
  createHostInvoke,
  resolveHostInvokeWireOptions,
  type InvokeRequest
} from "@mininglamp-oss/octo-harness-protocol";
import type { AgentWorkRuntimeOptions } from "@mininglamp-oss/octo-harness-worker-access/agent-work-runtime";
import { AgentWorkSupervisor } from "@mininglamp-oss/octo-harness-worker-access/agent-work-supervisor";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import net, { type Server } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { HostRunService } from "./host-run-service.js";
import { InvocationManifest } from "./invocation-manifest.js";
import { HarnessDaemon } from "./runtime-core.js";

export interface StartDaemonServerOptions {
  /** 宿主显式提供 IM 登记；省略即关闭接入，公共 Daemon 不自动发现客户配置文件。 */
  imBots?: ImBotConfig[];
  imCredentials?: ImCredentialSource;
  homePath?: string;
  pidPath?: string;
  /** Enables foreground lifecycle messages when launched in the foreground. */
  consoleOutput?: boolean;
  socketPath: string;
  storePath: string;
  manifestPath: string;
  hostEntrypoint: string;
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
  im: ImChannelManager;
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
  imBots,
  imCredentials,
  pidPath,
  socketPath,
  storePath,
  manifestPath,
  hostEntrypoint,
  consoleOutput = false,
  agentWorks,
  agentWork,
  adapterHostRestartDelaysMs = DEFAULT_ADAPTER_HOST_RESTART_DELAYS_MS,
  adapterHostReadyTimeoutMs
}: StartDaemonServerOptions): Promise<DaemonApplication> {
  if (
    adapterHostRestartDelaysMs.length === 0 ||
    adapterHostRestartDelaysMs.some((delay) => !Number.isFinite(delay) || delay < 1)
  ) {
    throw new Error("adapterHostRestartDelaysMs must contain positive delays");
  }
  // 配置来源属于宿主：CLI 可读 im.json，SDK 应用可动态登记，Daemon 只接收结果。
  const configuredImBots = imBots ?? [];
  let releasePid = (): Promise<void> => Promise.resolve();
  let invocationManifest: InvocationManifest;
  const invocationManifestPath = join(homePath ?? dirname(storePath), "run", "invocations.json");
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
    const openedManifest = await InvocationManifest.open(invocationManifestPath);
    invocationManifest = openedManifest.manifest;
    if (openedManifest.reap.found) {
      console.error(
        openedManifest.reap.reaped
          ? "reaped orphaned adapter-host process group"
          : "cleared stale invocation manifest",
        { pid: openedManifest.reap.pid, reason: openedManifest.reap.reason }
      );
    }
  } catch (error) {
    await releasePid();
    throw error;
  }

  let store: SqliteStore;
  try {
    store = SqliteStore.open(storePath, {
      recordRunEvents: process.env.OCTO_RECORD_RUN_STEPS === "1"
    });
  } catch (error) {
    await invocationManifest.close();
    await releasePid();
    throw error;
  }
  const spawnHost = async (signal?: AbortSignal): Promise<AdapterHostProcess> => {
    const spawned = await spawnAdapterHost({
      entrypoint: hostEntrypoint,
      manifest: manifestPath,
      env: { ...process.env, OCTO_HARNESS_HOME: homePath ?? dirname(storePath) },
      ...(signal ? { signal } : {}),
      ...(adapterHostReadyTimeoutMs !== undefined
        ? { readyTimeoutMs: adapterHostReadyTimeoutMs }
        : {})
    });
    await invocationManifest.setAdapterHost(spawned.child.pid, hostEntrypoint);
    return spawned;
  };
  let hostProcess: AdapterHostProcess;
  try {
    hostProcess = await spawnHost();
  } catch (error) {
    store.close();
    await invocationManifest.close();
    await releasePid();
    throw error;
  }
  let adapters: string[];
  try {
    adapters = hostProcess.adapters.map((adapter) => adapter.type);
  } catch (error) {
    await hostProcess.close();
    await invocationManifest.close();
    store.close();
    await releasePid();
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
      throw Object.assign(new Error("adapter-host is restarting"), {
        code: "ADAPTER_HOST_RESTARTING"
      });
    }
    return hostProcess;
  };
  const transportHost: AdapterHostRpc = {
    list: async () => readyHost().client.list(),
    probe: async (adapterType) => readyHost().client.probe(adapterType),
    cancel: async (invocationId, reason) => readyHost().client.cancel(invocationId, reason),
    respondInteraction: async (invocationId, response) =>
      readyHost().client.respondInteraction(invocationId, response),
    respondNative: async (invocationId, response) =>
      readyHost().client.respondNative(invocationId, response),
    prepare: (adapterType, request, options) =>
      readyHost().client.prepare(adapterType, request, options),
    invoke: createHostInvoke((type, request, options) =>
      transportHost.invokeFrames(type, request, options)
    ),
    async *invokeFrames(adapterType, request, options) {
      await invocationManifest.begin({
        invocationId: request.invocationId,
        runId: request.runId,
        adapterType
      });
      try {
        for await (const event of readyHost().client.invokeFrames(adapterType, request, options)) {
          yield event;
        }
      } finally {
        try {
          await invocationManifest.end(request.invocationId);
        } catch (error) {
          console.error("failed to remove completed invocation from the manifest", {
            error: errorMessage(error)
          });
        }
      }
    }
  };

  const restartAdapterHost = async (signal: AbortSignal): Promise<AdapterHostProcess> => {
    while (!shuttingDown && !signal.aborted) {
      const attempt = ++hostRestartAttempt;
      const restartDelay = adapterHostRestartDelayMs(attempt, adapterHostRestartDelaysMs);
      runtime.adapterHost.restartAttempt = attempt;
      console.error("adapter-host restart scheduled", {
        restart_attempt: attempt,
        restart_delay_ms: restartDelay
      });
      try {
        await abortableDelay(restartDelay, signal);
        const replacement = await spawnHost(signal);
        if (shuttingDown || signal.aborted) {
          await replacement.close();
          throw new Error("adapter-host restart cancelled");
        }
        const replacementAdapters = replacement.adapters.map((adapter) => adapter.type);
        if (shuttingDown || signal.aborted) {
          await replacement.close();
          throw new Error("adapter-host restart cancelled");
        }
        hostProcess = replacement;
        runtime.adapterHost.pid = replacement.child.pid ?? null;
        runtime.adapterHost.state = "ready";
        runtime.adapters = replacementAdapters;
        monitorAdapterHost(replacement);
        console.error("adapter-host restarted", {
          adapter_host_pid: replacement.child.pid ?? null,
          restart_attempt: attempt
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
        console.error("adapter-host restart attempt failed", {
          restart_attempt: attempt,
          error: errorMessage(error)
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
    void invocationManifest.setAdapterHost(undefined, hostEntrypoint).catch(() => undefined);
    console.error("adapter-host exited unexpectedly; restarting inside daemon", {
      exit_code: code,
      signal
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
  const host = new HostRunService(transportHost);
  const im = new ImChannelManager({ host, ...(imCredentials ? { credentials: imCredentials } : {}) });
  Object.defineProperty(runtime, "im", {
    enumerable: true,
    get: () => im.status
  });
  const engine = new HarnessEngine({ store, host });
  const daemon = new HarnessDaemon({ engine, store });
  const configuredAgentWorks = agentWorks ?? (agentWork ? [agentWork] : []);
  const agentWorkSupervisor =
    configuredAgentWorks.length > 0
      ? new AgentWorkSupervisor(configuredAgentWorks, host)
      : undefined;
  const connections = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections.add(socket);
    // A connection id scopes transport evidence only. AgentRun, AgentSession and
    // invocation ids retain their domain meanings and may span other transports.
    const connectionId = `conn_${randomUUID()}`;
    const input = createInterface({ input: socket });
    // A client may disconnect before an RPC finishes; close only its transport.
    socket.on("error", () => socket.destroy());
    input.on("error", () => socket.destroy());
    socket.once("close", () => {
      connections.delete(socket);
      input.close();
    });
    input.once("line", (line) => {
      void handleRequestLine({
        line,
        socket,
        daemon,
        store,
        host,
        runtime,
        im,
        agentWorkSupervisor,
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
    await agentWorkSupervisor?.start();
    for (const config of configuredImBots) await im.upsert(config, 1);
    if (consoleOutput)
      console.error("daemon ready", {
        pid: process.pid,
        home_path: homePath,
        socket_path: socketPath,
        adapter_host_pid: hostProcess.child.pid ?? null,
        adapters
      });
  } catch (error) {
    shuttingDown = true;
    hostRestartAbort?.abort();
    if (hostStableReset) clearTimeout(hostStableReset);
    daemon.stop();
    await im.close();
    await agentWorkSupervisor?.close();
    await host.close();
    await hostRestartTask?.catch(() => undefined);
    await hostProcess.close();
    await invocationManifest.close();
    store.close();
    if (process.platform !== "win32") await rm(socketPath, { force: true });
    await releasePid();
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
    im,
    async close(): Promise<void> {
      shuttingDown = true;
      hostRestartAbort?.abort();
      if (hostStableReset) clearTimeout(hostStableReset);
      if (consoleOutput) console.error("daemon stopping");
      daemon.stop();
      await im.close();
      await agentWorkSupervisor?.close();
      await host.close();
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await hostRestartTask?.catch(() => undefined);
      await hostProcess.close();
      await invocationManifest.close();
      store.close();
      if (process.platform !== "win32") await rm(socketPath, { force: true });
      await releasePid();
      if (consoleOutput) console.error("daemon stopped");
    }
  };
}

/** Handle one control request; invocation subscriptions stream until completion. */
async function handleRequestLine({
  line,
  socket,
  daemon,
  store,
  host,
  runtime,
  im,
  agentWorkSupervisor,
  connectionId
}: {
  line: string;
  socket: net.Socket;
  daemon: HarnessDaemon;
  store: Store;
  host: HostRunService;
  runtime: DaemonRuntimeInfo;
  im: ImChannelManager;
  agentWorkSupervisor: AgentWorkSupervisor | undefined;
  connectionId: string;
}): Promise<void> {
  let request: DaemonRequest | undefined;
  try {
    request = parseRequest(line);
    if (request.method === "agent_run.invoke" || request.method === "agent_run.subscribe") {
      if ((JSON.parse(line) as Record<string, unknown>).jsonrpc !== "2.0")
        throw new Error("JSON-RPC 2.0 required");
      if (request.method === "agent_run.invoke") {
        const invocation = request.params?.request as InvokeRequest;
        await host.submit(
          requiredString(request.params?.adapter_type, "adapter_type"),
          invocation,
          resolveHostInvokeWireOptions(request.params?.options)
        );
        request.params = { run_id: invocation.runId };
      }
      await streamAgentRun(request, socket, host);
      return;
    }
    const result = await dispatch({
      request,
      daemon,
      store,
      host,
      runtime,
      im,
      agentWorkSupervisor
    });
    if (!socket.destroyed && socket.writable)
      socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  } catch (error) {
    console.error("daemon control request failed", {
      connection_id: connectionId,
      method: request?.method ?? "unknown",
      error: errorMessage(error),
      code: (error as NodeJS.ErrnoException).code
    });
    const rpcError = error as NodeJS.ErrnoException;
    if (!socket.destroyed && socket.writable)
      socket.end(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request?.id,
          error: { message: errorMessage(error), code: rpcError.code }
        })}\n`
      );
  }
}

/**
 * Emit the currently retained in-memory event snapshot and optionally follow it.
 * No SQLite query is involved; a disconnected client owns no queued payloads.
 */
async function streamAgentRun(
  request: DaemonRequest,
  socket: net.Socket,
  host: HostRunService
): Promise<void> {
  if (
    request.params &&
    (Object.hasOwn(request.params, "options") || Object.hasOwn(request.params, "protocol_mode"))
  )
    throw new Error("EXECUTION_PROTOCOL_MISMATCH: subscription inherits the accepted mode");
  const runId = requiredString(request.params?.run_id, "run_id");
  let streamId = optionalString(request.params?.stream_id);
  const cursor = request.params?.after_seq ?? 0;
  if (typeof cursor !== "number") throw new Error("STREAM_CURSOR_INVALID");
  let after: number = cursor;
  const release = host.acquireSubscription();
  const subscriptionId = `sub_${randomUUID()}`;
  let started = false;
  socket.setTimeout(0); // Model silence is not a stalled socket write.
  try {
    while (!socket.destroyed) {
      const page = host.read(runId, streamId, after);
      streamId = page.stream_id;
      if (!started) {
        await writeSocketLine(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: { subscription_id: subscriptionId, ...page, events: undefined }
        });
        started = true;
      }
      for (const value of page.events) {
        await writeSocketLine(socket, {
          jsonrpc: "2.0",
          method: "agent_run.event",
          params: {
            subscription_id: subscriptionId,
            run_id: runId,
            stream_id: streamId,
            seq: value.seq,
            event: value.event
          }
        });
        after = value.seq;
      }
      if ((page.terminal || request.params?.follow === false) && after >= page.latest_seq) {
        socket.end();
        return;
      }
      if (!page.events.length)
        await new Promise<void>((resolve) => {
          const done = (): void => {
            clearTimeout(timer);
            socket.off("close", done);
            resolve();
          };
          const timer = setTimeout(done, 100);
          socket.once("close", done);
        });
    }
  } catch (error) {
    if (!socket.destroyed)
      socket.end(
        `${JSON.stringify({
          jsonrpc: "2.0",
          ...(started
            ? {
                method: "agent_run.stream_error",
                params: {
                  subscription_id: subscriptionId,
                  run_id: runId,
                  stream_id: streamId,
                  code: errorMessage(error),
                  ...((error as { data?: object }).data ?? {})
                }
              }
            : {
                id: request.id,
                error: {
                  code: -32001,
                  message: errorMessage(error),
                  data: (error as { data?: object }).data
                }
              })
        })}\n`
      );
  } finally {
    release();
  }
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
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("daemon event client disconnected"));
    };
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(
        Object.assign(new Error("daemon event client drain timed out"), {
          code: "EVENT_DRAIN_TIMEOUT"
        })
      );
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
  if (delays.length === 0 || delays.some((delay) => !Number.isFinite(delay) || delay < 1)) {
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
  im,
  agentWorkSupervisor
}: {
  request: DaemonRequest;
  daemon: HarnessDaemon;
  store: Store;
  host: HostRunService;
  runtime: DaemonRuntimeInfo;
  im: ImChannelManager;
  agentWorkSupervisor: AgentWorkSupervisor | undefined;
}): Promise<unknown> {
  const params = request.params ?? {};
  switch (request.method) {
    case "im.status":
      return im.status;
    case "im.upsert":
      return im.upsert(params.config as ImBotConfig, positiveInteger(params.revision, "revision", 1));
    case "im.remove":
      await im.remove(requiredString(params.id, "id"), positiveInteger(params.revision, "revision", 1));
      return { removed: true };
    case "status":
      return {
        ready: runtime.adapterHost.state === "ready",
        pid: process.pid,
        ...runtime,
        agentWork: agentWorkSupervisor?.status ?? { enabled: false, runtimes: [] },
        lifecycle: daemon.status,
        counts: {
          agentSessions: store.listAgentSessions().length,
          agentRuns: store.listAgentRuns().length
        }
      };
    case "lifecycle.drain": {
      const timeoutMs = positiveInteger(params.timeoutMs, "timeoutMs", DEFAULT_DRAIN_TIMEOUT_MS);
      daemon.beginDrain();
      host.beginDrain();
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
    case "adapter.list":
      return host.list();
    case "adapter.probe":
      return host.probe(requiredString(params.adapterType, "adapterType"));
    case "agent_session.list":
      return store.listAgentSessions();
    case "agent_session.get":
      return store.getAgentSession(requiredString(params.agentSessionId, "agentSessionId")) ?? null;
    case "agent_run.submit":
      return host.submit(
        requiredString(params.adapter_type, "adapter_type"),
        params.request as InvokeRequest,
        resolveHostInvokeWireOptions(params.options)
      );
    case "agent_run.native.respond":
      assertNativeInteractionResponse(params.response);
      await host.respondNativeRun(requiredString(params.run_id, "run_id"), params.response);
      return { accepted: true };
    case "agent_run.respond":
      assertInteractionResponse(params.response);
      await host.respond(requiredString(params.run_id, "run_id"), params.response);
      return { accepted: true };
    case "agent_run.list":
      return store.listAgentRuns();
    case "agent_run.get":
      if (params.run_id !== undefined) return host.get(requiredString(params.run_id, "run_id"));
      return store.getAgentRun(requiredString(params.runId, "runId")) ?? null;
    case "agent_run.wait":
      return daemon.waitForRun(requiredString(params.runId, "runId"));
    case "agent_run.cancel":
      if (params.run_id !== undefined)
        return host.cancelRun(
          requiredString(params.run_id, "run_id"),
          optionalString(params.reason)
        );
      return daemon.cancelRun(requiredString(params.runId, "runId"), optionalString(params.reason));
    default:
      throw Object.assign(new Error(`unknown daemon method: ${request.method}`), {
        code: "method_not_found"
      });
  }
}

function parseRequest(line: string): DaemonRequest {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || typeof value.method !== "string")
    throw new TypeError("daemon request requires method");
  return value as unknown as DaemonRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`${name} must be a non-empty string`);
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
        throw new Error(`Octo Harness daemon is already running with pid ${owner}`, {
          cause: error
        });
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

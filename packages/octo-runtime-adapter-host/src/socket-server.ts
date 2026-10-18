import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { spawnAdapterHost } from "./process.js";
import { HostRunService } from "./host-run-service.js";
import type { AdapterHostRpc } from "./rpc.js";
import {
  createInputInvoke,
  contextItem,
  type InvokeInput,
  type InvokeEnvironment
} from "@mininglamp-oss/octo-runtime-protocol";
import {
  readBoundedLines,
  type AdapterProbeOptions
} from "@mininglamp-oss/octo-runtime-adapter-sdk";
import { INVOKE_REQUEST_MAX_BYTES } from "@mininglamp-oss/octo-runtime-protocol";

export interface HostSocketRequest {
  id?: unknown;
  method: string;
  params?: Record<string, unknown>;
}

export async function startHostSocketServer(options: {
  socketPath: string;
  manifestPath: string;
  hostEntrypoint: string;
  homePath: string;
  configurations?: (runtimeId?: string) => Record<string, AdapterProbeOptions>;
  extension?: (request: HostSocketRequest, host: HostRunService) => Promise<unknown>;
}) {
  if (process.platform !== "win32") {
    await mkdir(dirname(options.socketPath), { recursive: true });
    try {
      const stat = await lstat(options.socketPath);
      if (!stat.isSocket()) throw new Error("HOST_SOCKET_PATH_INVALID");
      await rm(options.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const processHost = await spawnAdapterHost({
    entrypoint: options.hostEntrypoint,
    manifest: options.manifestPath,
    env: { ...process.env, OCTO_RUNTIME_HOME: options.homePath }
  });
  const configure = (request: InvokeInput): InvokeInput => {
    const adapterType = contextItem(request.contexts, "octo.execution", "adapter")?.payload.type;
    const type = typeof adapterType === "string" ? adapterType : "codex";
    const config = options.configurations?.(
      typeof request.runMetadata?.runtimeId === "string" ? request.runMetadata.runtimeId : undefined
    )?.[type];
    return config
      ? {
          ...request,
          agentConfig: {
            ...request.agentConfig,
            providerOptions: { ...request.agentConfig?.providerOptions, ...config.providerOptions }
          }
        }
      : request;
  };
  const configuredStreamLimits = (request: InvokeInput) => {
    const adapterType = contextItem(request.contexts, "octo.execution", "adapter")?.payload.type;
    const type = typeof adapterType === "string" ? adapterType : "codex";
    return options.configurations?.(
      typeof request.runMetadata?.runtimeId === "string" ? request.runMetadata.runtimeId : undefined
    )?.[type]?.streamLimits;
  };
  const transport: AdapterHostRpc = {
    list: (configs) => processHost.client.list(configs ?? options.configurations?.()),
    probe: (type, config) =>
      processHost.client.probe(type, config ?? options.configurations?.()?.[type]),
    cancel: (id, reason) => processHost.client.cancel(id, reason),
    respondInteraction: (id, response) => processHost.client.respondInteraction(id, response),
    respondNative: (id, response) => processHost.client.respondNative(id, response),
    invoke: createInputInvoke((input, environment) => transport.invokeFrames(input, environment)),
    invokeFrames: (input, environment) =>
      processHost.client.invokeFrames(configure(input), environment)
  };
  const host = new HostRunService(transport, configuredStreamLimits);
  const connections = new Set<net.Socket>();
  let closing = false;
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => socket.destroy());
    const stopInput = readBoundedLines(socket, INVOKE_REQUEST_MAX_BYTES, {
      onError: () => socket.destroy(),
      onClose: () => {},
      onTooLarge: () =>
        socket.end(
          `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "INVOKE_REQUEST_TOO_LARGE" } })}\n`
        ),
      onLine: (line) => {
        stopInput();
        socket.setTimeout(0);
        void handle(line, socket);
      }
    });
  });
  const handle = async (line: string, socket: net.Socket): Promise<void> => {
    let request: HostSocketRequest | undefined;
    try {
      const value: unknown = JSON.parse(line);
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !("jsonrpc" in value) ||
        value.jsonrpc !== "2.0" ||
        !("method" in value) ||
        typeof value.method !== "string"
      )
        throw new Error("HOST_RPC_INVALID");
      request = value as HostSocketRequest;
      const params = request.params ?? {};
      if (request.method === "agent_run.invoke") {
        const receipt = await host.submit(params.input as InvokeInput, {
          executionEnvOverrides:
            params.executionEnvOverrides as InvokeEnvironment["executionEnvOverrides"]
        });
        await streamHostRun({ ...request, params: { run_id: receipt.run_id } }, socket, host);
        return;
      }
      if (request.method === "agent_run.subscribe") {
        await streamHostRun(request, socket, host);
        return;
      }
      let result: unknown;
      switch (request.method) {
        case "status":
          result = {
            ready:
              !closing &&
              processHost.child.exitCode === null &&
              processHost.child.signalCode === null,
            pid: process.pid,
            adapterHost: {
              pid: processHost.child.pid,
              state:
                processHost.child.exitCode === null && processHost.child.signalCode === null
                  ? "ready"
                  : "stopped"
            }
          };
          break;
        case "adapter.list":
          result = await host.list(
            options.configurations?.(
              typeof params.runtimeId === "string" ? params.runtimeId : undefined
            )
          );
          break;
        case "agent_run.cancel":
          result = await host.cancelRun(String(params.run_id));
          break;
        case "agent_run.respond":
          await host.respond(
            String(params.run_id),
            params.response as Parameters<HostRunService["respond"]>[1]
          );
          result = {};
          break;
        case "agent_run.native.respond":
          await host.respondNativeRun(
            String(params.run_id),
            params.response as Parameters<HostRunService["respondNativeRun"]>[1]
          );
          result = {};
          break;
        case "lifecycle.drain":
          result = await host.drain(typeof params.timeoutMs === "number" ? params.timeoutMs : 5000);
          break;
        default:
          if (!options.extension) throw new Error("HOST_METHOD_NOT_FOUND");
          result = await options.extension(request, host);
      }
      if (!socket.destroyed)
        socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    } catch (error) {
      if (!socket.destroyed)
        socket.end(
          `${JSON.stringify({ jsonrpc: "2.0", id: request?.id, error: { code: -32001, message: error instanceof Error ? error.message : "HOST_REQUEST_FAILED" } })}\n`
        );
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.socketPath, resolve);
    });
    if (process.platform !== "win32") await chmod(options.socketPath, 0o600);
  } catch (error) {
    await processHost.close();
    throw error;
  }
  return {
    host,
    hostProcess: processHost,
    async close() {
      if (closing) return;
      closing = true;
      await host.close();
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await processHost.close();
      if (process.platform !== "win32") await rm(options.socketPath, { force: true });
    }
  };
}

async function write(socket: net.Socket, value: unknown): Promise<void> {
  if (socket.destroyed) return;
  if (!socket.write(`${JSON.stringify(value)}\n`)) {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("drain", drained);
        socket.off("close", closed);
      };
      const drained = () => {
        cleanup();
        resolve();
      };
      const closed = () => {
        cleanup();
        reject(new Error("HOST_STREAM_CLOSED"));
      };
      const timer = setTimeout(closed, 5000);
      socket.once("drain", drained);
      socket.once("close", closed);
    });
  }
}

export async function streamHostRun(
  request: HostSocketRequest,
  socket: net.Socket,
  host: HostRunService
): Promise<void> {
  const params = request.params ?? {};
  if (Object.hasOwn(params, "options") || Object.hasOwn(params, "protocol_mode"))
    throw new Error("EXECUTION_PROTOCOL_MISMATCH");
  if (typeof params.run_id !== "string" || !params.run_id) throw new Error("RUN_ID_REQUIRED");
  let streamId = typeof params.stream_id === "string" ? params.stream_id : undefined;
  const cursor = params.after_seq ?? 0;
  if (typeof cursor !== "number") throw new Error("STREAM_CURSOR_INVALID");
  let after = cursor;
  const release = host.acquireSubscription();
  const subscription = `sub_${randomUUID()}`;
  let started = false;
  try {
    while (!socket.destroyed) {
      const page = host.read(params.run_id, streamId, after);
      streamId = page.stream_id;
      if (!started) {
        await write(socket, {
          jsonrpc: "2.0",
          id: request.id,
          result: { subscription_id: subscription, ...page, events: undefined }
        });
        started = true;
      }
      for (const value of page.events) {
        await write(socket, {
          jsonrpc: "2.0",
          method: "agent_run.event",
          params: {
            subscription_id: subscription,
            run_id: params.run_id,
            stream_id: streamId,
            seq: value.seq,
            event: value.event
          }
        });
        after = value.seq;
      }
      if ((page.terminal || params.follow === false) && after >= page.latest_seq) {
        socket.end();
        return;
      }
      if (!page.events.length)
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            socket.off("close", done);
            resolve();
          };
          const timer = setTimeout(done, 100);
          socket.once("close", done);
        });
    }
  } finally {
    release();
  }
}

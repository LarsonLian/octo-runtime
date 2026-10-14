import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import {
  assertHostFrameIdentity,
  assertHostRunReceipt,
  isHostTerminal,
  serializeHostInvokeOptions,
  resolveHostInvokeOptions,
  type HostFrame,
  type HostRunReceipt,
  type HostInvokeOptions,
  type InvokeRequest
} from "@mininglamp-oss/octo-harness-protocol";
import { callDaemon } from "./runtime-contract.js";

/** Local source notifications have no per-event ACK and allocate no durable consumer queue. */
export async function* subscribeDaemonRun(
  socketPath: string,
  input: {
    runId: string;
    streamId?: string;
    afterSeq?: number;
    signal?: AbortSignal;
    invocation?: { adapterType: string; request: InvokeRequest; options?: HostInvokeOptions };
  }
): AsyncIterable<Record<string, unknown>> {
  if (input.signal?.aborted) return;
  const socket = createConnection(socketPath);
  const abort = (): void => {
    socket.destroy();
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  socket.setEncoding("utf8");
  socket.setTimeout(5000, () => socket.destroy(new Error("HOST_STREAM_HANDSHAKE_TIMEOUT")));
  socket.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: input.invocation ? "agent_run.invoke" : "agent_run.subscribe",
      params: input.invocation
        ? {
            adapter_type: input.invocation.adapterType,
            request: input.invocation.request,
            options: serializeHostInvokeOptions(input.invocation.options)
          }
        : {
            run_id: input.runId,
            ...(input.streamId ? { stream_id: input.streamId } : {}),
            after_seq: input.afterSeq ?? 0
          }
    })}\n`
  );
  let pending = "",
    started = false;
  try {
    for await (const chunk of socket) {
      pending += String(chunk);
      let boundary = pending.indexOf("\n");
      while (boundary >= 0) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        if (line.length > 512 * 1024) throw new Error("HOST_STREAM_FRAME_TOO_LARGE");
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (frame.jsonrpc !== "2.0") throw new Error("HOST_STREAM_PROTOCOL_INVALID");
        if (frame.error) {
          const error = frame.error as { message?: string };
          throw new Error(error.message ?? "HOST_STREAM_FAILED");
        }
        if (!started) {
          started = true;
          socket.setTimeout(0);
        }
        yield frame;
        if (input.signal?.aborted) return;
        boundary = pending.indexOf("\n");
      }
      if (pending.length > 512 * 1024) throw new Error("HOST_STREAM_FRAME_TOO_LARGE");
    }
    if (!input.signal?.aborted && (!started || pending.trim()))
      throw new Error("HOST_STREAM_DISCONNECTED");
  } finally {
    input.signal?.removeEventListener("abort", abort);
    socket.destroy();
  }
}

/** A single local invoke RPC returns its canonical notifications; replay only repairs IPC loss. */
export async function* invokeDaemonRun(
  socketPath: string,
  adapterType: string,
  request: InvokeRequest,
  options: HostInvokeOptions = {}
): AsyncGenerator<HostFrame> {
  const resolved = resolveHostInvokeOptions(options);
  const { signal, ...wireRequest } = request;
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error("caller_aborted");
  let receipt: HostRunReceipt | undefined;
  let streamId: string | undefined,
    after = 0,
    terminal = false,
    attempts = 0;
  let cancellationSent = false;
  const cancel = (): void => {
    if (cancellationSent) return;
    cancellationSent = true;
    void callDaemon(socketPath, {
      method: "agent_run.cancel",
      params: { run_id: request.runId }
    }).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (!terminal && !signal?.aborted) {
      try {
        for await (const frame of subscribeDaemonRun(socketPath, {
          runId: request.runId,
          streamId,
          afterSeq: after,
          signal,
          ...(!streamId
            ? { invocation: { adapterType, request: wireRequest, options: resolved } }
            : {})
        })) {
          if (frame.result) {
            const metadata = receiptFrom(frame.result);
            if (
              metadata.run_id !== request.runId ||
              metadata.invocation_id !== request.invocationId ||
              metadata.agent_session_id !== request.agentSessionId ||
              metadata.session_generation !== (request.sessionGeneration ?? 0) ||
              metadata.protocol_mode !== resolved.protocolMode ||
              (resolved.protocol && metadata.protocol !== resolved.protocol) ||
              !metadata.stream_id ||
              (streamId && streamId !== metadata.stream_id)
            )
              throw new Error("STREAM_EXPIRED");
            streamId = metadata.stream_id;
            receipt = metadata;
            continue;
          }
          const params = frame.params as {
            run_id?: string;
            stream_id?: string;
            seq?: number;
            code?: string;
            event?: HostFrame;
          };
          if (params?.run_id !== request.runId || params.stream_id !== streamId)
            throw new Error("HOST_STREAM_IDENTITY_INVALID");
          if (frame.method === "agent_run.stream_error")
            throw new Error(params.code ?? "STREAM_GAP");
          if (
            frame.method !== "agent_run.event" ||
            !params.event ||
            !Number.isSafeInteger(params.seq)
          )
            throw new Error("HOST_STREAM_PROTOCOL_INVALID");
          if (params.seq! <= after) continue;
          if (params.seq !== after + 1) throw new Error("STREAM_GAP");
          if (!receipt) throw new Error("HOST_STREAM_IDENTITY_INVALID");
          assertHostFrameIdentity(params.event, receipt);
          if (params.event.seq !== params.seq) throw new Error("STREAM_GAP");
          after = params.seq;
          terminal = isHostTerminal(params.event);
          yield params.event;
          if (terminal) return;
        }
        if (!terminal && !signal?.aborted) throw new Error("HOST_STREAM_DISCONNECTED");
      } catch (error) {
        if (signal?.aborted) return;
        const code = error instanceof Error ? error.message : String(error);
        if (
          ![
            "HOST_STREAM_DISCONNECTED",
            "read ECONNRESET",
            "HOST_STREAM_HANDSHAKE_TIMEOUT"
          ].includes(code) ||
          ++attempts > 3
        )
          throw error;
        if (!streamId) {
          const info = receiptFrom(
            await callDaemon(socketPath, {
              method: "agent_run.get",
              params: { run_id: request.runId }
            })
          );
          if (
            info.invocation_id !== request.invocationId ||
            info.protocol_mode !== resolved.protocolMode ||
            info.agent_session_id !== request.agentSessionId ||
            info.session_generation !== (request.sessionGeneration ?? 0) ||
            (resolved.protocol && info.protocol !== resolved.protocol)
          )
            throw new Error("EXECUTION_IDENTITY_CONFLICT", { cause: error });
          receipt = info;
          streamId = info.stream_id;
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!terminal) cancel();
  }
}

function receiptFrom(value: unknown): HostRunReceipt {
  if (!value || typeof value !== "object") throw new Error("HOST_RECEIPT_INVALID");
  const receipt = Object.fromEntries(
    [
      "run_id",
      "invocation_id",
      "stream_id",
      "agent_session_id",
      "session_generation",
      "protocol_mode",
      "protocol"
    ].map((key) => [key, Reflect.get(value, key)])
  );
  assertHostRunReceipt(receipt);
  return receipt;
}

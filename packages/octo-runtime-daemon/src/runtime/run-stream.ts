import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import {
  assertHostFrameIdentity,
  assertHostRunReceipt,
  isHostTerminal,
  identifyInvokeInput,
  assertJsonByteLimit,
  INVOKE_REQUEST_MAX_BYTES,
  HOST_RPC_MAX_LINE_BYTES,
  streamCapacityError,
  type HostFrame,
  type HostRunReceipt,
  type InvokeInput,
  type InvokeEnvironment
} from "@mininglamp-oss/octo-runtime-protocol";
import { callDaemon } from "./runtime-contract.js";

/** Local source notifications have no per-event ACK and allocate no durable consumer queue. */
export async function* subscribeDaemonRun(
  socketPath: string,
  input: {
    runId: string;
    streamId?: string;
    afterSeq?: number;
    signal?: AbortSignal;
    invocation?: {
      input: InvokeInput;
      executionEnvOverrides?: InvokeEnvironment["executionEnvOverrides"];
    };
  }
): AsyncIterable<Record<string, unknown>> {
  if (input.signal?.aborted) return;
  const wireRequest = {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: input.invocation ? "agent_run.invoke" : "agent_run.subscribe",
    params: input.invocation
      ? { ...input.invocation }
      : {
          run_id: input.runId,
          ...(input.streamId ? { stream_id: input.streamId } : {}),
          after_seq: input.afterSeq ?? 0
        }
  };
  assertJsonByteLimit(wireRequest, INVOKE_REQUEST_MAX_BYTES, "INVOKE_REQUEST_TOO_LARGE");
  const socket = createConnection(socketPath);
  const abort = (): void => {
    socket.destroy();
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  socket.setEncoding("utf8");
  socket.setTimeout(5000, () => socket.destroy(new Error("HOST_STREAM_HANDSHAKE_TIMEOUT")));
  socket.write(`${JSON.stringify(wireRequest)}\n`);
  let pending: string[] = [];
  let pendingBytes = 0,
    started = false;
  const assertLineBytes = (measuredBytes: number): void => {
    if (measuredBytes > HOST_RPC_MAX_LINE_BYTES)
      throw streamCapacityError("HOST_FRAME_TOO_LARGE", {
        boundary: "daemon.stream_transport",
        measuredBytes,
        limitBytes: HOST_RPC_MAX_LINE_BYTES
      });
  };
  try {
    for await (const chunk of socket) {
      const text = String(chunk);
      let start = 0;
      let boundary = text.indexOf("\n");
      while (boundary >= 0) {
        const segment = text.slice(start, boundary);
        pending.push(segment);
        pendingBytes += Buffer.byteLength(segment, "utf8");
        assertLineBytes(pendingBytes);
        const line = pending.join("");
        pending = [];
        pendingBytes = 0;
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
        start = boundary + 1;
        boundary = text.indexOf("\n", start);
      }
      const remainder = text.slice(start);
      if (remainder) pending.push(remainder);
      pendingBytes += Buffer.byteLength(remainder, "utf8");
      assertLineBytes(pendingBytes);
    }
    if (!input.signal?.aborted && (!started || pending.some((segment) => segment.trim())))
      throw new Error("HOST_STREAM_DISCONNECTED");
  } finally {
    input.signal?.removeEventListener("abort", abort);
    socket.destroy();
  }
}

/** A single local invoke RPC returns its canonical notifications; replay only repairs IPC loss. */
export async function* invokeDaemonRun(
  socketPath: string,
  input: InvokeInput,
  environment: InvokeEnvironment = {}
): AsyncGenerator<HostFrame> {
  const request = identifyInvokeInput(input);
  const { signal, executionEnvOverrides } = environment;
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error("caller_aborted");
  let receipt: HostRunReceipt | undefined;
  let streamId: string | undefined,
    after = 0,
    terminal = false,
    attempts = 0;
  let cancellation: Promise<void> | undefined;
  const cancel = (): void => {
    if (cancellation) return;
    // ACK 在途时先核对真实身份，不能取消恰好使用同一 runId 的另一调用。
    // 未接纳的请求由服务端接纳期 signal 取消，不重复 invoke 或无限重试。
    cancellation = (async () => {
      const accepted =
        receipt ??
        receiptFrom(
          await callDaemon(socketPath, {
            method: "agent_run.get",
            params: { run_id: request.runId }
          })
        );
      if (
        accepted.run_id !== request.runId ||
        accepted.invocation_id !== request.invocationId ||
        accepted.agent_session_id !== request.sessionId ||
        accepted.session_generation !== (request.sessionGeneration ?? 0) ||
        accepted.protocol_mode !== (request.protocol_mode ?? "native")
      )
        return;
      await callDaemon(socketPath, {
        method: "agent_run.cancel",
        params: { run_id: request.runId }
      });
    })().catch(() => undefined);
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
            ? {
                invocation: {
                  input: request,
                  ...(executionEnvOverrides ? { executionEnvOverrides } : {})
                }
              }
            : {})
        })) {
          if (frame.result) {
            const metadata = receiptFrom(frame.result);
            if (
              metadata.run_id !== request.runId ||
              metadata.invocation_id !== request.invocationId ||
              metadata.agent_session_id !== request.sessionId ||
              metadata.session_generation !== (request.sessionGeneration ?? 0) ||
              metadata.protocol_mode !== (request.protocol_mode ?? "native") ||
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
            info.protocol_mode !== (request.protocol_mode ?? "native") ||
            info.agent_session_id !== request.sessionId ||
            info.session_generation !== (request.sessionGeneration ?? 0)
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
    await cancellation;
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

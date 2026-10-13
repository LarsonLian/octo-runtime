import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import type { CanonicalEvent, InvokeRequest } from "@mininglamp-oss/octo-harness-protocol";
import { callDaemon } from "./runtime-contract.js";

/** Local source notifications have no per-event ACK and allocate no durable consumer queue. */
export async function* subscribeDaemonRun(socketPath: string, input: {
  runId: string; streamId?: string; afterSeq?: number; signal?: AbortSignal;
  invocation?: { adapterType: string; request: InvokeRequest };
}): AsyncIterable<Record<string, unknown>> {
  if (input.signal?.aborted) return;
  const socket=createConnection(socketPath);
  const abort=():void=>{socket.destroy();};input.signal?.addEventListener("abort",abort,{once:true});
  socket.setEncoding("utf8");
  socket.setTimeout(5000,()=>socket.destroy(new Error("HOST_STREAM_HANDSHAKE_TIMEOUT")));
  socket.write(`${JSON.stringify({jsonrpc:"2.0",id:randomUUID(),method:input.invocation ? "agent_run.invoke" : "agent_run.subscribe",params:input.invocation
    ? { adapter_type: input.invocation.adapterType, request: input.invocation.request }
    : {run_id:input.runId, ...(input.streamId?{stream_id:input.streamId}:{}),after_seq:input.afterSeq??0}})}\n`);
  let pending="",started=false;
  try {
    for await(const chunk of socket){
      pending+=String(chunk);
      let boundary=pending.indexOf("\n");
      while(boundary>=0){
        const line=pending.slice(0,boundary);pending=pending.slice(boundary+1);
        if(line.length>512*1024)throw new Error("HOST_STREAM_FRAME_TOO_LARGE");
        const frame=JSON.parse(line) as Record<string,unknown>;
        if(frame.jsonrpc!=="2.0")throw new Error("HOST_STREAM_PROTOCOL_INVALID");
        if(frame.error){const error=frame.error as {message?:string};throw new Error(error.message??"HOST_STREAM_FAILED")}
        if(!started){started=true;socket.setTimeout(0)}
        yield frame;
        if(input.signal?.aborted)return;
        boundary=pending.indexOf("\n");
      }
      if(pending.length>512*1024)throw new Error("HOST_STREAM_FRAME_TOO_LARGE");
    }
    if(!input.signal?.aborted && (!started || pending.trim()))throw new Error("STREAM_GAP");
  } finally {input.signal?.removeEventListener("abort",abort);socket.destroy()}
}

/** A single local invoke RPC returns its canonical notifications; replay only repairs IPC loss. */
export async function* invokeDaemonRun(socketPath: string, adapterType: string, request: InvokeRequest): AsyncIterable<CanonicalEvent> {
  const { signal, ...wireRequest } = request;
  let streamId: string | undefined, after = 0, terminal = false, attempts = 0;
  const cancel = (): void => { void callDaemon(socketPath, { method: "agent_run.cancel", params: { run_id: request.runId } }).catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (!terminal && !signal?.aborted) {
      try {
        for await (const frame of subscribeDaemonRun(socketPath, { runId: request.runId, streamId, afterSeq: after, signal,
          ...(!streamId ? { invocation: { adapterType, request: wireRequest } } : {}) })) {
          if (frame.result) {
            const metadata = frame.result as { run_id?: string; stream_id?: string };
            if (metadata.run_id !== request.runId || !metadata.stream_id || (streamId && streamId !== metadata.stream_id)) throw new Error("STREAM_EXPIRED");
            streamId = metadata.stream_id;
            continue;
          }
          const params = frame.params as { run_id?: string; stream_id?: string; seq?: number; code?: string; event?: CanonicalEvent };
          if (params?.run_id !== request.runId || params.stream_id !== streamId) throw new Error("HOST_STREAM_IDENTITY_INVALID");
          if (frame.method === "agent_run.stream_error") throw new Error(params.code ?? "STREAM_GAP");
          if (frame.method !== "agent_run.event" || !params.event || !Number.isSafeInteger(params.seq)) throw new Error("HOST_STREAM_PROTOCOL_INVALID");
          if (params.seq! <= after) continue;
          if (params.seq !== after + 1) throw new Error("STREAM_GAP");
          after = params.seq;
          terminal = ["run.completed", "run.failed", "run.cancelled"].includes(params.event.type);
          yield params.event;
        }
        if (!terminal && !signal?.aborted) throw new Error("HOST_STREAM_DISCONNECTED");
      } catch (error) {
        if (signal?.aborted) return;
        const code = error instanceof Error ? error.message : String(error);
        if (!streamId || !["HOST_STREAM_DISCONNECTED", "read ECONNRESET"].includes(code) || ++attempts > 3) throw error;
      }
    }
  } finally { signal?.removeEventListener("abort", cancel); }
}

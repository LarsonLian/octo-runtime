import type { AdapterHostRpc } from "./rpc.js";
import {
  assertInvokeRequest,
  createHostInvoke,
  assertHostFrameIdentity,
  isHostTerminal,
  type HostFrame,
  type HostRunReceipt,
  type HostInvokeOptions,
  type NativeInteractionResponse,
  type InvokeRequest,
  type InteractionResponse
} from "@mininglamp-oss/octo-runtime-protocol";

export interface SourceEvent {
  seq: number;
  event: HostFrame;
  bytes: number;
  at: number;
}
interface Run {
  receipt: HostRunReceipt;
  streamId: string;
  invocationId: string;
  next: number;
  bytes: number;
  updated: number;
  events: SourceEvent[];
  terminal?: HostFrame;
  source: AsyncGenerator<HostFrame>;
  first: HostFrame;
}
const TTL = 120_000,
  MAX_RUN_BYTES = 4 << 20,
  MAX_BYTES = 64 << 20,
  MAX_EVENTS = 4096;

/** One process-local event authority around the existing adapter-host IPC client. */
export class HostRunService implements AdapterHostRpc {
  readonly invoke = createHostInvoke((type, request, options) =>
    this.invokeFrames(type, request, options)
  );
  #runs = new Map<string, Run>();
  #bytes = 0;
  #subscribers = 0;
  #draining = false;
  #tasks = new Set<Promise<void>>();
  #starting = new Set<string>();
  readonly #cleanup: NodeJS.Timeout;
  constructor(readonly transport: AdapterHostRpc) {
    this.#cleanup = setInterval(() => this.#prune(), 10_000);
    this.#cleanup.unref();
  }
  get status(): { draining: boolean; activeRuns: number; admittingRuns: number } {
    return {
      draining: this.#draining,
      activeRuns: [...this.#runs.values()].filter((run) => !run.terminal).length,
      admittingRuns: this.#starting.size
    };
  }
  list(...args: Parameters<AdapterHostRpc["list"]>): ReturnType<AdapterHostRpc["list"]> {
    return this.transport.list(...args);
  }
  probe(...args: Parameters<AdapterHostRpc["probe"]>): Promise<unknown> {
    return this.transport.probe(...args);
  }
  cancel(invocationId: string, reason?: string): ReturnType<AdapterHostRpc["cancel"]> {
    return this.transport.cancel(invocationId, reason);
  }
  respondInteraction(invocationId: string, response: InteractionResponse): Promise<void> {
    return this.transport.respondInteraction(invocationId, response);
  }
  respondNative(invocationId: string, response: NativeInteractionResponse): Promise<void> {
    return this.transport.respondNative(invocationId, response);
  }
  async #begin(
    adapterType: string,
    request: InvokeRequest,
    options: HostInvokeOptions
  ): Promise<Run> {
    assertInvokeRequest(request);
    this.#prune();
    if (this.#draining) throw new Error("DAEMON_DRAINING");
    if (this.#runs.has(request.runId) || this.#starting.has(request.runId))
      throw new Error("RUN_ALREADY_ACCEPTED");
    if (this.#runs.size + this.#starting.size >= 128) throw new Error("RUN_CAPACITY_EXHAUSTED");
    const source = this.transport.invokeFrames(adapterType, request, options);
    this.#starting.add(request.runId);
    let first: HostFrame;
    try {
      const frame = await source.next();
      if (frame.done) throw new Error("HOST_ENDED_WITHOUT_RECEIPT");
      first = frame.value;
    } catch (error) {
      await source.return(undefined).catch(() => undefined);
      throw error;
    } finally {
      this.#starting.delete(request.runId);
    }
    if (this.#draining) {
      await source.return(undefined);
      throw new Error("HOST_DRAINING");
    }
    const {
      run_id,
      invocation_id,
      stream_id,
      agent_session_id,
      session_generation,
      protocol_mode,
      protocol
    } = first;
    const receipt: HostRunReceipt = {
      run_id,
      invocation_id,
      stream_id,
      agent_session_id,
      session_generation,
      protocol_mode,
      protocol
    };
    const run: Run = {
      receipt,
      source,
      first,
      streamId: receipt.stream_id,
      invocationId: request.invocationId,
      next: 1,
      bytes: 0,
      updated: Date.now(),
      events: []
    };
    this.#runs.set(request.runId, run);
    return run;
  }
  async *invokeFrames(
    adapterType: string,
    request: InvokeRequest,
    options: HostInvokeOptions = {}
  ): AsyncGenerator<HostFrame> {
    const run = await this.#begin(adapterType, request, options);
    yield* this.#execute(adapterType, request, run, options);
  }
  async *#execute(
    adapterType: string,
    request: InvokeRequest,
    run: Run,
    options: HostInvokeOptions
  ): AsyncGenerator<HostFrame> {
    try {
      this.#append(run, run.first);
      yield run.first;
      for await (const event of run.source) {
        this.#append(run, event);
        yield event;
      }
      if (!run.terminal) throw new Error("HOST_ENDED_WITHOUT_TERMINAL");
    } catch (error) {
      if (!run.terminal) {
        this.#append(run, {
          ...run.receipt,
          seq: run.next,
          kind: "control",
          control: {
            type: "error",
            code: "HOST_EXECUTION_FAILED",
            message: "Host execution failed"
          }
        });
        this.#append(run, {
          ...run.receipt,
          seq: run.next,
          kind: "control",
          control: { type: "state", state: "lost" }
        });
      }
      throw error;
    } finally {
      await run.source.return(undefined).catch(() => undefined);
      // A consumer abandoning the generator cannot leave a live provider behind.
      if (!run.terminal) {
        await this.transport
          .cancel(request.invocationId, "Host stream consumer closed")
          .catch(() => undefined);
        this.#append(run, {
          ...run.receipt,
          seq: run.next,
          kind: "control",
          control: { type: "state", state: "cancelled" }
        });
      }
    }
  }
  async submit(
    adapterType: string,
    request: InvokeRequest,
    options: HostInvokeOptions = {}
  ): Promise<HostRunReceipt> {
    const run = await this.#begin(adapterType, request, options);
    const task = (async (): Promise<void> => {
      for await (const event of this.#execute(adapterType, request, run, options)) void event;
    })().catch(() => undefined);
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task));
    return { ...run.receipt };
  }
  #append(run: Run, event: HostFrame): void {
    if (run.terminal) throw new Error("HOST_FRAME_AFTER_TERMINAL");
    assertHostFrameIdentity(event, run.receipt);
    if (event.seq !== run.next) throw new Error("STREAM_GAP");
    // Consumers own persistence and presentation filtering; replay retains the complete event.
    const safe = structuredClone(event),
      bytes = Buffer.byteLength(JSON.stringify(safe));
    if (bytes > 256 << 10) throw new Error("STREAM_EVENT_TOO_LARGE");
    const now = Date.now();
    run.updated = now;
    run.events.push({ seq: run.next++, event: safe, bytes, at: now });
    run.bytes += bytes;
    this.#bytes += bytes;
    if (isHostTerminal(safe)) run.terminal = safe;
    while (run.bytes > MAX_RUN_BYTES || run.events.length > MAX_EVENTS) this.#drop(run);
    while (this.#bytes > MAX_BYTES) {
      const oldest = [...this.#runs.values()]
        .filter((value) => value.events.length)
        .sort((a, b) => a.events[0].at - b.events[0].at)[0];
      if (!oldest) break;
      this.#drop(oldest);
    }
    this.#prune();
  }
  #drop(run: Run): void {
    const event = run.events.shift();
    if (event) {
      run.bytes -= event.bytes;
      this.#bytes -= event.bytes;
    }
  }
  #prune(): void {
    const now = Date.now();
    for (const [id, run] of this.#runs) {
      while (run.events[0] && now - run.events[0].at >= TTL) this.#drop(run);
      if (run.terminal && now - run.updated >= TTL) {
        this.#bytes -= run.bytes;
        this.#runs.delete(id);
      }
    }
  }
  #get(runId: string): Run {
    this.#prune();
    const run = this.#runs.get(runId);
    if (!run) throw new Error("RUN_NOT_AVAILABLE");
    return run;
  }
  get(runId: string): HostRunReceipt & {
    oldest_seq: number;
    latest_seq: number;
    terminal?: HostFrame;
  } {
    const run = this.#get(runId);
    return {
      ...run.receipt,
      oldest_seq: run.events[0]?.seq ?? run.next,
      latest_seq: run.next - 1,
      ...(run.terminal ? { terminal: structuredClone(run.terminal) } : {})
    };
  }
  read(
    runId: string,
    streamId: string | undefined,
    after: number
  ): ReturnType<HostRunService["get"]> & { events: SourceEvent[] } {
    const info = this.get(runId),
      run = this.#get(runId);
    if (streamId && streamId !== info.stream_id) throw new Error("STREAM_EXPIRED");
    if (!Number.isSafeInteger(after) || after < 0 || after > info.latest_seq)
      throw new Error("STREAM_CURSOR_INVALID");
    if (after + 1 < info.oldest_seq && after < info.latest_seq)
      throw Object.assign(new Error("STREAM_GAP"), {
        data: {
          requested_after_seq: after,
          oldest_seq: info.oldest_seq,
          latest_seq: info.latest_seq
        }
      });
    return {
      ...info,
      events: run.events
        .filter((event) => event.seq > after)
        .slice(0, 32)
        .map((event) => structuredClone(event))
    };
  }
  cancelRun(runId: string, reason?: string): ReturnType<AdapterHostRpc["cancel"]> {
    return this.cancel(this.#get(runId).invocationId, reason);
  }
  respond(runId: string, response: InteractionResponse): Promise<void> {
    const run = this.#get(runId);
    if (run.terminal) throw new Error("INTERACTION_EXPIRED");
    return this.respondInteraction(run.invocationId, response);
  }
  respondNativeRun(runId: string, response: NativeInteractionResponse): Promise<void> {
    const run = this.#get(runId);
    if (run.terminal || run.receipt.protocol_mode !== "native")
      throw new Error("INTERACTION_NOT_ACTIVE");
    return this.respondNative(run.invocationId, response);
  }
  acquireSubscription(): () => void {
    if (this.#subscribers >= 16) throw new Error("STREAM_SUBSCRIBER_LIMIT");
    this.#subscribers++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.#subscribers--;
      }
    };
  }
  beginDrain(): void {
    this.#draining = true;
  }
  async drain(timeoutMs: number): Promise<{ drained: boolean }> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
      throw new Error("DRAIN_TIMEOUT_INVALID");
    this.beginDrain();
    const deadline = Date.now() + timeoutMs;
    while (this.#starting.size || this.status.activeRuns || this.#tasks.size) {
      if (Date.now() >= deadline) throw new Error("HOST_DRAIN_TIMEOUT");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return { drained: true };
  }
  async close(): Promise<void> {
    clearInterval(this.#cleanup);
    this.beginDrain();
    await Promise.allSettled(
      [...this.#runs.values()]
        .filter((run) => !run.terminal)
        .map((run) => this.cancel(run.invocationId, "Host shutdown"))
    );
    await Promise.allSettled([...this.#tasks]);
    this.#runs.clear();
    this.#bytes = 0;
  }
}

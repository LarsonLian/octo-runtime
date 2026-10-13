import { randomUUID } from "node:crypto";
import type { AdapterHostRpc } from "@mininglamp-oss/octo-harness-adapter-host";
import { assertInvokeRequest, type CanonicalEvent, type InvokeRequest, type InteractionResponse } from "@mininglamp-oss/octo-harness-protocol";

export interface SourceEvent { seq: number; event: CanonicalEvent; bytes: number; at: number }
interface Run {
  streamId: string; invocationId: string; next: number; bytes: number; updated: number;
  events: SourceEvent[]; terminal?: CanonicalEvent;
}
const terminal = (event: CanonicalEvent): boolean => ["run.completed", "run.failed", "run.cancelled"].includes(event.type);
const TTL = 120_000, MAX_RUN_BYTES = 4 << 20, MAX_BYTES = 64 << 20, MAX_EVENTS = 4096;

/** One process-local event authority around the existing adapter-host IPC client. */
export class HostRunService implements AdapterHostRpc {
  #runs = new Map<string, Run>();
  #bytes = 0;
  #subscribers = 0;
  #draining = false;
  #tasks = new Set<Promise<void>>();
  constructor(readonly transport: AdapterHostRpc) {}
  list(): ReturnType<AdapterHostRpc["list"]> { return this.transport.list(); }
  probe(adapterType: string): Promise<unknown> { return this.transport.probe(adapterType); }
  cancel(invocationId: string, reason?: string): ReturnType<AdapterHostRpc["cancel"]> { return this.transport.cancel(invocationId, reason); }
  respondInteraction(invocationId: string, response: InteractionResponse): Promise<void> { return this.transport.respondInteraction(invocationId, response); }
  #begin(request: InvokeRequest): Run {
    this.#prune();
    if (this.#draining) throw new Error("DAEMON_DRAINING");
    if (this.#runs.has(request.runId)) throw new Error("RUN_ALREADY_ACCEPTED");
    if (this.#runs.size >= 128) throw new Error("RUN_CAPACITY_EXHAUSTED");
    const run: Run = { streamId: `host:${randomUUID()}`, invocationId: request.invocationId, next: 1, bytes: 0, updated: Date.now(), events: [] };
    this.#runs.set(request.runId, run); return run;
  }
  async *invoke(adapterType: string, request: InvokeRequest): AsyncGenerator<CanonicalEvent> {
    assertInvokeRequest(request);
    const run = this.#begin(request);
    yield* this.#execute(adapterType, request, run);
  }
  async *#execute(adapterType: string, request: InvokeRequest, run: Run): AsyncGenerator<CanonicalEvent> {
    try {
      for await (const event of this.transport.invoke(adapterType, request)) {
        this.#append(run, event);
        yield event;
      }
      if (!run.terminal) throw new Error("HOST_ENDED_WITHOUT_TERMINAL");
    } catch (error) {
      if (!run.terminal) this.#append(run, { protocolVersion: 2, type: "run.failed", payload: { code: "HOST_EXECUTION_FAILED", message: "Host execution failed" } });
      throw error;
    } finally {
      // A consumer abandoning the generator cannot leave a live provider behind.
      if (!run.terminal) {
        await this.transport.cancel(request.invocationId, "Host stream consumer closed").catch(() => undefined);
        this.#append(run, { protocolVersion: 2, type: "run.cancelled", payload: { reasonCode: "consumer_closed" } });
      }
    }
  }
  submit(adapterType: string, request: InvokeRequest): { run_id: string; stream_id: string } {
    assertInvokeRequest(request);
    const run = this.#begin(request);
    const task = (async (): Promise<void> => { for await (const event of this.#execute(adapterType, request, run)) void event; })().catch(() => undefined);
    this.#tasks.add(task); void task.finally(() => this.#tasks.delete(task));
    return { run_id: request.runId, stream_id: run.streamId };
  }
  #append(run: Run, event: CanonicalEvent): void {
    if (run.terminal) return;
    // Consumers own persistence and presentation filtering; replay retains the complete event.
    const safe = structuredClone(event), bytes = Buffer.byteLength(JSON.stringify(safe));
    if (bytes > 256 << 10) throw new Error("STREAM_EVENT_TOO_LARGE");
    const now = Date.now(); run.updated = now;
    run.events.push({ seq: run.next++, event: safe, bytes, at: now }); run.bytes += bytes; this.#bytes += bytes;
    if (terminal(safe)) run.terminal = safe;
    while (run.bytes > MAX_RUN_BYTES || run.events.length > MAX_EVENTS) this.#drop(run);
    while (this.#bytes > MAX_BYTES) {
      const oldest = [...this.#runs.values()].filter(value => value.events.length).sort((a, b) => a.events[0].at - b.events[0].at)[0];
      if (!oldest) break; this.#drop(oldest);
    }
    this.#prune();
  }
  #drop(run: Run): void { const event = run.events.shift(); if (event) { run.bytes -= event.bytes; this.#bytes -= event.bytes; } }
  #prune(): void {
    const now = Date.now();
    for (const [id, run] of this.#runs) {
      while (run.events[0] && now - run.events[0].at >= TTL) this.#drop(run);
      if (run.terminal && now - run.updated >= TTL) { this.#bytes -= run.bytes; this.#runs.delete(id); }
    }
  }
  #get(runId: string): Run { this.#prune(); const run = this.#runs.get(runId); if (!run) throw new Error("RUN_NOT_AVAILABLE"); return run; }
  get(runId: string): { run_id: string; stream_id: string; oldest_seq: number; latest_seq: number; terminal?: CanonicalEvent } {
    const run = this.#get(runId);
    return { run_id: runId, stream_id: run.streamId, oldest_seq: run.events[0]?.seq ?? run.next, latest_seq: run.next - 1, ...(run.terminal ? { terminal: structuredClone(run.terminal) } : {}) };
  }
  read(runId: string, streamId: string | undefined, after: number): ReturnType<HostRunService["get"]> & { events: SourceEvent[] } {
    const info = this.get(runId), run = this.#get(runId);
    if (streamId && streamId !== info.stream_id) throw new Error("STREAM_EXPIRED");
    if (!Number.isSafeInteger(after) || after < 0 || after > info.latest_seq) throw new Error("STREAM_CURSOR_INVALID");
    if (after + 1 < info.oldest_seq && after < info.latest_seq) throw Object.assign(new Error("STREAM_GAP"), { data: { requested_after_seq: after, oldest_seq: info.oldest_seq, latest_seq: info.latest_seq } });
    return { ...info, events: run.events.filter(event => event.seq > after).slice(0, 32).map(event => structuredClone(event)) };
  }
  cancelRun(runId: string, reason?: string): ReturnType<AdapterHostRpc["cancel"]> { return this.cancel(this.#get(runId).invocationId, reason); }
  respond(runId: string, response: InteractionResponse): Promise<void> {
    const run = this.#get(runId);
    if (run.terminal) throw new Error("INTERACTION_EXPIRED");
    return this.respondInteraction(run.invocationId, response);
  }
  acquireSubscription(): () => void {
    if (this.#subscribers >= 16) throw new Error("STREAM_SUBSCRIBER_LIMIT"); this.#subscribers++;
    let released = false; return () => { if (!released) { released = true; this.#subscribers--; } };
  }
  beginDrain(): void { this.#draining = true; }
  async close(): Promise<void> {
    this.beginDrain();
    await Promise.allSettled([...this.#runs.values()].filter(run => !run.terminal).map(run => this.cancel(run.invocationId, "Daemon shutdown")));
    await Promise.allSettled([...this.#tasks]); this.#runs.clear(); this.#bytes = 0;
  }
}

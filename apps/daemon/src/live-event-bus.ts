import {
  redactCredentials,
  redactPrivateReasoning,
  type RecordEnvelope
} from "@mininglamp-oss/octo-harness-observability";

export const LIVE_EVENT_MEMORY_BYTES = 6 * 1024 * 1024;
export const LIVE_EVENT_MAX_FRAME_BYTES = 256 * 1024;
export const LIVE_EVENT_MAX_SLOTS = 8192;
export const LIVE_EVENT_MAX_SUBSCRIBERS = 16;
export const LIVE_EVENT_CONTROL_RESERVE_BYTES = 64 * 1024;

export const LIVE_EVENT_SOURCES = [
  "daemon",
  "provider-native",
  "adapter-canonical",
  "host-canonical",
  "adapter-rpc",
  "runtime",
  "worker",
  "control"
] as const;
export type LiveEventSource = typeof LIVE_EVENT_SOURCES[number];

export interface LiveEventEnvelope {
  schema: "octo-harness.live-event/v1";
  local_seq: number;
  occurred_at: string;
  source: LiveEventSource;
  stage: string;
  direction?: string;
  type: string;
  agent_run_id?: string;
  invocation_id?: string;
  adapter_type?: string;
  payload: unknown;
}

export interface LiveEventFilter {
  runId?: string;
  source?: LiveEventSource;
}

export interface LiveEventInput {
  source: LiveEventSource;
  stage?: string;
  direction?: string;
  type: string;
  runId?: string;
  invocationId?: string;
  adapterType?: string;
  occurredAt?: string;
  payload: unknown;
}

interface RingEntry {
  readonly seq: number;
  readonly runId?: string;
  readonly source: LiveEventSource;
  readonly type: string;
  readonly affectedSource?: LiveEventSource;
  readonly bytes: Buffer;
  pins: number;
  retired: boolean;
}

export interface LiveEventBusStats {
  retainedBytes: number;
  controlBytes: number;
  retainedEvents: number;
  retiredEvents: number;
  subscribers: number;
  droppedEvents: number;
  nextSeq: number;
}

/** A byte-bounded, fixed-slot process-local event stream. Subscribers retain at
 * most one frame reference and therefore cannot multiply payload memory. */
export class LiveEventBus {
  readonly #slots: Array<RingEntry | undefined>;
  readonly #maxBytes: number;
  readonly #maxFrameBytes: number;
  readonly #maxSubscribers: number;
  readonly #controlReserveBytes: number;
  readonly #retired = new Set<RingEntry>();
  readonly #waiters = new Set<() => void>();
  #head = 0;
  #count = 0;
  #bytes = 0;
  #controlBytes = 0;
  #nextSeq = 1;
  #subscribers = 0;
  #dropped = 0;

  constructor(options: {
    maxBytes?: number;
    maxFrameBytes?: number;
    maxSlots?: number;
    maxSubscribers?: number;
    controlReserveBytes?: number;
  } = {}) {
    this.#maxBytes = positive(options.maxBytes, LIVE_EVENT_MEMORY_BYTES, "maxBytes");
    this.#maxFrameBytes = positive(options.maxFrameBytes, LIVE_EVENT_MAX_FRAME_BYTES, "maxFrameBytes");
    this.#maxSubscribers = positive(options.maxSubscribers, LIVE_EVENT_MAX_SUBSCRIBERS, "maxSubscribers");
    this.#controlReserveBytes = Math.min(
      positive(options.controlReserveBytes, LIVE_EVENT_CONTROL_RESERVE_BYTES, "controlReserveBytes"),
      Math.floor(this.#maxBytes / 2)
    );
    this.#slots = Array.from<RingEntry | undefined>({
      length: positive(options.maxSlots, LIVE_EVENT_MAX_SLOTS, "maxSlots")
    });
  }

  get stats(): LiveEventBusStats {
    return {
      retainedBytes: this.#bytes,
      controlBytes: this.#controlBytes,
      retainedEvents: this.#count,
      retiredEvents: this.#retired.size,
      subscribers: this.#subscribers,
      droppedEvents: this.#dropped,
      nextSeq: this.#nextSeq
    };
  }

  publish(input: LiveEventInput): boolean {
    const seq = this.#nextSeq++;
    const payloadWithinLimit = estimatedJsonBytes(input.payload, this.#maxFrameBytes) <= this.#maxFrameBytes;
    let envelope: LiveEventEnvelope = {
      schema: "octo-harness.live-event/v1",
      local_seq: seq,
      occurred_at: input.occurredAt ?? new Date().toISOString(),
      source: input.source,
      stage: input.stage ?? defaultStage(input.source),
      ...(input.direction ? { direction: input.direction } : {}),
      type: input.type,
      ...(input.runId ? { agent_run_id: input.runId } : {}),
      ...(input.invocationId ? { invocation_id: input.invocationId } : {}),
      ...(input.adapterType ? { adapter_type: input.adapterType } : {}),
      payload: payloadWithinLimit
        ? redactPrivateReasoning(redactCredentials(input.payload))
        : null
    };
    let bytes = payloadWithinLimit ? encodeBounded(envelope, this.#maxFrameBytes) : undefined;
    if (!bytes) {
      envelope = {
        schema: "octo-harness.live-event/v1",
        local_seq: seq,
        occurred_at: envelope.occurred_at,
        source: "control",
        stage: "bus",
        type: "event.oversize_dropped",
        ...(envelope.agent_run_id ? { agent_run_id: envelope.agent_run_id } : {}),
        ...(envelope.invocation_id ? { invocation_id: envelope.invocation_id } : {}),
        ...(envelope.adapter_type ? { adapter_type: envelope.adapter_type } : {}),
        payload: {
          affected_source: input.source,
          type: input.type,
          byte_length_at_least: this.#maxFrameBytes + 1,
          digest: "omitted_to_preserve_memory_bound"
        }
      };
      bytes = encode(envelope);
      this.#dropped += 1;
    }
    const affectedSource = affectedSourceOf(envelope.payload);
    if (envelope.source === "control") {
      while (this.#controlBytes + bytes.byteLength > this.#controlReserveBytes && this.#count > 0) {
        this.#evictOldest();
      }
      if (bytes.byteLength > this.#controlReserveBytes
        || this.#controlBytes + bytes.byteLength > this.#controlReserveBytes) {
        this.#dropped += 1;
        return false;
      }
    }
    const budget = envelope.source === "control" ? this.#maxBytes : this.#maxBytes - this.#controlReserveBytes;
    while ((this.#count >= this.#slots.length || this.#bytes + bytes.byteLength > budget) && this.#count > 0) {
      this.#evictOldest();
    }
    if (bytes.byteLength > budget || this.#bytes + bytes.byteLength > budget) {
      this.#dropped += 1;
      return false;
    }
    const tail = (this.#head + this.#count) % this.#slots.length;
    this.#slots[tail] = {
      seq,
      runId: envelope.agent_run_id,
      source: envelope.source,
      type: envelope.type,
      ...(affectedSource ? { affectedSource } : {}),
      bytes,
      pins: 0,
      retired: false
    };
    this.#count += 1;
    this.#bytes += bytes.byteLength;
    if (envelope.source === "control") this.#controlBytes += bytes.byteLength;
    this.#wake();
    return true;
  }

  publishRecord(record: RecordEnvelope, sourceOverride?: LiveEventSource): boolean {
    const source = sourceOverride ?? sourceForRecord(record);
    const data = isRecord(record.data) ? record.data : {};
    return this.publish({
      source,
      type: record.event,
      stage: defaultStage(source),
      direction: source === "adapter-rpc"
        ? data.direction === "send" ? "daemon_to_host" : "host_to_daemon"
        : undefined,
      occurredAt: record.ts,
      runId: typeof record.run_id === "string" ? record.run_id : undefined,
      invocationId: typeof record.invocation_id === "string" ? record.invocation_id : undefined,
      adapterType: typeof record.adapter_type === "string" ? record.adapter_type : undefined,
      payload: source === "adapter-rpc" && data.frame !== undefined ? data.frame : record
    });
  }

  async *subscribe(filter: LiveEventFilter = {}, follow = false, signal?: AbortSignal): AsyncGenerator<LiveEventEnvelope> {
    for await (const bytes of this.subscribeBytes(filter, follow, signal)) {
      yield JSON.parse(bytes.toString("utf8")) as LiveEventEnvelope;
    }
  }

  /** Yield the immutable ring frame directly so transports do not copy payloads. */
  async *subscribeBytes(filter: LiveEventFilter = {}, follow = false, signal?: AbortSignal): AsyncGenerator<Buffer> {
    if (this.#subscribers >= this.#maxSubscribers) {
      throw Object.assign(new Error("live event subscriber limit reached"), { code: "BUS_SUBSCRIBER_LIMIT" });
    }
    this.#subscribers += 1;
    let cursor = this.#oldestSeq();
    const snapshotEnd = this.#nextSeq - 1;
    try {
      while (true) {
        if (signal?.aborted) return;
        const oldest = this.#oldestSeq();
        if (cursor < oldest) {
          const gap: LiveEventEnvelope = {
            schema: "octo-harness.live-event/v1",
            local_seq: cursor,
            occurred_at: new Date().toISOString(),
            source: "control",
            stage: "bus",
            type: "bus.gap",
            ...(filter.runId ? { agent_run_id: filter.runId } : {}),
            payload: { from_seq: cursor, to_seq: oldest }
          };
          cursor = oldest;
          yield encode(gap);
          continue;
        }
        const entry = this.#find(cursor, filter, follow ? Number.MAX_SAFE_INTEGER : snapshotEnd);
        if (entry) {
          cursor = entry.seq + 1;
          entry.pins += 1;
          try {
            yield entry.bytes;
          } finally {
            this.#release(entry);
          }
          continue;
        }
        if (!follow) return;
        cursor = this.#nextSeq;
        if (!await this.#wait(signal)) return;
      }
    } finally {
      this.#subscribers -= 1;
    }
  }

  #find(fromSeq: number, filter: LiveEventFilter, throughSeq: number): RingEntry | undefined {
    for (let offset = 0; offset < this.#count; offset++) {
      const entry = this.#slots[(this.#head + offset) % this.#slots.length];
      if (!entry || entry.seq < fromSeq || entry.seq > throughSeq) continue;
      if (filter.runId && entry.runId !== filter.runId && entry.type !== "bus.correlation_gap") continue;
      if (filter.source && entry.source !== filter.source && entry.affectedSource !== filter.source) continue;
      return entry;
    }
    return undefined;
  }

  #oldestSeq(): number {
    return this.#slots[this.#head]?.seq ?? this.#nextSeq;
  }

  #evictOldest(): void {
    const entry = this.#slots[this.#head];
    this.#slots[this.#head] = undefined;
    this.#head = (this.#head + 1) % this.#slots.length;
    this.#count -= 1;
    if (!entry) return;
    if (entry.pins > 0) {
      entry.retired = true;
      this.#retired.add(entry);
      return;
    }
    if (entry.source === "control") this.#controlBytes -= entry.bytes.byteLength;
    this.#bytes -= entry.bytes.byteLength;
  }

  #release(entry: RingEntry): void {
    entry.pins -= 1;
    if (entry.pins === 0 && entry.retired) {
      this.#retired.delete(entry);
      if (entry.source === "control") this.#controlBytes -= entry.bytes.byteLength;
      this.#bytes -= entry.bytes.byteLength;
    }
  }

  #wake(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const wake of waiters) wake();
  }

  #wait(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
      const finish = (available: boolean): void => {
        this.#waiters.delete(onEvent);
        signal?.removeEventListener("abort", onAbort);
        resolve(available);
      };
      const onEvent = (): void => finish(true);
      const onAbort = (): void => finish(false);
      this.#waiters.add(onEvent);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function encodeBounded(value: LiveEventEnvelope, maxBytes: number): Buffer | undefined {
  const estimate = estimatedJsonBytes(value, maxBytes);
  if (estimate > maxBytes) return undefined;
  const encoded = encode(value);
  return encoded.byteLength <= maxBytes ? encoded : undefined;
}

function estimatedJsonBytes(value: unknown, stopAfter = Number.MAX_SAFE_INTEGER): number {
  let bytes = 0;
  const add = (amount: number): void => {
    bytes += amount;
    if (bytes > stopAfter) throw OVERSIZE;
  };
  try {
    JSON.stringify(value, (key, item: unknown) => {
      if (key) add(jsonStringBytes(key) + 4);
      if (typeof item === "string") add(jsonStringBytes(item) + 2);
      else if (typeof item === "number" || typeof item === "bigint") add(String(item).length + 2);
      else if (typeof item === "boolean" || item === null) add(6);
      else if (typeof item === "object") add(4);
      return item;
    });
  } catch (error) {
    if (error !== OVERSIZE) return stopAfter + 1;
  }
  return bytes;
}

const OVERSIZE = new Error("oversize");

function jsonStringBytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code <= 0x1f) bytes += code <= 0x1f ? 6 : 2;
    else if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}

function affectedSourceOf(payload: unknown): LiveEventSource | undefined {
  if (!isRecord(payload) || typeof payload.affected_source !== "string") return undefined;
  return (LIVE_EVENT_SOURCES as readonly string[]).includes(payload.affected_source)
    ? payload.affected_source as LiveEventSource
    : undefined;
}

function encode(value: LiveEventEnvelope): Buffer {
  try {
    return Buffer.from(JSON.stringify(value));
  } catch (error) {
    return Buffer.from(JSON.stringify({
      schema: "octo-harness.live-event/v1",
      local_seq: value.local_seq,
      occurred_at: value.occurred_at,
      source: "control",
      stage: "bus",
      type: "event.serialization_failed",
      payload: { error: error instanceof Error ? error.message : String(error) }
    } satisfies LiveEventEnvelope));
  }
}

function sourceForRecord(record: RecordEnvelope): LiveEventSource {
  if (record.scope === "live-event.bus") return "control";
  if (record.scope === "adapter-host.rpc") return "adapter-rpc";
  if (record.scope === "provider.io") return "provider-native";
  if (record.scope === "transport.wss" || record.scope === "agent-work.delivery") return "worker";
  if (record.scope.startsWith("agent-work.") || record.scope.startsWith("adapter.")) return "runtime";
  return "daemon";
}

function defaultStage(source: LiveEventSource): string {
  const stages: Record<LiveEventSource, string> = {
    daemon: "daemon",
    "provider-native": "native",
    "adapter-canonical": "canonical_pre_host",
    "host-canonical": "canonical_post_host",
    "adapter-rpc": "wire",
    runtime: "runtime",
    worker: "worker_transport",
    control: "bus"
  };
  return stages[source];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new TypeError(`${name} must be a positive integer`);
  return resolved;
}

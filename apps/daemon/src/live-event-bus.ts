import { createHash } from "node:crypto";
import { redactCredentials, type RecordEnvelope } from "@mininglamp-oss/octo-harness-observability";

export const LIVE_EVENT_MEMORY_BYTES = 6 * 1024 * 1024;
export const LIVE_EVENT_MAX_FRAME_BYTES = 256 * 1024;
export const LIVE_EVENT_MAX_SLOTS = 8192;
export const LIVE_EVENT_MAX_SUBSCRIBERS = 16;
export const LIVE_EVENT_CONTROL_RESERVE_BYTES = 64 * 1024;

export type LiveEventSource =
  | "daemon"
  | "adapter-rpc"
  | "provider-native"
  | "adapter-canonical"
  | "host-canonical"
  | "control";

export interface LiveEventEnvelope {
  seq: number;
  ts: string;
  source: LiveEventSource;
  type: string;
  runId?: string;
  adapterType?: string;
  payload: unknown;
}

export interface LiveEventFilter {
  runId?: string;
  source?: LiveEventSource;
}

interface RingEntry {
  readonly seq: number;
  readonly runId?: string;
  readonly source: LiveEventSource;
  readonly bytes: Buffer;
  pins: number;
  retired: boolean;
}

export interface LiveEventBusStats {
  retainedBytes: number;
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
      Math.floor(this.#maxBytes / 8)
    );
    this.#slots = Array.from<RingEntry | undefined>({
      length: positive(options.maxSlots, LIVE_EVENT_MAX_SLOTS, "maxSlots")
    });
  }

  get stats(): LiveEventBusStats {
    return {
      retainedBytes: this.#bytes,
      retainedEvents: this.#count,
      retiredEvents: this.#retired.size,
      subscribers: this.#subscribers,
      droppedEvents: this.#dropped,
      nextSeq: this.#nextSeq
    };
  }

  publish(input: Omit<LiveEventEnvelope, "seq" | "ts"> & { ts?: string }): boolean {
    const seq = this.#nextSeq++;
    let envelope: LiveEventEnvelope = {
      seq,
      ts: input.ts ?? new Date().toISOString(),
      source: input.source,
      type: input.type,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.adapterType ? { adapterType: input.adapterType } : {}),
      payload: redactCredentials(input.payload)
    };
    let bytes = encode(envelope);
    if (bytes.byteLength > this.#maxFrameBytes) {
      envelope = {
        seq,
        ts: envelope.ts,
        source: "control",
        type: "event.oversize_dropped",
        ...(envelope.runId ? { runId: envelope.runId } : {}),
        ...(envelope.adapterType ? { adapterType: envelope.adapterType } : {}),
        payload: {
          source: input.source,
          type: input.type,
          byteLength: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex")
        }
      };
      bytes = encode(envelope);
      this.#dropped += 1;
    }
    const budget = envelope.source === "control"
      ? this.#maxBytes
      : this.#maxBytes - this.#controlReserveBytes;
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
      runId: envelope.runId,
      source: envelope.source,
      bytes: Buffer.from(bytes),
      pins: 0,
      retired: false
    };
    this.#count += 1;
    this.#bytes += bytes.byteLength;
    this.#wake();
    return true;
  }

  publishRecord(record: RecordEnvelope, sourceOverride?: LiveEventSource): boolean {
    const source: LiveEventSource = sourceOverride ?? (record.scope === "adapter-host.rpc"
      ? "adapter-rpc"
      : record.scope === "provider.io"
        ? "provider-native"
        : "daemon");
    return this.publish({
      source,
      type: record.event,
      ts: record.ts,
      runId: typeof record.run_id === "string" ? record.run_id : undefined,
      adapterType: typeof record.adapter_type === "string" ? record.adapter_type : undefined,
      payload: record
    });
  }

  async *subscribe(filter: LiveEventFilter = {}, follow = false, signal?: AbortSignal): AsyncGenerator<LiveEventEnvelope> {
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
            seq: cursor,
            ts: new Date().toISOString(),
            source: "control",
            type: "bus.gap",
            ...(filter.runId ? { runId: filter.runId } : {}),
            payload: { fromSeq: cursor, toSeq: oldest }
          };
          cursor = oldest;
          yield gap;
          continue;
        }
        const entry = this.#find(cursor, filter, follow ? Number.MAX_SAFE_INTEGER : snapshotEnd);
        if (entry) {
          cursor = entry.seq + 1;
          entry.pins += 1;
          try {
            yield JSON.parse(entry.bytes.toString("utf8")) as LiveEventEnvelope;
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
      if (filter.runId && entry.runId !== filter.runId) continue;
      if (filter.source && entry.source !== filter.source) continue;
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
    this.#bytes -= entry.bytes.byteLength;
  }

  #release(entry: RingEntry): void {
    entry.pins -= 1;
    if (entry.pins === 0 && entry.retired) {
      this.#retired.delete(entry);
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

function encode(value: LiveEventEnvelope): Buffer {
  try {
    return Buffer.from(JSON.stringify(value));
  } catch (error) {
    return Buffer.from(JSON.stringify({
      seq: value.seq,
      ts: value.ts,
      source: "control",
      type: "event.serialization_failed",
      payload: { error: error instanceof Error ? error.message : String(error) }
    } satisfies LiveEventEnvelope));
  }
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new TypeError(`${name} must be a positive integer`);
  return resolved;
}

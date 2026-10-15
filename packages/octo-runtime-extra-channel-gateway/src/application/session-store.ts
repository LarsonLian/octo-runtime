import type { InvokeRequest, ProviderSession } from "@mininglamp-oss/octo-runtime-protocol";
import type { ImTaskAttempt } from "../contracts.js";

export interface ImSessionOccurrence {
  text: string;
  sessionId: string;
  runId: string;
  snapshot?: Omit<InvokeRequest, "signal">;
  attempts?: ImTaskAttempt[];
}
export interface ImSessionBinding {
  id?: string;
  generation: number;
  providerSession?: ProviderSession;
  lastEventId?: string;
  lastRunId?: string;
}
export interface ImSessionStore {
  read(key: string): ImSessionBinding | undefined;
  save(key: string, binding: ImSessionBinding): void;
  reset(key: string, controlId: string): ImSessionBinding;
  occurrence(key: string, id: string): ImSessionOccurrence | undefined;
  remember(key: string, id: string, value: ImSessionOccurrence): void;
  close?(): void;
}

/** Bounded process-local mappings; eviction never restores an older session. */
class BoundedEntries<T> {
  readonly #entries = new Map<string, { value: T; bytes: number; expires: number }>();
  #bytes = 0;
  constructor(
    readonly count: number,
    readonly bytes: number,
    readonly ttl: number
  ) {}
  get(key: string): T | undefined {
    this.prune();
    const entry = this.#entries.get(key);
    return entry && structuredClone(entry.value);
  }
  set(key: string, value: T): void {
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.bytes) throw new Error("IM_SESSION_ENTRY_TOO_LARGE");
    this.prune();
    this.#delete(key);
    while (this.#entries.size >= this.count || this.#bytes + bytes > this.bytes)
      this.#delete(this.#entries.keys().next().value!);
    this.#entries.set(key, {
      value: structuredClone(value),
      bytes,
      expires: Date.now() + this.ttl
    });
    this.#bytes += bytes;
  }
  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.#entries) if (entry.expires <= now) this.#delete(key);
  }
  #delete(key: string): void {
    const previous = this.#entries.get(key);
    if (previous) this.#bytes -= previous.bytes;
    this.#entries.delete(key);
  }
  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }
}

export class MemoryImSessionStore implements ImSessionStore {
  readonly #bindings = new BoundedEntries<ImSessionBinding>(1024, 4 << 20, 24 * 60 * 60_000);
  readonly #controls = new BoundedEntries<boolean>(4096, 1 << 20, 120_000);
  readonly #occurrences = new BoundedEntries<ImSessionOccurrence>(4096, 16 << 20, 120_000);
  readonly #cleanup = setInterval(() => {
    this.#bindings.prune();
    this.#controls.prune();
    this.#occurrences.prune();
  }, 10_000);
  constructor() {
    this.#cleanup.unref();
  }
  read(key: string): ImSessionBinding | undefined {
    return this.#bindings.get(key);
  }
  save(key: string, value: ImSessionBinding): void {
    this.#bindings.set(key, value);
  }
  reset(key: string, id: string): ImSessionBinding {
    const controlKey = JSON.stringify([key, id]);
    if (this.#controls.get(controlKey)) {
      const current = this.read(key);
      if (!current) throw new Error("IM_SESSION_EXPIRED");
      return current;
    }
    const binding = { generation: (this.read(key)?.generation ?? 1) + 1 };
    this.save(key, binding);
    this.#controls.set(controlKey, true);
    return binding;
  }
  occurrence(key: string, id: string): ImSessionOccurrence | undefined {
    return this.#occurrences.get(JSON.stringify([key, id]));
  }
  remember(key: string, id: string, value: ImSessionOccurrence): void {
    this.#occurrences.set(JSON.stringify([key, id]), value);
  }
  close(): void {
    clearInterval(this.#cleanup);
    this.#bindings.clear();
    this.#controls.clear();
    this.#occurrences.clear();
  }
}

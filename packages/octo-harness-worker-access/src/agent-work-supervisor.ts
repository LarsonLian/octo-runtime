import type { AdapterHostRpc } from "@mininglamp-oss/octo-harness-adapter-host";
import type { LocalObservability } from "@mininglamp-oss/octo-harness-observability";
import {
  AgentWorkRuntime,
  DEFAULT_MAX_CONCURRENT_RUNS,
  type AgentWorkRuntimeOptions,
  type RunAdmission
} from "./agent-work-runtime.js";

interface RuntimeEntry {
  profile: string;
  runtime: AgentWorkRuntime;
  error?: string;
}

/** Owns all profile connections while keeping provider capacity machine-scoped. */
export class AgentWorkSupervisor {
  readonly #entries: RuntimeEntry[];
  readonly #admission: SharedRunAdmission;

  constructor(
    options: AgentWorkRuntimeOptions[],
    host: AdapterHostRpc,
    observability?: LocalObservability
  ) {
    const limit = options[0]?.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
    this.#admission = new SharedRunAdmission(limit);
    this.#entries = options.map((item, index) => ({
      profile: item.profile ?? `runtime-${index + 1}`,
      runtime: new AgentWorkRuntime(item, host, observability, this.#admission)
    }));
  }

  get status(): Record<string, unknown> {
    const runtimes: Array<Record<string, unknown>> = this.#entries.map(entry => ({
      ...entry.runtime.status,
      ...(entry.error ? { error: entry.error } : {})
    }));
    return {
      enabled: runtimes.length > 0,
      connected: runtimes.length > 0 && runtimes.every(runtime => runtime["connected"] === true),
      totalProfiles: runtimes.length,
      connectedProfiles: runtimes.filter(runtime => runtime["connected"] === true).length,
      activeRuns: this.#admission.active,
      maxConcurrentRuns: this.#admission.limit,
      runtimes
    };
  }

  async start(): Promise<void> {
    await Promise.all(this.#entries.map(async entry => {
      try {
        await entry.runtime.start();
        entry.error = undefined;
      } catch (error) {
        entry.error = errorMessage(error);
        await entry.runtime.close().catch(() => undefined);
      }
    }));
  }

  beginDrain(): void {
    for (const entry of this.#entries) entry.runtime.beginDrain();
  }

  readRunEvents(runId: string, streamId?: string, after = 0): ReturnType<AgentWorkRuntime["readRunEvents"]> {
    const entry = this.#entries.find(item => item.runtime.hasRun(runId));
    if (!entry) throw new Error("STREAM_EXPIRED");
    return entry.runtime.readRunEvents(runId, streamId, after);
  }

  async waitForDrained(timeoutMs: number): Promise<void> {
    await Promise.all(this.#entries.map(entry => entry.runtime.waitForDrained(timeoutMs)));
  }

  async close(): Promise<void> {
    await Promise.all(this.#entries.map(entry => entry.runtime.close()));
  }
}

export class SharedRunAdmission implements RunAdmission {
  readonly limit: number;
  #active = 0;
  readonly #waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
    onAbort: () => void;
  }> = [];

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("shared maxConcurrentRuns must be positive");
    this.limit = limit;
  }

  get active(): number {
    return this.#active;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new Error("Run admission aborted", { cause: signal.reason }));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        onAbort: (): void => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(new Error("Run admission aborted", { cause: signal.reason }));
        }
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.#waiters.push(waiter);
      this.#dispatch();
    });
  }

  #dispatch(): void {
    while (this.#active < this.limit && this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      if (!waiter || waiter.signal.aborted) continue;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      this.#active += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.#active -= 1;
        this.#dispatch();
      });
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

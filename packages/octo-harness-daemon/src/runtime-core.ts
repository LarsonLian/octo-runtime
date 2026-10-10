import { EventEmitter } from "node:events";
import type {
  AgentRunStatus,
  HarnessEngine,
  Store,
  SubmitAgentRunInput
} from "@mininglamp-oss/octo-harness-core";

const TERMINAL: ReadonlySet<AgentRunStatus> = new Set(["completed", "failed", "cancelled"]);
const HEAD_POLL_MS = 10;

/**
 * Single-process executor for the reference Session/Run core. It has no trigger,
 * Task or IM scheduler: callers must submit a fully formed business occurrence.
 */
export class HarnessDaemon extends EventEmitter {
  readonly #engine: HarnessEngine;
  readonly #store: Store;
  readonly #pending = new Map<string, Promise<unknown>>();
  readonly #waiters = new Map<string, Array<(result: unknown) => void>>();
  #admitting = 0;
  #draining = false;
  #stopped = false;

  constructor({ engine, store }: { engine: HarnessEngine; store: Store }) {
    super();
    this.#engine = engine;
    this.#store = store;
  }

  async recover(): Promise<void> {
    for (const run of this.#store.listAgentRuns()) {
      if (run.status === "running") {
        await this.#engine.terminalizeRun(run.id, { protocolVersion: 2,
          type: "run.failed",
          payload: { code: "daemon_restarted", message: "daemon restarted while provider was active" }
        });
      } else if (run.status === "queued") {
        this.#schedule(run.id);
      }
    }
  }

  get status(): { draining: boolean; activeRuns: number; admittingRuns: number } {
    return {
      draining: this.#draining,
      activeRuns: this.#pending.size,
      admittingRuns: this.#admitting
    };
  }

  /** Close admission before waiting so a service update cannot race a new Run. */
  beginDrain(): void {
    this.#draining = true;
  }

  async waitForDrained(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.#admitting > 0 || this.#pending.size > 0) {
      if (Date.now() >= deadline) {
        throw new Error(
          `daemon drain timed out with ${this.#admitting} admitting and ${this.#pending.size} active Runs`
        );
      }
      await new Promise<void>(resolve => setTimeout(resolve, HEAD_POLL_MS));
    }
  }

  stop(): void {
    this.#draining = true;
    this.#stopped = true;
  }

  async submitAgentRun(input: SubmitAgentRunInput): Promise<{
    accepted: boolean;
    deduplicated: boolean;
    agentSessionKey: string;
    runKey: string;
    runNo: number;
  }> {
    if (this.#draining || this.#stopped) {
      throw Object.assign(new Error("daemon is draining and is not accepting new AgentRuns"), {
        code: "DAEMON_DRAINING"
      });
    }
    this.#admitting += 1;
    try {
      const result = await this.#engine.submitAgentRun(input);
      if (!result.deduplicated && !TERMINAL.has(result.agentRun.status)) this.#schedule(result.agentRun.id);
      return {
        accepted: !result.deduplicated,
        deduplicated: result.deduplicated,
        agentSessionKey: result.agentSession.id,
        runKey: result.agentRun.id,
        runNo: result.agentRun.runNo
      };
    } finally {
      this.#admitting -= 1;
    }
  }

  #schedule(runKey: string): void {
    if (this.#pending.has(runKey)) return;
    const job = this.#waitUntilExecutable(runKey)
      .then(() => {
        this.emit("agent_run.started", { runKey });
        return this.#engine.executeRun(runKey);
      })
      .catch(async (error: unknown) => {
        await this.#engine.terminalizeRun(runKey, { protocolVersion: 2,
          type: "run.failed",
          payload: { code: "daemon_execution_error", message: errorMessage(error) }
        });
        return { run: this.#store.getAgentRun(runKey), error };
      })
      .then(result => {
        this.emit("agent_run.terminal", { runKey, status: this.#store.getAgentRun(runKey)?.status });
        for (const resolve of this.#waiters.get(runKey) ?? []) resolve(result);
        this.#waiters.delete(runKey);
        return result;
      })
      .finally(() => this.#pending.delete(runKey));
    this.#pending.set(runKey, job);
  }

  async #waitUntilExecutable(runKey: string): Promise<void> {
    while (!this.#stopped) {
      const run = this.#store.getAgentRun(runKey);
      if (!run || TERMINAL.has(run.status)) return;
      if (this.#engine.canExecute(runKey)) return;
      await new Promise<void>(resolve => setTimeout(resolve, HEAD_POLL_MS));
    }
    throw new Error("daemon stopped before AgentRun became executable");
  }

  async waitForRun(runKey: string): Promise<unknown> {
    const run = this.#store.getAgentRun(runKey);
    if (!run) throw new Error(`agent run not found: ${runKey}`);
    if (TERMINAL.has(run.status)) return { run, events: this.#store.getEvents(runKey) };
    return new Promise(resolve => {
      const waiters = this.#waiters.get(runKey) ?? [];
      waiters.push(resolve);
      this.#waiters.set(runKey, waiters);
    });
  }

  cancelRun(runKey: string, reason?: string): ReturnType<HarnessEngine["cancelRun"]> {
    return this.#engine.cancelRun(runKey, reason);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

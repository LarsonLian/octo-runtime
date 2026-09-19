import { performance } from "node:perf_hooks";
import { isTerminal, type CanonicalEvent, type RuntimeLimits } from "@mininglamp-oss/octo-harness-protocol";
import type { ProviderActivity } from "@mininglamp-oss/octo-harness-observability";

export const WATCHDOG_CAPABILITY = "runtime.watchdog.v2";
export const ACTIVITY_CAPABILITY = "activity.turn-progress";
export const DEFAULT_RUNTIME_LIMITS = {
  firstFrameTimeoutMs: 60_000,
  modelIdleTimeoutMs: 300_000,
  modelIdleWarningMs: 120_000,
  modelIdlePolicy: "enforce" as const,
  toolTimeoutMs: 600_000,
  runTimeoutMs: 3_600_000,
  cancelGraceMs: 1_000,
  enforcement: "enforce" as const
};
export type EffectiveLimits = Required<Omit<RuntimeLimits, "toolWallTimeoutMs">> & Pick<RuntimeLimits, "toolWallTimeoutMs">;

export function normalizeRuntimeLimits(value: RuntimeLimits | undefined): EffectiveLimits {
  return { ...DEFAULT_RUNTIME_LIMITS, ...value };
}

export type WatchdogPhase = "starting" | "model_active" | "tool_active" | "cancelling" | "terminal";
export type WatchdogReason = "first_frame" | "model_silence" | "tool_idle" | "tool_deadline" | "run_deadline" | "cleanup_timeout";
export interface WatchdogDiagnostic {
  event: "started" | "model_silence" | "progress_resumed" | "timeout" | "finished";
  data: Record<string, unknown>;
}
export interface WatchdogClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}
const clock: WatchdogClock = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  }
};

/** One autonomous timer per invocation. Neither consumer pulls nor logging drive deadlines. */
export class InvocationWatchdog {
  readonly limits: EffectiveLimits;
  readonly #startedAt: number;
  readonly #tools = new Map<string, { startedAt: number; progressAt: number }>();
  #phase: WatchdogPhase = "starting";
  #phaseAt: number;
  #progressAt: number;
  #canonicalAt: number;
  #transportAt: number;
  #maxCanonicalGapMs = 0;
  #maxProgressGapMs = 0;
  #lastMethod = "none";
  #retryCount = 0;
  #warned = false;
  #cancelTimer?: () => void;
  #unsubscribe: () => void;

  constructor(
    limits: RuntimeLimits | undefined,
    readonly controller: AbortController,
    readonly nativeActivity: boolean,
    readonly diagnostic: (value: WatchdogDiagnostic) => void = () => {},
    readonly time: WatchdogClock = clock
  ) {
    this.limits = normalizeRuntimeLimits(limits);
    this.#startedAt = this.#phaseAt = this.#progressAt = this.#canonicalAt = this.#transportAt = time.now();
    const cancel = () => { this.#phase = "cancelling"; this.#cancelTimer?.(); };
    controller.signal.addEventListener("abort", cancel, { once: true });
    this.#unsubscribe = () => controller.signal.removeEventListener("abort", cancel);
    this.#emit("started", { effectiveLimits: this.limits, limitsSource: limits ? "request_with_defaults" : "host_defaults" });
    this.#arm();
  }

  activity(activity: ProviderActivity): void {
    if (!this.#active()) return;
    if (!["turn_started", "turn_progress", "transport_response", "retry_notice"].includes(activity.kind)) return;
    if (!["turn_start", "text_delta", "tool_delta", "item_lifecycle", "usage", "rpc_response", "retry"].includes(activity.method)) return;
    this.#transportAt = this.time.now();
    this.#lastMethod = activity.method;
    if (activity.kind === "turn_started") {
      if (this.#phase === "starting") { this.#phase = "model_active"; this.#phaseAt = this.#progressAt = this.time.now(); }
    } else if (activity.kind === "turn_progress") {
      this.#progress(activity.toolCallId);
    } else if (activity.kind === "retry_notice") this.#retryCount++;
    this.#arm();
  }

  canonical(event: CanonicalEvent): void {
    if (!this.#active()) return;
    const now = this.time.now();
    this.#maxCanonicalGapMs = Math.max(this.#maxCanonicalGapMs, now - this.#canonicalAt);
    this.#canonicalAt = now;
    if (isTerminal(event)) { this.finish(); return; }
    const rawID = event.payload.toolCallId ?? event.payload.id ?? event.payload.itemId;
    const id = typeof rawID === "string" ? rawID : "tool";
    if (event.type === "tool_call.create" && !this.#tools.has(id)) {
      this.#tools.set(id, { startedAt: now, progressAt: now });
    }
    if (event.type === "tool_call.update" && ["completed", "failed", "cancelled", "stopped"].includes(String(event.payload.status))) {
      this.#tools.delete(id);
    }
    const phase = this.#tools.size ? "tool_active" : "model_active";
    if (phase !== this.#phase) {
      this.#phase = phase;
      this.#phaseAt = this.#progressAt = now;
      this.#warned = false;
    }
    // Native-aware providers classify progress before normalization. Repeated
    // usage or unrelated canonical records cannot keep a stalled turn alive.
    if (!this.nativeActivity && event.type !== "usage.update" && event.type !== "session.update") {
      this.#progress(event.type.startsWith("tool_call.") ? id : undefined);
    }
    this.#arm();
  }

  snapshot(): Record<string, unknown> {
    const now = this.time.now();
    const age = (at: number) => Math.max(0, Math.floor(now - at));
    return {
      phase: this.#phase,
      elapsedMs: age(this.#startedAt), phaseAgeMs: age(this.#phaseAt),
      lastCanonicalAgeMs: age(this.#canonicalAt), lastProgressAgeMs: age(this.#progressAt),
      lastTransportAgeMs: age(this.#transportAt),
      maxCanonicalGapMs: Math.floor(Math.max(this.#maxCanonicalGapMs, now - this.#canonicalAt)),
      maxProgressGapMs: Math.floor(Math.max(this.#maxProgressGapMs, now - this.#progressAt)),
      openToolCount: this.#tools.size, retryCount: this.#retryCount,
      lastMethod: this.#lastMethod,
      activitySupport: this.nativeActivity ? "native_progress" : "canonical_only",
      modelIdlePolicy: this.limits.modelIdlePolicy
    };
  }

  finish(): void {
    if (this.#phase === "terminal") return;
    this.#emit("finished");
    this.#phase = "terminal";
    this.dispose();
  }

  dispose(): void { this.#cancelTimer?.(); this.#cancelTimer = undefined; this.#unsubscribe(); }

  #active(): boolean { return this.#phase !== "terminal" && this.#phase !== "cancelling" && !this.controller.signal.aborted; }

  #progress(toolCallId?: string): void {
    const now = this.time.now();
    this.#maxProgressGapMs = Math.max(this.#maxProgressGapMs, now - this.#progressAt);
    this.#progressAt = now;
    if (this.#phase === "starting") { this.#phase = "model_active"; this.#phaseAt = now; }
    const tool = toolCallId ? this.#tools.get(toolCallId) : undefined;
    if (tool) tool.progressAt = now;
    if (this.#warned) { this.#warned = false; this.#emit("progress_resumed"); }
  }

  #arm(): void {
    this.#cancelTimer?.();
    if (!this.#active() || this.limits.enforcement === "observe") return; // legacy opt-out
    const now = this.time.now();
    const deadlines: { at: number; reason: WatchdogReason; budget: number }[] = [
      { at: this.#startedAt + this.limits.runTimeoutMs, reason: "run_deadline", budget: this.limits.runTimeoutMs }
    ];
    if (this.#phase === "starting") deadlines.push({ at: this.#startedAt + this.limits.firstFrameTimeoutMs, reason: "first_frame", budget: this.limits.firstFrameTimeoutMs });
    if (this.#phase === "model_active" && this.limits.modelIdlePolicy === "enforce") deadlines.push({ at: this.#progressAt + this.limits.modelIdleTimeoutMs, reason: "model_silence", budget: this.limits.modelIdleTimeoutMs });
    for (const tool of this.#tools.values()) {
      deadlines.push({ at: tool.progressAt + this.limits.toolTimeoutMs, reason: "tool_idle", budget: this.limits.toolTimeoutMs });
      if (this.limits.toolWallTimeoutMs !== undefined) deadlines.push({ at: tool.startedAt + this.limits.toolWallTimeoutMs, reason: "tool_deadline", budget: this.limits.toolWallTimeoutMs });
    }
    // Overall resource deadline wins ties, independently of the phase name.
    const due = deadlines.find(d => d.reason === "run_deadline" && d.at <= now)
      ?? deadlines.filter(d => d.at <= now).sort((a,b) => a.at - b.at)[0];
    if (due) {
      const stage = due.reason === "run_deadline" ? "run_deadline" : this.#phase;
      const evidence = this.snapshot();
      const error = new AdapterWatchdogTimeoutError(stage, due.budget, due.reason, evidence);
      this.#phase = "cancelling";
      this.#emit("timeout", { ...evidence, timeoutStage: stage, timeoutMs: due.budget, timeoutReason: due.reason });
      this.controller.abort(error);
      return;
    }
    if (this.#phase === "model_active" && !this.#warned && now >= this.#progressAt + this.limits.modelIdleWarningMs) {
      this.#warned = true;
      this.#emit("model_silence");
    }
    let nextAt = Math.min(...deadlines.map(d => d.at));
    if (this.#phase === "model_active" && !this.#warned) nextAt = Math.min(nextAt, this.#progressAt + this.limits.modelIdleWarningMs);
    this.#cancelTimer = this.time.schedule(() => this.#arm(), Math.max(1, nextAt - this.time.now()));
  }

  #emit(event: WatchdogDiagnostic["event"], extra: Record<string, unknown> = {}): void {
    try { this.diagnostic({ event, data: { ...this.snapshot(), ...extra } }); } catch { /* diagnostic sinks cannot affect execution */ }
  }
}

export class AdapterWatchdogTimeoutError extends Error {
  readonly code = "ADAPTER_TIMEOUT";
  constructor(readonly timeoutStage: string, readonly timeoutMs: number, readonly timeoutReason: WatchdogReason, readonly evidence: Record<string, unknown> = {}) {
    super(`adapter watchdog exceeded ${timeoutReason} budget`);
    this.name = "AdapterWatchdogTimeoutError";
  }
}

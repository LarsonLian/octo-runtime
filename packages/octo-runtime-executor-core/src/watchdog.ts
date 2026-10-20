import type { ProviderActivity } from "@mininglamp-oss/octo-runtime-adapter-sdk";
import {
  isTerminal,
  type CanonicalEvent,
  type RuntimeLimits
} from "@mininglamp-oss/octo-runtime-protocol";
import { performance } from "node:perf_hooks";

export const DEFAULT_RUNTIME_LIMITS = {
  firstFrameTimeoutMs: 60_000,
  modelIdleTimeoutMs: 300_000,
  modelIdleWarningMs: 120_000,
  modelIdlePolicy: "enforce" as const,
  toolTimeoutMs: 600_000,
  runTimeoutMs: 10_800_000,
  cancelGraceMs: 1_000,
  enforcement: "enforce" as const
};
export type EffectiveLimits = Required<Omit<RuntimeLimits, "toolWallTimeoutMs">> &
  Pick<RuntimeLimits, "toolWallTimeoutMs">;

export function normalizeRuntimeLimits(value: RuntimeLimits | undefined): EffectiveLimits {
  return { ...DEFAULT_RUNTIME_LIMITS, ...value };
}

export type WatchdogPhase =
  "starting" | "model_active" | "tool_active" | "waiting_approval" | "cancelling" | "terminal";
export type WatchdogReason =
  | "first_frame"
  | "model_silence"
  | "tool_idle"
  | "tool_deadline"
  | "run_deadline"
  | "cleanup_timeout";
export interface WatchdogDiagnostic {
  event: "started" | "activity" | "model_silence" | "progress_resumed" | "timeout" | "finished";
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
  readonly #interactions = new Set<string>();
  #waitingSince?: number;
  #nativeProgressSeen = false;
  #modelStarted = false;
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
  #activityLoggedAt = -Infinity;
  #finished = false;
  #terminalSnapshot?: Record<string, unknown>;
  #cancelTimer?: () => void;
  #unsubscribe: () => void;

  constructor(
    limits: RuntimeLimits | undefined,
    readonly controller: AbortController,
    readonly diagnostic: (value: WatchdogDiagnostic) => void = () => {},
    readonly time: WatchdogClock = clock
  ) {
    this.limits = normalizeRuntimeLimits(limits);
    this.#startedAt =
      this.#phaseAt =
      this.#progressAt =
      this.#canonicalAt =
      this.#transportAt =
        time.now();
    const cancel = () => {
      this.#phase = "cancelling";
      this.#cancelTimer?.();
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    this.#unsubscribe = () => controller.signal.removeEventListener("abort", cancel);
    this.#emit("started", {
      effectiveLimits: this.limits,
      limitsSource: limits ? "request_with_defaults" : "host_defaults"
    });
    this.#arm();
  }

  activity(activity: ProviderActivity): void {
    if (!this.#active()) return;
    const valid =
      activity.kind === "turn_started"
        ? activity.method === "turn_start"
        : activity.kind === "turn_progress"
          ? ["text_delta", "tool_delta", "item_lifecycle", "usage"].includes(activity.method)
          : activity.kind === "transport_response"
            ? activity.method === "rpc_response"
            : activity.kind === "retry_notice" && activity.method === "retry";
    if (
      !valid ||
      (activity.toolCallId !== undefined &&
        (typeof activity.toolCallId !== "string" || !activity.toolCallId)) ||
      (activity.toolState !== undefined &&
        (activity.kind !== "turn_progress" ||
          activity.method !== "item_lifecycle" ||
          !activity.toolCallId ||
          !["started", "completed"].includes(activity.toolState)))
    )
      return;
    const now = this.time.now();
    if (activity.kind === "turn_started" || activity.kind === "turn_progress")
      this.#nativeProgressSeen = true;
    if (activity.toolCallId && activity.toolState === "started") {
      if (!this.#tools.has(activity.toolCallId))
        this.#tools.set(activity.toolCallId, { startedAt: now, progressAt: now });
    }
    if (activity.toolCallId && activity.toolState === "completed") {
      this.#tools.delete(activity.toolCallId);
    }
    this.#transportAt = now;
    this.#lastMethod = activity.method;
    if (activity.kind === "turn_started") {
      if (!this.#modelStarted) this.#progress();
    } else if (activity.kind === "turn_progress") {
      this.#progress(activity.toolCallId);
    } else if (activity.kind === "retry_notice") this.#retryCount++;
    this.#syncPhase();
    if (this.time.now() - this.#activityLoggedAt >= 1000) {
      this.#activityLoggedAt = this.time.now();
      this.#emit("activity");
    }
    this.#arm();
  }

  canonical(event: CanonicalEvent): void {
    if (!this.#active()) return;
    const now = this.time.now();
    this.#maxCanonicalGapMs = Math.max(this.#maxCanonicalGapMs, now - this.#canonicalAt);
    this.#canonicalAt = now;
    if (isTerminal(event)) {
      this.#terminalSnapshot = this.snapshot();
      this.#phase = "terminal";
      this.dispose();
      return;
    }
    const rawID = event.payload.toolCallId ?? event.payload.id ?? event.payload.itemId;
    const id = typeof rawID === "string" && rawID ? rawID : undefined;
    let toolChanged = false;
    if (event.type === "tool_call.create" && id && !this.#tools.has(id)) {
      this.#tools.set(id, { startedAt: now, progressAt: now });
      this.#modelStarted = toolChanged = true;
    }
    if (
      event.type === "tool_call.update" &&
      id &&
      ["completed", "failed", "cancelled", "stopped"].includes(String(event.payload.status))
    ) {
      toolChanged = this.#tools.delete(id);
    }
    if (event.type === "interaction.requested" && typeof event.payload.interactionId === "string") {
      this.#interaction(event.payload.interactionId, true);
    }
    if (event.type === "interaction.resolved" && typeof event.payload.interactionId === "string") {
      this.#interaction(event.payload.interactionId, false);
    }
    const hasText = (value: unknown): boolean => typeof value === "string" && value.length > 0;
    const toolProgress = event.payload.progress;
    const progress =
      toolChanged ||
      (event.type.startsWith("message.") && hasText(event.payload.text)) ||
      event.type === "model_step.started" ||
      event.type === "model_step.finished" ||
      (event.type === "tool_call.delta" &&
        [event.payload.argsDelta, event.payload.outputDelta, event.payload.outputSnapshot].some(
          hasText
        )) ||
      (event.type === "tool_call.progress" &&
        typeof toolProgress === "object" &&
        toolProgress !== null &&
        !Array.isArray(toolProgress) &&
        (("message" in toolProgress && hasText(toolProgress.message)) ||
          ("completed" in toolProgress && typeof toolProgress.completed === "number")));
    // Only real turn work exits startup. Bookkeeping and empty placeholders do not.
    if (!this.#nativeProgressSeen && progress) {
      this.#progress(event.type.startsWith("tool_call.") ? id : undefined);
    }
    this.#syncPhase();
    this.#arm();
  }

  /** Lifetime evidence is independent of provider payload conversion. */
  interaction(requestId: string | number, pending: boolean): void {
    if (!this.#active()) return;
    this.#interaction(`${typeof requestId}:${requestId}`, pending);
    this.#syncPhase();
    this.#arm();
  }

  #interaction(id: string, pending: boolean): void {
    const now = this.time.now();
    if (pending) {
      if (!this.#interactions.size) this.#waitingSince = now;
      this.#interactions.add(id);
    } else {
      this.#interactions.delete(id);
      if (!this.#interactions.size && this.#waitingSince !== undefined) {
        // Each timestamp is suspended only for its own overlap with the wait.
        this.#progressAt += now - Math.max(this.#waitingSince, this.#progressAt);
        for (const tool of this.#tools.values()) {
          tool.startedAt += now - Math.max(this.#waitingSince, tool.startedAt);
          tool.progressAt += now - Math.max(this.#waitingSince, tool.progressAt);
        }
        this.#waitingSince = undefined;
      }
    }
  }

  terminal(): void {
    this.#terminalSnapshot = this.snapshot();
    this.#phase = "terminal";
    this.dispose();
  }

  snapshot(): Record<string, unknown> {
    const now = this.time.now();
    const age = (at: number) => Math.max(0, Math.floor(now - at));
    return {
      phase: this.#phase,
      elapsedMs: age(this.#startedAt),
      phaseAgeMs: age(this.#phaseAt),
      lastCanonicalAgeMs: age(this.#canonicalAt),
      lastProgressAgeMs: age(this.#progressAt),
      lastTransportAgeMs: age(this.#transportAt),
      maxCanonicalGapMs: Math.floor(Math.max(this.#maxCanonicalGapMs, now - this.#canonicalAt)),
      maxProgressGapMs: Math.floor(Math.max(this.#maxProgressGapMs, now - this.#progressAt)),
      openToolCount: this.#tools.size,
      pendingInteractionCount: this.#interactions.size,
      retryCount: this.#retryCount,
      lastMethod: this.#lastMethod,
      activitySupport: this.#nativeProgressSeen ? "native_progress" : "canonical_only",
      modelIdlePolicy: this.limits.modelIdlePolicy
    };
  }

  finish(outcome = "stopped"): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#emit("finished", { ...this.#terminalSnapshot, outcome });
    this.#phase = "terminal";
    this.dispose();
  }

  dispose(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    this.#unsubscribe();
  }

  #active(): boolean {
    return (
      this.#phase !== "terminal" && this.#phase !== "cancelling" && !this.controller.signal.aborted
    );
  }

  #progress(toolCallId?: string): void {
    const now = this.time.now();
    this.#maxProgressGapMs = Math.max(this.#maxProgressGapMs, now - this.#progressAt);
    this.#progressAt = now;
    this.#modelStarted = true;
    const tool = toolCallId ? this.#tools.get(toolCallId) : undefined;
    if (tool) tool.progressAt = now;
    if (this.#warned) {
      this.#warned = false;
      this.#emit("progress_resumed");
    }
  }

  #syncPhase(): void {
    const phase = this.#interactions.size
      ? "waiting_approval"
      : this.#tools.size
        ? "tool_active"
        : this.#modelStarted
          ? "model_active"
          : "starting";
    if (phase === this.#phase) return;
    if (this.#phase === "tool_active" && phase === "model_active")
      this.#progressAt = this.time.now();
    this.#phase = phase;
    this.#phaseAt = this.time.now();
    this.#warned = false;
  }

  #arm(): void {
    this.#cancelTimer?.();
    if (!this.#active() || this.limits.enforcement === "observe") return; // legacy opt-out
    const now = this.time.now();
    const deadlines: { at: number; reason: WatchdogReason; budget: number }[] = [
      {
        at: this.#startedAt + this.limits.runTimeoutMs,
        reason: "run_deadline",
        budget: this.limits.runTimeoutMs
      }
    ];
    if (this.#phase === "starting")
      deadlines.push({
        at: this.#startedAt + this.limits.firstFrameTimeoutMs,
        reason: "first_frame",
        budget: this.limits.firstFrameTimeoutMs
      });
    if (this.#phase === "model_active" && this.limits.modelIdlePolicy === "enforce")
      deadlines.push({
        at: this.#progressAt + this.limits.modelIdleTimeoutMs,
        reason: "model_silence",
        budget: this.limits.modelIdleTimeoutMs
      });
    for (const tool of this.#phase === "waiting_approval" ? [] : this.#tools.values()) {
      deadlines.push({
        at: tool.progressAt + this.limits.toolTimeoutMs,
        reason: "tool_idle",
        budget: this.limits.toolTimeoutMs
      });
      if (this.limits.toolWallTimeoutMs !== undefined)
        deadlines.push({
          at: tool.startedAt + this.limits.toolWallTimeoutMs,
          reason: "tool_deadline",
          budget: this.limits.toolWallTimeoutMs
        });
    }
    // Overall resource deadline wins ties, independently of the phase name.
    const due =
      deadlines.find((d) => d.reason === "run_deadline" && d.at <= now) ??
      deadlines.filter((d) => d.at <= now).sort((a, b) => a.at - b.at)[0];
    if (due) {
      const stage = due.reason === "run_deadline" ? "run_deadline" : this.#phase;
      const evidence = this.snapshot();
      const error = new AdapterWatchdogTimeoutError(stage, due.budget, due.reason, evidence);
      this.#phase = "cancelling";
      this.#emit("timeout", {
        ...evidence,
        timeoutStage: stage,
        timeoutMs: due.budget,
        timeoutReason: due.reason
      });
      this.controller.abort(error);
      return;
    }
    if (
      this.#phase === "model_active" &&
      !this.#warned &&
      now >= this.#progressAt + this.limits.modelIdleWarningMs
    ) {
      this.#warned = true;
      this.#emit("model_silence");
    }
    let nextAt = Math.min(...deadlines.map((d) => d.at));
    if (this.#phase === "model_active" && !this.#warned)
      nextAt = Math.min(nextAt, this.#progressAt + this.limits.modelIdleWarningMs);
    this.#cancelTimer = this.time.schedule(
      () => this.#arm(),
      Math.max(1, nextAt - this.time.now())
    );
  }

  #emit(event: WatchdogDiagnostic["event"], extra: Record<string, unknown> = {}): void {
    try {
      this.diagnostic({ event, data: { ...this.snapshot(), ...extra } });
    } catch {
      /* diagnostic sinks cannot affect execution */
    }
  }
}

export class AdapterWatchdogTimeoutError extends Error {
  readonly code: string;
  constructor(
    readonly timeoutStage: string,
    readonly timeoutMs: number,
    readonly timeoutReason: WatchdogReason,
    readonly evidence: Record<string, unknown> = {}
  ) {
    super(`adapter watchdog exceeded ${timeoutReason} budget`);
    this.name = "AdapterWatchdogTimeoutError";
    this.code = {
      first_frame: "ADAPTER_FIRST_FRAME_TIMEOUT",
      model_silence: "ADAPTER_MODEL_IDLE_TIMEOUT",
      tool_idle: "ADAPTER_TOOL_IDLE_TIMEOUT",
      tool_deadline: "ADAPTER_TOOL_DEADLINE",
      run_deadline: "ADAPTER_RUN_DEADLINE",
      cleanup_timeout: "ADAPTER_CLEANUP_TIMEOUT"
    }[timeoutReason];
  }
}

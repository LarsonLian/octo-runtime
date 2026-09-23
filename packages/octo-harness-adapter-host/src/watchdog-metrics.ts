import type { WatchdogDiagnostic } from "./watchdog.js";

const ADAPTERS = new Set(["codex", "claude-code", "codebuddy", "kimi-code", "opencode"]);
const REASONS = new Set(["first_frame", "model_silence", "tool_idle", "tool_deadline", "run_deadline", "cleanup_timeout"]);
const BUCKETS = [1, 5, 30, 120, 300, 600, 3600, Infinity];
interface Series { name: string; labels: Record<string, string>; value: number }

/** Fixed label domains and cumulative snapshots: lost diagnostic frames do not
 * permanently lose counters. Run/session/revision IDs never enter metrics. */
export class WatchdogMetrics {
  readonly #series = new Map<string, Series>();

  record(adapterType: string, diagnostic: WatchdogDiagnostic): void {
    const adapter = ADAPTERS.has(adapterType) ? adapterType : "other";
    const policy = diagnostic.data.modelIdlePolicy === "observe" ? "observe" : "enforce";
    const labels = { adapter, policy };
    if (diagnostic.event === "started") {
      this.#add("invocations_total", labels, 1);
      this.#add("active", labels, 1);
    }
    if (diagnostic.event === "model_silence") this.#add("model_silence_warnings_total", labels, 1);
    if (diagnostic.event === "timeout") {
      const reason = String(diagnostic.data.timeoutReason);
      if (REASONS.has(reason)) this.#add("timeouts_total", { ...labels, reason }, 1);
    }
    if (diagnostic.event !== "finished") return;
    this.#add("active", labels, -1);
    const outcome = ["completed", "failed", "stopped"].includes(String(diagnostic.data.outcome)) ? String(diagnostic.data.outcome) : "stopped";
    this.#add("outcomes_total", { ...labels, outcome }, 1);
    // Failed/stopped samples are censored; expose them separately from success.
    for (const [kind, field] of [["canonical", "maxCanonicalGapMs"], ["progress", "maxProgressGapMs"]]) {
      const raw = diagnostic.data[field];
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) continue;
      const seconds = raw / 1000;
      const dimensions = { ...labels, outcome, kind };
      for (const bound of BUCKETS) if (seconds <= bound) this.#add("max_gap_seconds_bucket", { ...dimensions, le: bound === Infinity ? "+Inf" : String(bound) }, 1);
      // Include zero buckets to make histogram quantiles meaningful.
      for (const bound of BUCKETS) this.#add("max_gap_seconds_bucket", { ...dimensions, le: bound === Infinity ? "+Inf" : String(bound) }, 0);
      this.#add("max_gap_seconds_sum", dimensions, seconds);
      this.#add("max_gap_seconds_count", dimensions, 1);
    }
  }

  snapshot(): Series[] { return [...this.#series.values()].map(row => ({ ...row, labels: { ...row.labels } })); }

  #add(name: string, labels: Record<string, string>, value: number): void {
    const key = JSON.stringify([name, labels]);
    const row = this.#series.get(key) ?? { name, labels, value: 0 };
    row.value = Math.max(0, row.value + value);
    this.#series.set(key, row);
  }
}

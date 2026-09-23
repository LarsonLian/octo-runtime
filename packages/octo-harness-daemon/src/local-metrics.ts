const CONNECTION_STATES = new Set([
  "stopped", "starting", "registering", "connecting", "awaiting_welcome",
  "online", "backing_off", "action_required"
]);
const STORE_STATES = new Set([
  "healthy", "low_disk", "full", "corrupt_quarantined", "migration_failed"
]);
const RECOVERY_TRIGGERS = new Set(["transport", "server_goaway", "network_change", "system_resume", "clock_change"]);
const CONNECTION_REASONS = new Set([
  "none", "transport", "receive_timeout", "dns", "tls", "auth", "server_goaway",
  "network_change", "system_resume", "clock_change"
]);

/** Render local-only metrics from the daemon's already bounded status view. */
export function renderLocalMetrics(status: unknown): string {
  const root = record(status);
  const agentWork = record(root.agentWork);
  const runtimes = Array.isArray(agentWork.runtimes) ? agentWork.runtimes : [];
  const lines = [
    "# HELP octo_harness_runtime_connection_state Current local Runtime connection state.",
    "# TYPE octo_harness_runtime_connection_state gauge",
    "# HELP octo_harness_runtime_recovery_seconds Most recent completed recovery duration.",
    "# TYPE octo_harness_runtime_recovery_seconds gauge",
    "# HELP octo_harness_outbox_oldest_seconds Age of the oldest locally retained unacknowledged event.",
    "# TYPE octo_harness_outbox_oldest_seconds gauge",
    "# HELP octo_harness_outbox_pending_bytes Bytes retained in the local event outbox.",
    "# TYPE octo_harness_outbox_pending_bytes gauge",
    "# HELP octo_harness_store_health Current local Runtime store health state.",
    "# TYPE octo_harness_store_health gauge"
  ];
  for (const item of runtimes) {
    const runtime = record(item);
    const profile = label(string(runtime.profile) || "unknown");
    const connectionState = bounded(string(runtime.connectionState), CONNECTION_STATES, "unknown");
    const connectionReason = bounded(string(runtime.connectionReason), CONNECTION_REASONS, "transport");
    lines.push(`octo_harness_runtime_connection_state{profile="${profile}",state="${connectionState}",reason="${connectionReason}"} 1`);
    const recoveryDurationMs = number(runtime.lastRecoveryDurationMs);
    if (recoveryDurationMs !== undefined && recoveryDurationMs >= 0) {
      const trigger = bounded(string(runtime.lastRecoveryTrigger), RECOVERY_TRIGGERS, "transport");
      lines.push(`octo_harness_runtime_recovery_seconds{profile="${profile}",trigger="${trigger}",outcome="online"} ${recoveryDurationMs / 1000}`);
    }
    const oldestAgeMs = number(runtime.outboxOldestAgeMs);
    lines.push(`octo_harness_outbox_oldest_seconds{profile="${profile}",kind="event"} ${Math.max(0, oldestAgeMs ?? 0) / 1000}`);
    lines.push(`octo_harness_outbox_pending_bytes{profile="${profile}",kind="event"} ${Math.max(0, number(runtime.outboxPendingBytes) ?? 0)}`);
    const storeHealth = record(runtime.storeHealth);
    const storeState = bounded(string(storeHealth.state), STORE_STATES, "migration_failed");
    lines.push(`octo_harness_store_health{profile="${profile}",state="${storeState}"} 1`);
  }
  const watchdog = record(root.watchdogMetrics);
  const capturedAt = number(watchdog.capturedAt);
  if (capturedAt !== undefined) {
    lines.push("# TYPE octo_harness_watchdog_snapshot_age_seconds gauge");
    lines.push(`octo_harness_watchdog_snapshot_age_seconds ${Math.max(0, Date.now() - capturedAt) / 1000}`);
  }
  for (const [name, type] of Object.entries(WATCHDOG_TYPES)) lines.push(`# TYPE octo_harness_watchdog_${name} ${type}`);
  const series = Array.isArray(watchdog.series) ? watchdog.series.slice(0, 2048) : [];
  for (const item of series) {
    const row = record(item);
    const name = string(row.name);
    const value = number(row.value);
    if (!WATCHDOG_NAMES.has(name) || value === undefined || value < 0) continue;
    const dimensions = record(row.labels);
    const entries = Object.entries(dimensions);
    if (!entries.length || entries.some(([key, val]) => !WATCHDOG_LABELS[key]?.has(string(val)))) continue;
    const labels = entries.map(([key, val]) => `${key}="${string(val)}"`).join(",");
    lines.push(`octo_harness_watchdog_${name}{${labels}} ${value}`);
  }
  return `${lines.join("\n")}\n`;
}

const WATCHDOG_TYPES = { invocations_total: "counter", active: "gauge", outcomes_total: "counter", model_silence_warnings_total: "counter", timeouts_total: "counter", max_gap_seconds: "histogram" };
const WATCHDOG_NAMES = new Set(["invocations_total", "active", "outcomes_total", "model_silence_warnings_total", "timeouts_total", "max_gap_seconds_bucket", "max_gap_seconds_sum", "max_gap_seconds_count"]);
const WATCHDOG_LABELS: Record<string, ReadonlySet<string>> = {
  adapter: new Set(["codex", "claude-code", "codebuddy", "kimi-code", "opencode", "other"]),
  policy: new Set(["observe", "enforce"]), outcome: new Set(["completed", "failed", "stopped"]),
  reason: new Set(["first_frame", "model_silence", "tool_idle", "tool_deadline", "run_deadline", "cleanup_timeout"]),
  kind: new Set(["canonical", "progress"]), le: new Set(["1", "5", "30", "120", "300", "600", "3600", "+Inf"])
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bounded(value: string, allowed: ReadonlySet<string>, fallback: string): string {
  return allowed.has(value) ? value : fallback;
}

function label(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

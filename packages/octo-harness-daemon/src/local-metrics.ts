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
  return `${lines.join("\n")}\n`;
}

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

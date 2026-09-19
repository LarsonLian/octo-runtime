import { readFileSync } from "node:fs";

const MAX_TIMELINE_RECORDS = 500;
const MAX_STRING_LENGTH = 256;
const PACKAGE_VERSION = packageVersion();

const STATUS_KEYS = new Set([
  "ready", "pid", "state", "restartAttempt", "enabled", "connected",
  "totalProfiles", "connectedProfiles", "activeRuns", "maxConcurrentRuns",
  "profile", "connectionState", "connectionReason", "actionRequired", "draining", "runtimeId",
  "lastRecoveryDurationMs", "lastRecoveryTrigger",
  "acceptingRuns", "runtimeVersion", "protocolVersion", "lastAckedCommandSeq",
  "outboxPendingBytes", "outboxPending", "outboxOldestAgeMs", "dbBytes",
  "walBytes", "storeHealth", "channelContext", "acceptingNewRuns", "freeBytes",
  "minimumFreeBytes", "errorCode", "store", "projection", "providerPersistence",
  "scopes", "messages", "snapshots", "activeSnapshots", "serializerVersion",
  "retentionMs", "snapshotRetentionMs", "activeSnapshotTimeoutMs", "runtimes",
  "adapters", "adapterHost", "agentWork", "lifecycle", "admittingRuns"
]);

const RECORD_KEYS = new Set([
  "ts", "level", "component", "scope", "event", "request_id", "profile",
  "runtime_id", "run_id", "agent_session_id", "invocation_id", "adapter_type",
  "duration_ms", "seq", "data"
]);

const DATA_KEYS = new Set([
  "connection_id", "reconnect_attempt", "status", "state",
  "reason_code", "error_code", "code", "timeout_stage", "timeout_ms",
  "duration_ms", "server_seq", "ack", "seq", "prior_status",
  "authoritative_status", "consecutive_failures", "http_status", "exit_code",
  "signal", "method", "request_id", "affected_source", "count", "stage",
  "outcome", "retry_after_ms", "pending", "pending_bytes", "oldest_age_ms"
]);

export interface DiagnosticBundle {
  schema: "octo-harness.diagnostic-bundle/v1";
  dataClass: "metadata_only";
  generatedAt: string;
  versions: {
    harness: string;
    node: string;
  };
  status: Record<string, unknown>;
  timeline: Array<Record<string, unknown>>;
  exclusions: readonly string[];
}

/**
 * Assemble a support artifact from explicit metadata allowlists. New status or
 * log fields stay excluded until reviewed, even when an upstream redactor would
 * otherwise consider them safe.
 */
export function createDiagnosticBundle(
  status: unknown,
  records: unknown,
  now: Date = new Date()
): DiagnosticBundle {
  return {
    schema: "octo-harness.diagnostic-bundle/v1",
    dataClass: "metadata_only",
    generatedAt: now.toISOString(),
    versions: {
      harness: PACKAGE_VERSION,
      node: process.versions.node
    },
    status: sanitizeRecord(status, STATUS_KEYS),
    timeline: Array.isArray(records)
      ? records.slice(-MAX_TIMELINE_RECORDS).map(record => sanitizeTimelineRecord(record))
      : [],
    exclusions: [
      "credentials_and_tokens",
      "prompts_and_model_output",
      "tool_inputs_and_outputs",
      "provider_io",
      "outbox_payloads",
      "filesystem_paths"
    ]
  };
}

function sanitizeTimelineRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const record: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!RECORD_KEYS.has(key)) continue;
    const sanitized = key === "data"
      ? sanitizeRecord(item, DATA_KEYS)
      : sanitizeValue(item, RECORD_KEYS);
    if (sanitized !== undefined) record[key] = sanitized;
  }
  return record;
}

function sanitizeRecord(value: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) continue;
    const sanitized = sanitizeValue(item, allowed);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function sanitizeValue(value: unknown, allowed: ReadonlySet<string>): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, MAX_STRING_LENGTH);
  if (Array.isArray(value)) return value.slice(0, MAX_TIMELINE_RECORDS).map(item => {
    if (isRecord(item)) return sanitizeRecord(item, allowed);
    return sanitizeValue(item, allowed);
  }).filter(item => item !== undefined);
  if (isRecord(value)) return sanitizeRecord(value, allowed);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function packageVersion(): string {
  const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  if (typeof metadata.version !== "string" || !metadata.version.trim()) {
    throw new Error("Octo Harness package version is missing");
  }
  return metadata.version;
}

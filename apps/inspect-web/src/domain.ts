export const EVENT_SOURCES = [
  "daemon",
  "provider-native",
  "provider-activity",
  "adapter-canonical",
  "host-canonical",
  "adapter-rpc",
  "runtime",
  "worker",
  "control"
] as const;

export const SOURCE_LABELS: Record<string, string> = {
  daemon: "守护进程",
  "provider-native": "Provider 原生",
  "provider-activity": "Provider 活性",
  "adapter-canonical": "Adapter 规范化",
  "host-canonical": "Host 校验后",
  "adapter-rpc": "适配器 RPC",
  runtime: "运行时内部",
  worker: "Worker 通道",
  control: "诊断控制"
};

export interface InspectRecord {
  key: string;
  durable: boolean;
  source: string;
  stage: string;
  direction: string;
  type: string;
  profile: string;
  runtimeId: string;
  sessionId: string;
  runId: string;
  invocationId: string;
  adapterType: string;
  durationMs?: number;
  status: "ok" | "warning" | "error";
  localSeq?: number;
  occurredAt: string;
  summary: string;
  bytes: number;
  value: Record<string, unknown>;
}

export interface RunSummary {
  id: string;
  profile: string;
  type: string;
  occurredAt: string;
}

export type ConnectionState = "connecting" | "live" | "paused" | "disconnected" | "auth-required";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeEvent(value: Record<string, unknown>, raw: string): InspectRecord {
  const payload = isRecord(value.payload) ? value.payload : {};
  const data = isRecord(payload.data) ? payload.data : {};
  const localSeq = typeof value.local_seq === "number" ? value.local_seq : undefined;
  const type = stringValue(value.type) || "unknown";
  const summary = textSummary(payload, raw);
  return {
    key: localSeq === undefined ? crypto.randomUUID() : `event:${localSeq}`,
    durable: false,
    source: stringValue(value.source) || "unknown",
    stage: stringValue(value.stage) || stringValue(value.source) || "unknown",
    direction: normalizeDirection(stringValue(value.direction) || stringValue(data.direction)),
    type,
    profile: stringValue(value.profile),
    runtimeId: stringValue(value.runtime_id),
    sessionId: firstString(value.agent_session_id, value.session_id, payload.agent_session_id, payload.session_id, data.agent_session_id, data.session_id),
    runId: stringValue(value.agent_run_id),
    invocationId: firstString(value.invocation_id, payload.invocation_id, data.invocation_id),
    adapterType: stringValue(value.adapter_type),
    durationMs: firstNumber(value.duration_ms, payload.duration_ms, data.duration_ms),
    status: recordStatus(type, payload, summary),
    localSeq,
    occurredAt: stringValue(value.occurred_at),
    summary,
    bytes: raw.length * 2,
    value
  };
}

export function normalizeLog(value: Record<string, unknown>, index: number): InspectRecord {
  const data = isRecord(value.data) ? value.data : {};
  const raw = JSON.stringify(value);
  const type = stringValue(value.event) || "unknown";
  const summary = textSummary(data, raw);
  return {
    key: `log:${stringValue(value.ts)}:${index}`,
    durable: true,
    source: stringValue(value.component) || "log",
    stage: stringValue(value.scope) || stringValue(value.component) || "log",
    direction: normalizeDirection(stringValue(data.direction)),
    type,
    profile: stringValue(value.profile) || stringValue(data.profile),
    runtimeId: stringValue(value.runtime_id) || stringValue(data.runtime_id),
    sessionId: firstString(value.agent_session_id, data.agent_session_id, data.session_id),
    runId: stringValue(value.run_id),
    invocationId: firstString(value.invocation_id, data.invocation_id),
    adapterType: stringValue(value.adapter_type) || stringValue(data.adapter_type),
    durationMs: firstNumber(value.duration_ms, data.duration_ms),
    status: recordStatus(type, value, summary),
    occurredAt: stringValue(value.ts),
    summary,
    bytes: raw.length * 2,
    value
  };
}

function textSummary(value: Record<string, unknown>, fallback: string): string {
  for (const key of ["message", "text", "delta", "command", "name"]) {
    const item = value[key];
    if (typeof item === "string") return item.replace(/\s+/g, " ").slice(0, 240);
  }
  return fallback.replace(/\s+/g, " ").slice(0, 240);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function normalizeDirection(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === "outbound" || normalized === "provider_to_agent" || normalized === "host_to_daemon") return "outbound";
  if (normalized === "inbound" || normalized === "agent_to_provider" || normalized === "daemon_to_host") return "inbound";
  return value;
}

function recordStatus(type: string, payload: Record<string, unknown>, summary: string): "ok" | "warning" | "error" {
  const data = isRecord(payload.data) ? payload.data : {};
  const evidence = [
    type,
    stringValue(payload.level),
    stringValue(payload.status),
    stringValue(data.level),
    stringValue(data.status),
    summary
  ].join(" ").toLowerCase();
  if (/\b(error|fatal|failed|failure|unexpected|panic|sigpipe|oom|crash)\b|\.failed\b|_failed\b/.test(evidence)) {
    return "error";
  }
  if (/\b(warn|warning|degraded|retry|dropped|gap|timeout)\b|\.warning\b/.test(evidence)) {
    return "warning";
  }
  return "ok";
}

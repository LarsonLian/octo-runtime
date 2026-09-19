/** Severity threshold used by the local operational log. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/** Provider-boundary capture policy. */
export type ProviderIoCapture = "off" | "input" | "full";

/** Restricted records require explicit opt-in when read from durable logs.
 * A caller-injected process-local event sink is a separate diagnostic boundary. */
export type LogSensitivity = "operational" | "restricted";

export interface ObservabilityConfiguration {
  directory: string;
  logLevel: LogLevel;
  fileLog: boolean;
  verbose: boolean;
  traceRpc: boolean;
  captureProviderIo: ProviderIoCapture;
  requireProviderCapture: boolean;
  retentionDays: number;
  traceRetentionDays: number;
  crashRetentionDays: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface ObservabilityOptions extends ObservabilityConfiguration {
  component: string;
}

export interface LogInput {
  level: LogLevel;
  scope: string;
  event: string;
  message: string;
  data?: Record<string, unknown>;
  requestId?: string;
  profile?: string;
  runtimeId?: string;
  runId?: string;
  invocationId?: string;
  agentSessionId?: string;
  adapterType?: string;
  durationMs?: number;
}

export interface ProviderCarrierBytes {
  kind: "bytes";
  content: string | Uint8Array;
}

export interface ProviderCarrierJson {
  kind: "json_params";
  content: unknown;
}

export type ProviderCarrier = ProviderCarrierBytes | ProviderCarrierJson;

/** Ordered evidence emitted at the local provider boundary. */
export interface ProviderObservation {
  event:
    | "provider.input"
    | "provider.dispatch.written"
    | "provider.dispatch.acknowledged"
    | "provider.output.first"
    | "provider.output"
    | "provider.dispatch.failed";
  rpcMethod?: string;
  providerSessionId?: string;
  providerRequestId?: string;
  carrier?: ProviderCarrier;
  data?: Record<string, unknown>;
}

export interface AdapterInvocationContext {
  observe(observation: ProviderObservation): Promise<CaptureReceipt>;
  /** Synchronous control path; independent of lossy observation/log transport. */
  reportActivity?(activity: ProviderActivity): void;
}

export interface ProviderActivity {
  kind: "turn_started" | "turn_progress" | "transport_response" | "retry_notice";
  method: "turn_start" | "text_delta" | "tool_delta" | "item_lifecycle" | "usage" | "rpc_response" | "retry";
  toolCallId?: string;
}

export interface ObservationIdentity {
  profile?: string;
  runtimeId?: string;
  runId: string;
  invocationId: string;
  agentSessionId: string;
  adapterType: string;
}

export interface CaptureReceipt {
  captureId: string;
  state: "disabled" | "accepted" | "durable";
  complete: boolean;
  sha256?: string;
  byteLength?: number;
}

export interface ObservabilityStatus {
  directory: string;
  fileLog: boolean;
  logLevel: LogLevel;
  verbose: boolean;
  traceRpc: boolean;
  captureProviderIo: ProviderIoCapture;
  degraded: boolean;
  degradedReason?: string;
  droppedRecords: number;
}

export interface QueryLogOptions {
  requestId?: string;
  runId?: string;
  invocationId?: string;
  includeSensitive?: boolean;
  limit?: number;
  maxBytes?: number;
}

export interface StoredLogRecord extends Record<string, unknown> {
  ts: string;
  event: string;
}

export interface RecordEnvelope extends Record<string, unknown> {
  schema_version: 1;
  ts: string;
  level: LogLevel;
  component: string;
  scope: string;
  event: string;
  message: string;
  pid: number;
  process_instance_id: string;
  seq: number;
  sensitivity: LogSensitivity;
  request_id?: string;
  profile?: string;
  runtime_id?: string;
  run_id?: string;
  agent_session_id?: string;
  invocation_id?: string;
  adapter_type?: string;
  duration_ms?: number;
}

export interface ActiveFile {
  day: string;
  shard: number;
  path: string;
  size: number;
}

export interface RetainedFile {
  path: string;
  size: number;
  category: "evaluation" | "operational" | "crash";
  day?: string;
  oldestTs?: string;
}

export type SecureAppender = (path: string, line: string, durable: boolean) => Promise<void>;

/** Test seams are intentionally narrow and do not alter production policy. */
export interface WriterDependencies {
  now?: () => Date;
  stderr?: (line: string) => void;
  append?: SecureAppender;
  /** Receives credential-redacted operational records for an optional UI sink. */
  operationalSink?: (record: RecordEnvelope) => void;
  /** Receives every credential/redaction-safe record for a bounded live stream. */
  eventSink?: (record: RecordEnvelope) => void;
  maintenanceIntervalMs?: number;
}

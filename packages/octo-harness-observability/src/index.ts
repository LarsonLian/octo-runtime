import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  unlink
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

/** Severity threshold used by the local operational log. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/**
 * Controls capture at the provider boundary. `input` records only the final
 * provider-visible request; `full` also records dispatch and response milestones.
 */
export type ProviderIoCapture = "off" | "input" | "full";

/**
 * Storage class for a record. Restricted records are excluded from normal
 * queries because they may contain prompts or complete protocol frames.
 */
export type LogSensitivity = "operational" | "restricted";

/**
 * Process-independent logging policy shared by the daemon and adapter host.
 *
 * Retention values are expressed in local calendar days. Size values are byte
 * limits. Enabling `requireProviderCapture` changes provider-input capture from
 * best effort to fail closed: an invocation must not be dispatched until its
 * input record and directory metadata have been synchronized to disk.
 */
export interface ObservabilityConfiguration {
  /** Absolute or relative root under which the daily log directories are stored. */
  directory: string;
  logLevel: LogLevel;
  fileLog: boolean;
  /** Convenience mode resolved by the CLI into debug, RPC, and full provider capture. */
  verbose: boolean;
  traceRpc: boolean;
  captureProviderIo: ProviderIoCapture;
  requireProviderCapture: boolean;
  /** Retention for operational logs. */
  retentionDays: number;
  /** Shorter retention for restricted RPC and provider-I/O logs. */
  traceRetentionDays: number;
  crashRetentionDays: number;
  /** Per-sink shard target; a single oversized record is never split. */
  maxFileBytes: number;
  /** Aggregate limit across all files under `directory`. */
  maxTotalBytes: number;
}

/** Configuration for one writer process. */
export interface ObservabilityOptions extends ObservabilityConfiguration {
  /** Stable, filesystem-safe component name used for operational log files. */
  component: string;
}

/** A single operational event supplied by daemon or adapter-host code. */
export interface LogInput {
  level: LogLevel;
  scope: string;
  event: string;
  message: string;
  data?: Record<string, unknown>;
  runId?: string;
  invocationId?: string;
  sessionId?: string;
  adapterType?: string;
}

export interface ProviderCarrierBytes {
  kind: "bytes";
  /** Exact bytes, or a string encoded as UTF-8, sent through the provider transport. */
  content: string | Uint8Array;
}

export interface ProviderCarrierJson {
  kind: "json_params";
  /** Final structured parameters after adapter-side defaults and transformations. */
  content: unknown;
}

/**
 * Provider-visible input captured at the last boundary before transport. Its
 * stored projection may redact credentials according to the logging policy.
 */
export type ProviderCarrier = ProviderCarrierBytes | ProviderCarrierJson;

/**
 * A milestone in one provider dispatch. Adapters should report `provider.input`
 * immediately before writing and use the same provider identifiers for later
 * milestones so that viewers can reconstruct the dispatch timeline.
 */
export interface ProviderObservation {
  event:
    | "provider.input"
    | "provider.dispatch.written"
    | "provider.dispatch.acknowledged"
    | "provider.output.first"
    | "provider.dispatch.failed";
  rpcMethod?: string;
  providerSessionId?: string;
  providerRequestId?: string;
  carrier?: ProviderCarrier;
  data?: Record<string, unknown>;
}

/** Invocation-scoped capture hook exposed to adapter implementations. */
export interface AdapterInvocationContext {
  observe(observation: ProviderObservation): Promise<CaptureReceipt>;
}

/** Correlation fields that join provider records to daemon and adapter activity. */
export interface ObservationIdentity {
  runId: string;
  invocationId: string;
  sessionId: string;
  adapterType: string;
}

/**
 * Result of accepting a provider observation.
 *
 * `accepted` means queued for best-effort persistence, while `durable` means the
 * strict input record has been fsynced before this promise resolved. `complete`
 * is false when capture is disabled or the record was rejected by backpressure.
 */
export interface CaptureReceipt {
  captureId: string;
  state: "disabled" | "accepted" | "durable";
  complete: boolean;
  sha256?: string;
  byteLength?: number;
}

/** Snapshot suitable for daemon status output. Degradation is sticky per writer. */
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

/** Filters applied while scanning local JSONL logs. */
export interface QueryLogOptions {
  runId?: string;
  invocationId?: string;
  /** Restricted evaluation records are omitted unless explicitly requested. */
  includeSensitive?: boolean;
  limit?: number;
}

/** Versioned JSONL record with event-specific fields retained as unknown values. */
export interface StoredLogRecord extends Record<string, unknown> {
  ts: string;
  event: string;
}

interface WriterDependencies {
  now?: () => Date;
  stderr?: (line: string) => void;
}

interface RecordEnvelope extends Record<string, unknown> {
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
}

interface ActiveFile {
  day: string;
  shard: number;
  path: string;
  size: number;
}

interface RetainedFile {
  path: string;
  size: number;
  category: "evaluation" | "operational" | "crash";
  day?: string;
}

const LEVELS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50
};
const DATE_DIRECTORY = /^\d{4}-\d{2}-\d{2}$/;
// Debug and trace traffic yields first, preserving headroom for operational records.
const WRITER_QUEUE_SOFT_LIMIT = 4096;
const WRITER_QUEUE_HARD_LIMIT = 4608;
const CREDENTIAL_EXACT = new Set(["authorization", "proxyauthorization", "cookie", "setcookie"]);
const CREDENTIAL_SUFFIXES = [
  "token",
  "password",
  "passwd",
  "secret",
  "apikey",
  "privatekey",
  "accesskey",
  "credential"
];

/** Default policy for local logging when no CLI flag or environment override is present. */
export const DEFAULT_OBSERVABILITY_CONFIGURATION: Omit<ObservabilityConfiguration, "directory"> = {
  logLevel: "info",
  fileLog: true,
  verbose: false,
  traceRpc: false,
  captureProviderIo: "off",
  requireProviderCapture: false,
  retentionDays: 14,
  traceRetentionDays: 3,
  crashRetentionDays: 30,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024
};

/**
 * Append-only local observability writer used by each harness process.
 *
 * Writes are serialized through one promise chain so record order matches the
 * process-local sequence number. Operational data and restricted evaluation data
 * use separate files and retention policies. Security checks are repeated at the
 * point of use rather than relying solely on directory setup performed at startup.
 */
export class LocalObservability {
  readonly #options: ObservabilityOptions;
  readonly #now: () => Date;
  readonly #stderr: (line: string) => void;
  readonly #processInstanceId = `proc_${randomUUID()}`;
  readonly #files = new Map<string, ActiveFile>();
  readonly #rpcRequests = new Map<string, RpcCorrelation>();
  readonly #rpcInvocations = new Map<string, RpcCorrelation>();
  #tail: Promise<void> = Promise.resolve();
  #seq = 0;
  #closed = false;
  #lastCleanupDay?: string;
  #degradedReason?: string;
  #droppedRecords = 0;
  #pendingWrites = 0;

  constructor(options: ObservabilityOptions, dependencies: WriterDependencies = {}) {
    this.#options = { ...options, directory: resolve(options.directory) };
    this.#now = dependencies.now ?? (() => new Date());
    this.#stderr = dependencies.stderr ?? (line => process.stderr.write(`${line}\n`));
    if (!/^[a-z0-9-]+$/.test(options.component)) {
      throw new TypeError("observability component must contain only lowercase letters, digits, and hyphens");
    }
  }

  /** Returns a side-effect-free snapshot; it never probes or creates the log path. */
  get status(): ObservabilityStatus {
    return {
      directory: this.#options.directory,
      fileLog: this.#options.fileLog,
      logLevel: this.#options.logLevel,
      verbose: this.#options.verbose,
      traceRpc: this.#options.traceRpc,
      captureProviderIo: this.#options.captureProviderIo,
      degraded: this.#degradedReason !== undefined,
      ...(this.#degradedReason ? { degradedReason: this.#degradedReason } : {}),
      droppedRecords: this.#droppedRecords
    };
  }

  /**
   * Enqueues an operational record without blocking the caller. Debug and trace
   * records are discardable at the soft queue limit; all levels are rejected at
   * the hard limit so logging cannot create unbounded process memory pressure.
   */
  log(input: LogInput): void {
    if (!this.#options.fileLog || LEVELS[input.level] < LEVELS[this.#options.logLevel]) return;
    const record = this.#record(input, "operational");
    this.#schedule(
      () => this.#write(record, "operational", false),
      input.level === "trace" || input.level === "debug"
    );
  }

  /**
   * Captures a raw adapter-host RPC frame in restricted storage. Malformed frames
   * are represented by size and digest only. Private reasoning bodies are removed
   * even from restricted traces; correlation metadata remains available.
   */
  traceRpc(direction: "send" | "receive", frame: string): void {
    if (!this.#options.fileLog || !this.#options.traceRpc) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame) as unknown;
    } catch {
      parsed = {
        unparseable: true,
        byte_length: Buffer.byteLength(frame),
        sha256: sha256(Buffer.from(frame))
      };
    }
    const correlation = this.#correlateRpc(direction, parsed);
    const safeFrame = redactPrivateReasoning(redactCredentials(parsed));
    const record = this.#record({
      level: "trace",
      scope: "adapter-host.rpc",
      event: "rpc.frame",
      message: `adapter-host RPC ${direction}`,
      runId: correlation.runId,
      invocationId: correlation.invocationId,
      sessionId: correlation.sessionId,
      adapterType: correlation.adapterType,
      data: {
        direction,
        ...(correlation.rpcMethod ? { rpc_method: correlation.rpcMethod } : {}),
        ...(correlation.rpcId ? { rpc_id: correlation.rpcId } : {}),
        frame: safeFrame
      }
    }, "restricted");
    this.#schedule(() => this.#write(record, "rpc", false), true);
  }

  /**
   * Records a provider-boundary observation and returns its persistence contract.
   *
   * Strict mode applies only to provider input. It bypasses discardable scheduling
   * and awaits file plus directory synchronization. Any failure is surfaced as
   * `trace_capture_failed`, allowing the adapter to abort before provider dispatch.
   */
  async observeProvider(identity: ObservationIdentity, observation: ProviderObservation): Promise<CaptureReceipt> {
    const captureId = `cap_${randomUUID()}`;
    const isInput = observation.event === "provider.input";
    const enabled = this.#options.fileLog && (
      (isInput && this.#options.captureProviderIo !== "off")
      || (!isInput && this.#options.captureProviderIo === "full")
    );
    if (!enabled) return { captureId, state: "disabled", complete: false };
    if (this.#closed) throw traceCaptureError("writer_closed");
    if (this.#degradedReason === "current_day_over_cap") {
      if (this.#options.requireProviderCapture && isInput) throw traceCaptureError("current_day_over_cap");
      this.#droppedRecords += 1;
      return { captureId, state: "accepted", complete: false };
    }

    const projection = observation.carrier ? projectCarrier(observation.carrier) : undefined;
    const record = this.#record({
      level: "trace",
      scope: "provider.io",
      event: observation.event,
      message: providerObservationMessage(observation.event),
      runId: identity.runId,
      invocationId: identity.invocationId,
      sessionId: identity.sessionId,
      adapterType: identity.adapterType,
      data: {
        capture_id: captureId,
        precision: "provider_cli_visible",
        ...(observation.rpcMethod ? { rpc_method: observation.rpcMethod } : {}),
        ...(observation.providerSessionId ? { provider_session_id: observation.providerSessionId } : {}),
        ...(observation.providerRequestId ? { provider_request_id: observation.providerRequestId } : {}),
        ...(projection ? { projection } : {}),
        ...redactRecord(observation.data ?? {})
      }
    }, "restricted");

    const receipt: CaptureReceipt = {
      captureId,
      state: this.#options.requireProviderCapture && isInput ? "durable" : "accepted",
      complete: true,
      ...(projection ? { sha256: projection.sha256, byteLength: projection.byte_length } : {})
    };
    if (this.#options.requireProviderCapture && isInput) {
      try {
        await this.#enqueueCounted(async () => {
          await this.#write(record, "provider-io", true);
          await this.#write(this.#captureReceipt(identity, captureId, "persisted"), "provider-io", true);
        });
      } catch (error) {
        this.#degrade(error);
        throw traceCaptureError(errorCode(error));
      }
      return receipt;
    }
    const scheduled = this.#schedule(async () => {
      await this.#write(record, "provider-io", false);
      await this.#write(this.#captureReceipt(identity, captureId, "persisted"), "provider-io", false);
    }, true);
    return scheduled ? receipt : { ...receipt, complete: false };
  }

  /**
   * Reads the newest matching records from all retained shards.
   *
   * The local writer is flushed first, but other processes may still be appending.
   * A partial trailing JSONL line is therefore ignored and becomes visible on a
   * later query. Restricted files require an explicit opt-in.
   */
  async query(options: QueryLogOptions = {}): Promise<StoredLogRecord[]> {
    if (!this.#options.fileLog) return [];
    await this.flush();
    const requestedLimit = options.limit ?? 500;
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 5000)
      : 500;
    const files = (await collectLogFiles(this.#options.directory))
      .filter(file => options.includeSensitive === true || file.category !== "evaluation")
      .sort((left, right) => left.path.localeCompare(right.path));
    const records: StoredLogRecord[] = [];
    for (const file of files) {
      const content = await readFile(file.path, "utf8").catch(() => "");
      for (const line of content.split(/\r?\n/)) {
        if (!line) continue;
        try {
          const value = JSON.parse(line) as StoredLogRecord;
          if (options.runId && value.run_id !== options.runId) continue;
          if (options.invocationId && value.invocation_id !== options.invocationId) continue;
          records.push(value);
          if (records.length > limit) records.shift();
        } catch {
          // A concurrently appended trailing line is ignored until the next refresh.
        }
      }
    }
    return records.sort((left, right) => left.ts.localeCompare(right.ts));
  }

  /**
   * Applies calendar-day retention followed by the aggregate capacity policy.
   * Symlinks are never traversed. Evaluation files expire independently from
   * operational files even though both live below the same daily directory.
   */
  async cleanup(): Promise<void> {
    if (!this.#options.fileLog) return;
    const currentDay = localDay(this.#now());
    await ensureSecureDirectory(this.#options.directory);
    const entries = await readdir(this.#options.directory, { withFileTypes: true });
    const operationalCutoff = retentionCutoff(this.#now(), this.#options.retentionDays);
    const evaluationCutoff = retentionCutoff(this.#now(), this.#options.traceRetentionDays);
    const crashCutoff = retentionCutoff(this.#now(), this.#options.crashRetentionDays);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(this.#options.directory, entry.name);
      if (entry.isDirectory() && DATE_DIRECTORY.test(entry.name)) {
        if (entry.name < evaluationCutoff) await rm(join(path, "evaluation"), { recursive: true, force: true });
        if (entry.name < operationalCutoff) {
          for (const child of await readdir(path, { withFileTypes: true }).catch(() => [])) {
            if (child.isFile()) await unlink(join(path, child.name)).catch(() => undefined);
          }
          await removeIfEmpty(path);
        }
      }
      if (entry.isDirectory() && entry.name === "crash") {
        for (const child of await readdir(path, { withFileTypes: true }).catch(() => [])) {
          const day = crashDay(child.name);
          if (child.isFile() && day && day < crashCutoff) await unlink(join(path, child.name)).catch(() => undefined);
        }
      }
    }
    await this.#enforceCapacity(currentDay);
  }

  /** Waits for all operations accepted by this writer before the call. */
  async flush(): Promise<void> {
    await this.#tail;
  }

  /** Rejects future scheduling and drains all already accepted operations. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.flush();
  }

  #record(input: LogInput, sensitivity: LogSensitivity): RecordEnvelope {
    return {
      schema_version: 1,
      ts: this.#now().toISOString(),
      level: input.level,
      component: this.#options.component,
      scope: input.scope,
      event: input.event,
      message: input.message,
      pid: process.pid,
      process_instance_id: this.#processInstanceId,
      seq: ++this.#seq,
      sensitivity,
      ...(input.runId ? { run_id: input.runId } : {}),
      ...(input.invocationId ? { invocation_id: input.invocationId } : {}),
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(input.adapterType ? { adapter_type: input.adapterType } : {}),
      ...(input.data ? { data: redactRecord(input.data) } : {})
    };
  }

  /**
   * Adds best-effort work without extending memory indefinitely. The boolean is
   * the acceptance receipt used by provider capture to report incomplete writes.
   */
  #schedule(operation: () => Promise<void>, discardable = false): boolean {
    if (this.#closed) {
      this.#droppedRecords += 1;
      return false;
    }
    if ((discardable && this.#pendingWrites >= WRITER_QUEUE_SOFT_LIMIT)
      || this.#pendingWrites >= WRITER_QUEUE_HARD_LIMIT) {
      this.#droppedRecords += 1;
      return false;
    }
    this.#pendingWrites += 1;
    void this.#enqueue(async () => {
      try {
        await operation();
      } finally {
        this.#pendingWrites -= 1;
      }
    }).catch(error => this.#degrade(error));
    return true;
  }

  /**
   * Serializes writes while keeping the shared tail usable after a failed task.
   * The returned promise still rejects so strict callers can fail closed.
   */
  #enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.#tail.then(operation);
    this.#tail = task.catch(() => undefined);
    return task;
  }

  /** Enqueues non-discardable strict work, rejecting instead of silently dropping it. */
  #enqueueCounted(operation: () => Promise<void>): Promise<void> {
    if (this.#pendingWrites >= WRITER_QUEUE_HARD_LIMIT) throw traceCaptureError("writer_queue_full");
    this.#pendingWrites += 1;
    return this.#enqueue(async () => {
      try {
        await operation();
      } finally {
        this.#pendingWrites -= 1;
      }
    });
  }

  /**
   * Appends to the sink's local-day shard and rotates a non-empty shard before an
   * append crosses the target size. A single record is never split. Durable writes
   * synchronize file contents and directory entries, including newly created
   * date/evaluation directories up to the configured root.
   */
  async #write(record: RecordEnvelope, sink: "operational" | "rpc" | "provider-io", durable: boolean): Promise<void> {
    const day = localDay(new Date(record.ts));
    const evaluation = sink !== "operational";
    const directory = evaluation
      ? join(this.#options.directory, day, "evaluation")
      : join(this.#options.directory, day);
    await ensureSecureDirectory(directory, this.#options.directory);
    const baseName = sink === "operational" ? this.#options.component : sink;
    const key = `${day}:${sink}`;
    let active = this.#files.get(key);
    if (!active) active = await resolveActiveFile(directory, baseName, day, this.#options.maxFileBytes);
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (active.size > 0 && active.size + bytes > this.#options.maxFileBytes) {
      active = {
        day,
        shard: active.shard + 1,
        path: shardPath(directory, baseName, active.shard + 1),
        size: 0
      };
    }
    await appendSecure(active.path, line, durable);
    if (durable) await syncDirectoryChain(directory, this.#options.directory);
    active.size += bytes;
    this.#files.set(key, active);
    if (this.#lastCleanupDay !== day) {
      this.#lastCleanupDay = day;
      await this.cleanup();
    }
  }

  /**
   * Reclaims non-current files, preferring restricted evaluation data and then
   * older paths within each category. Files in the current daily directory are
   * never deleted underneath active writers. If they alone exceed the cap, capture
   * degrades and subsequent strict provider input fails.
   */
  async #enforceCapacity(currentDay: string): Promise<void> {
    const files = await collectLogFiles(this.#options.directory);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    if (total <= this.#options.maxTotalBytes) return;
    const candidates = files
      .filter(file => file.day !== currentDay)
      .sort((left, right) => {
        const priority = categoryPriority(left.category) - categoryPriority(right.category);
        return priority || left.path.localeCompare(right.path);
      });
    for (const file of candidates) {
      await unlink(file.path).catch(() => undefined);
      total -= file.size;
      if (total <= this.#options.maxTotalBytes) return;
    }
    this.#degradedReason = "current_day_over_cap";
  }

  /**
   * Marks a sticky degraded state and emits single-line fallback metadata to stderr.
   * The failed record itself is not retried, avoiding a logging failure loop.
   */
  #degrade(error: unknown): void {
    this.#droppedRecords += 1;
    this.#degradedReason = errorCode(error);
    this.#stderr(`[octo-harness logging.degraded] component=${this.#options.component} reason=${this.#degradedReason} dropped=${this.#droppedRecords}`);
  }

  #captureReceipt(
    identity: ObservationIdentity,
    captureId: string,
    state: "persisted" | "failed"
  ): RecordEnvelope {
    return this.#record({
      level: state === "persisted" ? "trace" : "error",
      scope: "provider.io",
      event: "capture.receipt",
      message: `provider capture ${state}`,
      runId: identity.runId,
      invocationId: identity.invocationId,
      sessionId: identity.sessionId,
      adapterType: identity.adapterType,
      data: { capture_id: captureId, state, complete: state === "persisted" }
    }, "restricted");
  }

  /**
   * Carries invocation identity across request/response frames that expose only an
   * RPC id. Entries are retired on terminal response and `invoke.done` boundaries.
   */
  #correlateRpc(direction: "send" | "receive", value: unknown): RpcCorrelation {
    if (!isObjectRecord(value)) return {};
    const params = isObjectRecord(value.params) ? value.params : {};
    const request = isObjectRecord(params.request) ? params.request : {};
    const result = isObjectRecord(value.result) ? value.result : {};
    const rpcId = typeof value.id === "string" || typeof value.id === "number" ? String(value.id) : undefined;
    const invocationId = optionalStringValue(request.invocationId)
      ?? optionalStringValue(params.invocationId)
      ?? optionalStringValue(result.invocationId);
    let correlation: RpcCorrelation = {
      rpcId,
      rpcMethod: optionalStringValue(value.method),
      runId: optionalStringValue(request.runId) ?? optionalStringValue(params.runId),
      invocationId,
      sessionId: optionalStringValue(request.sessionId) ?? optionalStringValue(params.sessionId),
      adapterType: optionalStringValue(params.adapterType) ?? optionalStringValue(request.adapterType)
    };
    if (rpcId) correlation = mergeDefined(this.#rpcRequests.get(rpcId), correlation);
    if (invocationId) correlation = mergeDefined(this.#rpcInvocations.get(invocationId), correlation);
    if (direction === "send" && rpcId && value.method) this.#rpcRequests.set(rpcId, correlation);
    if (invocationId && (correlation.runId || correlation.sessionId || correlation.adapterType)) {
      this.#rpcInvocations.set(invocationId, correlation);
    }
    if (direction === "receive" && rpcId && ("result" in value || "error" in value)) {
      this.#rpcRequests.delete(rpcId);
    }
    if (value.method === "invoke.done" && invocationId) this.#rpcInvocations.delete(invocationId);
    return correlation;
  }
}

interface RpcCorrelation {
  rpcId?: string;
  rpcMethod?: string;
  runId?: string;
  invocationId?: string;
  sessionId?: string;
  adapterType?: string;
}

function mergeDefined(base: RpcCorrelation | undefined, override: RpcCorrelation): RpcCorrelation {
  return {
    rpcId: override.rpcId ?? base?.rpcId,
    rpcMethod: override.rpcMethod ?? base?.rpcMethod,
    runId: override.runId ?? base?.runId,
    invocationId: override.invocationId ?? base?.invocationId,
    sessionId: override.sessionId ?? base?.sessionId,
    adapterType: override.adapterType ?? base?.adapterType
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolves the child-process environment into a validated logging policy.
 * Verbose mode is intentionally atomic: it enables debug logs, RPC tracing, and
 * full provider I/O capture regardless of their individual environment values.
 */
export function observabilityConfigurationFromEnv(
  env: NodeJS.ProcessEnv,
  fallbackDirectory: string
): ObservabilityConfiguration {
  const verbose = env.OCTO_HARNESS_VERBOSE === "1";
  return {
    directory: resolve(env.OCTO_HARNESS_LOG_DIR ?? fallbackDirectory),
    logLevel: verbose ? "debug" : logLevel(env.OCTO_HARNESS_LOG_LEVEL ?? "info"),
    fileLog: env.OCTO_HARNESS_FILE_LOG !== "0",
    verbose,
    traceRpc: verbose || env.OCTO_HARNESS_TRACE_RPC === "1",
    captureProviderIo: verbose ? "full" : providerCapture(env.OCTO_HARNESS_CAPTURE_PROVIDER_IO ?? "off"),
    requireProviderCapture: env.OCTO_HARNESS_REQUIRE_PROVIDER_CAPTURE === "1",
    retentionDays: positiveInteger(env.OCTO_HARNESS_LOG_RETENTION_DAYS, 14),
    traceRetentionDays: positiveInteger(env.OCTO_HARNESS_TRACE_RETENTION_DAYS, 3),
    crashRetentionDays: positiveInteger(env.OCTO_HARNESS_CRASH_RETENTION_DAYS, 30),
    maxFileBytes: positiveInteger(env.OCTO_HARNESS_LOG_MAX_FILE_BYTES, 64 * 1024 * 1024),
    maxTotalBytes: positiveInteger(env.OCTO_HARNESS_LOG_MAX_TOTAL_BYTES, 1024 * 1024 * 1024)
  };
}

/** Serializes a resolved policy for daemon-to-adapter-host propagation. */
export function observabilityEnvironment(configuration: ObservabilityConfiguration): NodeJS.ProcessEnv {
  return {
    OCTO_HARNESS_LOG_DIR: configuration.directory,
    OCTO_HARNESS_LOG_LEVEL: configuration.logLevel,
    OCTO_HARNESS_FILE_LOG: configuration.fileLog ? "1" : "0",
    OCTO_HARNESS_VERBOSE: configuration.verbose ? "1" : "0",
    OCTO_HARNESS_TRACE_RPC: configuration.traceRpc ? "1" : "0",
    OCTO_HARNESS_CAPTURE_PROVIDER_IO: configuration.captureProviderIo,
    OCTO_HARNESS_REQUIRE_PROVIDER_CAPTURE: configuration.requireProviderCapture ? "1" : "0",
    OCTO_HARNESS_LOG_RETENTION_DAYS: String(configuration.retentionDays),
    OCTO_HARNESS_TRACE_RETENTION_DAYS: String(configuration.traceRetentionDays),
    OCTO_HARNESS_CRASH_RETENTION_DAYS: String(configuration.crashRetentionDays),
    OCTO_HARNESS_LOG_MAX_FILE_BYTES: String(configuration.maxFileBytes),
    OCTO_HARNESS_LOG_MAX_TOTAL_BYTES: String(configuration.maxTotalBytes)
  };
}

/**
 * Returns a deep, log-safe projection without mutating the caller's value.
 *
 * Credential-shaped object keys, credential command-line arguments, and URL
 * userinfo/query parameters are redacted. Cycles are replaced with a marker so
 * arbitrary diagnostic objects cannot break JSON serialization.
 */
export function redactCredentials(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return redactCredentials(value) as Record<string, unknown>;
}

/** Recursive redaction dispatcher; `parentKey` supplies container semantics. */
function redactValue(value: unknown, seen: WeakSet<object>, parentKey?: string): unknown {
  if (typeof value === "string") {
    if (parentKey && argvKey(parentKey)) return value;
    if (parentKey && urlKey(parentKey)) return redactUrl(value);
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Uint8Array) return { storage_encoding: "base64", content_b64: Buffer.from(value).toString("base64") };
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return parentKey && argvKey(parentKey)
      ? redactArgv(value)
      : value.map(item => redactValue(item, seen, parentKey));
  }
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    output[key] = credentialKey(key) ? "[redacted]" : redactValue(nested, seen, key);
  }
  return output;
}

function credentialKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return CREDENTIAL_EXACT.has(normalized)
    || CREDENTIAL_SUFFIXES.some(suffix => normalized.endsWith(suffix));
}

/** Normalization prevents case and common separator variations from bypassing matching. */
function normalizedKey(key: string): string {
  return key.normalize("NFKC").toLowerCase().replace(/[-_.]/g, "");
}

function argvKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return normalized === "args" || normalized === "argv" || normalized.endsWith("arguments");
}

function urlKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return normalized.endsWith("url") || normalized.endsWith("uri") || normalized.endsWith("endpoint");
}

/** Handles both `--secret=value` and `--secret value` command-line conventions. */
function redactArgv(values: unknown[]): unknown[] {
  const output: unknown[] = [];
  let redactNext = false;
  for (const value of values) {
    if (redactNext) {
      output.push("[redacted]");
      redactNext = false;
      continue;
    }
    if (typeof value !== "string") {
      output.push(redactValue(value, new WeakSet<object>()));
      continue;
    }
    const equals = /^(--?[^=]+)=(.*)$/s.exec(value);
    if (equals && credentialKey(equals[1])) {
      output.push(`${equals[1]}=[redacted]`);
      continue;
    }
    output.push(value);
    if (/^--?/.test(value) && credentialKey(value.replace(/^-+/, ""))) redactNext = true;
  }
  return output;
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = "[redacted]";
    if (url.password) url.password = "[redacted]";
    for (const key of [...url.searchParams.keys()]) {
      if (credentialKey(key)) url.searchParams.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return value;
  }
}

/**
 * Removes private reasoning bodies unconditionally. The envelope and payload
 * metadata remain available for ordering and protocol diagnostics.
 */
function redactPrivateReasoning(value: unknown): unknown {
  if (!isObjectRecord(value)) return value;
  const params = isObjectRecord(value.params) ? value.params : undefined;
  const event = params && isObjectRecord(params.event) ? params.event : undefined;
  const payload = event && isObjectRecord(event.payload) ? event.payload : undefined;
  if (!payload || payload.channel !== "analysis" || payload.exposure !== "private_reasoning") return value;
  const sanitizedPayload = { ...payload };
  for (const key of ["text", "delta", "content"]) delete sanitizedPayload[key];
  sanitizedPayload.body_omitted = true;
  return {
    ...value,
    params: {
      ...params,
      event: { ...event, payload: sanitizedPayload }
    }
  };
}

/**
 * Produces the stored carrier plus a digest of that stored projection.
 * Byte carriers remain byte-exact through base64. Structured carriers are first
 * redacted, then key-sorted to make hashes stable across object insertion order.
 */
function projectCarrier(carrier: ProviderCarrier): Record<string, unknown> & { sha256: string; byte_length: number } {
  if (carrier.kind === "bytes") {
    const bytes = typeof carrier.content === "string" ? Buffer.from(carrier.content) : Buffer.from(carrier.content);
    return {
      kind: "bytes",
      storage_encoding: "base64",
      content_b64: bytes.toString("base64"),
      sha256: sha256(bytes),
      byte_length: bytes.byteLength
    };
  }
  const content = redactCredentials(carrier.content);
  const bytes = Buffer.from(canonicalJson(content));
  return {
    kind: "json_params",
    encoding: "rfc8785-json",
    content,
    sha256: sha256(bytes),
    byte_length: bytes.byteLength
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

/** Recursively sorts object keys while preserving array order and scalar values. */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)])
    );
  }
  return value;
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function providerObservationMessage(event: ProviderObservation["event"]): string {
  switch (event) {
    case "provider.input": return "provider input captured";
    case "provider.dispatch.written": return "provider input written";
    case "provider.dispatch.acknowledged": return "provider acknowledged request";
    case "provider.output.first": return "provider emitted first output";
    case "provider.dispatch.failed": return "provider dispatch failed";
  }
}

/**
 * Finds the first shard that can accept more data. Existing paths must be regular
 * files; rejecting special files here preserves the append-only file invariant.
 */
async function resolveActiveFile(directory: string, base: string, day: string, maxBytes: number): Promise<ActiveFile> {
  let shard = 0;
  while (true) {
    const path = shardPath(directory, base, shard);
    try {
      const stats = await lstat(path);
      if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`unsafe log file: ${path}`);
      if (stats.size < maxBytes) return { day, shard, path, size: stats.size };
      shard += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { day, shard, path, size: 0 };
      throw error;
    }
  }
}

function shardPath(directory: string, base: string, shard: number): string {
  return join(directory, shard === 0 ? `${base}.jsonl` : `${base}.${String(shard).padStart(3, "0")}.jsonl`);
}

/**
 * Uses `O_NOFOLLOW` where supported, then validates ownership and type on the
 * opened descriptor. This closes the usual check/open symlink substitution window
 * for the final path on supported platforms. Files are forced to owner-only mode.
 */
async function appendSecure(path: string, line: string, durable: boolean): Promise<void> {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags, 0o600);
  try {
    const stats = await handle.stat();
    const uid = process.getuid?.();
    if (!stats.isFile() || (uid !== undefined && stats.uid !== uid)) throw new Error(`unsafe log file owner or type: ${path}`);
    await handle.chmod(0o600);
    await handle.writeFile(line, "utf8");
    if (durable) await handle.sync();
  } finally {
    await handle.close();
  }
  if (durable) await syncDirectory(dirname(path));
}

/**
 * Creates descendants one component at a time and validates the complete chain
 * from the configured log root. A symlink, foreign owner, non-directory, or path
 * escape fails closed before a log file is opened.
 */
async function ensureSecureDirectory(path: string, root = path): Promise<void> {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`log path escapes configured root: ${resolvedPath}`);
  }
  await ensureLogRoot(resolvedRoot);
  const relativePath = relative(resolvedRoot, resolvedPath);
  const paths = [resolvedRoot];
  if (relativePath) {
    let current = resolvedRoot;
    for (const part of relativePath.split(sep)) {
      current = join(current, part);
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      paths.push(current);
    }
  }
  const uid = process.getuid?.();
  for (const candidate of paths) {
    const stats = await lstat(candidate);
    if (stats.isSymbolicLink() || !stats.isDirectory() || (uid !== undefined && stats.uid !== uid)) {
      throw new Error(`unsafe log directory owner or type: ${candidate}`);
    }
    await chmod(candidate, 0o700);
  }
}

/** Validates an existing root before use, or creates a missing root owner-only. */
async function ensureLogRoot(root: string): Promise<void> {
  try {
    const existing = await lstat(root);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`unsafe log directory owner or type: ${root}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(root, { recursive: true, mode: 0o700 });
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Synchronizes directory entries from the leaf back to the configured root so a
 * strict receipt also covers shard and directory creation metadata.
 */
async function syncDirectoryChain(path: string, root: string): Promise<void> {
  let current = resolve(path);
  const resolvedRoot = resolve(root);
  while (true) {
    await syncDirectory(current);
    if (current === resolvedRoot) return;
    const parent = dirname(current);
    if (!current.startsWith(`${resolvedRoot}${sep}`) || parent === current) {
      throw new Error(`log path escapes configured root: ${current}`);
    }
    current = parent;
  }
}

/**
 * Walks only physical directories below the log root. Classification is derived
 * from layout rather than filenames and feeds both query visibility and retention.
 */
async function collectLogFiles(root: string): Promise<RetainedFile[]> {
  const results: RetainedFile[] = [];
  const visit = async (directory: string, inheritedDay?: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      const day = DATE_DIRECTORY.test(entry.name) ? entry.name : inheritedDay;
      if (entry.isDirectory()) {
        await visit(path, day);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const stats = await lstat(path);
      const rel = relative(root, path);
      const category = rel.split(sep).includes("evaluation")
        ? "evaluation"
        : rel.split(sep)[0] === "crash" ? "crash" : "operational";
      results.push({ path, size: stats.size, category, ...(day ? { day } : {}) });
    }
  };
  await visit(root);
  return results;
}

async function removeIfEmpty(path: string): Promise<void> {
  const entries = await readdir(path).catch(() => ["not-empty"]);
  if (entries.length === 0) await rm(path, { recursive: false, force: true });
}

/** Lower values are reclaimed first when aggregate capacity is exceeded. */
function categoryPriority(category: RetainedFile["category"]): number {
  return category === "evaluation" ? 0 : 1;
}

/** Returns an inclusive local-date cutoff suitable for lexical date comparison. */
function retentionCutoff(now: Date, days: number): string {
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  return localDay(cutoff);
}

function localDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function crashDay(name: string): string | undefined {
  const match = /(?:^|[-_])(\d{4})(\d{2})(\d{2})T/.exec(name);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

function logLevel(value: string): LogLevel {
  if (value === "trace" || value === "debug" || value === "info" || value === "warn" || value === "error") return value;
  throw new Error("OCTO_HARNESS_LOG_LEVEL must be one of: trace, debug, info, warn, error");
}

function providerCapture(value: string): ProviderIoCapture {
  if (value === "off" || value === "input" || value === "full") return value;
  throw new Error("OCTO_HARNESS_CAPTURE_PROVIDER_IO must be one of: off, input, full");
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`expected positive integer, received: ${value}`);
  return parsed;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "logging_error";
}

function traceCaptureError(reason: string): Error {
  return Object.assign(new Error(`provider trace capture failed: ${reason}`), {
    code: "trace_capture_failed"
  });
}

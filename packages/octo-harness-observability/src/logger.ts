import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  appendSecure,
  assertStrictStorageCapabilities,
  collectLogFiles,
  compareCapacityCandidates,
  DATE_DIRECTORY,
  ensureSecureDirectory,
  localDay,
  removeIfEmpty,
  removeLogFile,
  revalidateSecureDirectoryChain,
  resolveActiveFile,
  retentionCutoff,
  shardPath,
  syncDirectoryChain
} from "./storage.js";
import {
  projectCarrier,
  redactCredentialsWithMetadata,
  redactPrivateReasoning,
  sha256
} from "./redaction.js";
import type {
  ActiveFile,
  CaptureReceipt,
  LogInput,
  LogLevel,
  LogSensitivity,
  ObservationIdentity,
  ObservabilityOptions,
  ObservabilityStatus,
  ProviderObservation,
  QueryLogOptions,
  RecordEnvelope,
  SecureAppender,
  StoredLogRecord,
  WriterDependencies
} from "./types.js";

const LEVELS: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
const WRITER_QUEUE_SOFT_LIMIT = 4096;
const WRITER_QUEUE_HARD_LIMIT = 4608;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;
const CAPACITY_OPERATIONAL_RATE_LIMIT = 100;
const CAPACITY_OPERATIONAL_RATE_WINDOW_MS = 60 * 1000;

interface RpcCorrelation {
  rpcId?: string;
  rpcMethod?: string;
  runId?: string;
  invocationId?: string;
  agentSessionId?: string;
  adapterType?: string;
}

/** Append-only writer shared by daemon, launcher, and adapter-host processes. */
export class LocalObservability {
  readonly #options: ObservabilityOptions;
  readonly #now: () => Date;
  readonly #stderr: (line: string) => void;
  readonly #append: SecureAppender;
  readonly #operationalSink?: (record: RecordEnvelope) => void;
  readonly #eventSink?: (record: RecordEnvelope) => void;
  readonly #processInstanceId = `proc_${randomUUID()}`;
  readonly #files = new Map<string, ActiveFile>();
  readonly #rpcRequests = new Map<string, RpcCorrelation>();
  readonly #rpcInvocations = new Map<string, RpcCorrelation>();
  readonly #maintenanceTimer?: NodeJS.Timeout;
  #tail: Promise<void>;
  #seq = 0;
  #closed = false;
  #lastMaintenanceDay?: string;
  #maintenancePending = false;
  #capacityBlocked = false;
  #capacityRateWindowStartedAt?: number;
  #capacityRateWindowCount = 0;
  #degradedReason?: string;
  #droppedRecords = 0;
  #pendingWrites = 0;

  constructor(options: ObservabilityOptions, dependencies: WriterDependencies = {}) {
    validateOptions(options, dependencies);
    this.#options = { ...options, directory: resolve(options.directory) };
    this.#now = dependencies.now ?? (() => new Date());
    this.#stderr = dependencies.stderr ?? (line => process.stderr.write(`${line}\n`));
    this.#append = dependencies.append ?? appendSecure;
    this.#operationalSink = dependencies.operationalSink;
    this.#eventSink = dependencies.eventSink;
    if (options.requireProviderCapture) assertStrictStorageCapabilities();
    // Startup maintenance is part of the serialized writer chain, so the first
    // append cannot race retention or capacity deletion.
    this.#tail = this.#options.fileLog
      ? this.#runMaintenance().catch(error => this.#degrade(error))
      : Promise.resolve();
    const interval = dependencies.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
    if (this.#options.fileLog && interval > 0) {
      this.#maintenanceTimer = setInterval(() => this.#scheduleMaintenance(), interval);
      this.#maintenanceTimer.unref();
    }
  }

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

  /** Enqueue an operational record without blocking its caller. */
  log(input: LogInput): void {
    if (LEVELS[input.level] < LEVELS[this.#options.logLevel]) return;
    if (!this.#options.fileLog && !this.#operationalSink && !this.#eventSink) return;
    const record = this.#record(input, "operational");
    this.#operationalSink?.(record);
    this.#eventSink?.(record);
    if (!this.#options.fileLog) return;
    this.#schedule(
      async () => { await this.#write(record, "operational", false); },
      input.level === "trace" || input.level === "debug"
    );
  }

  /** Capture a credential-redacted daemon-to-host RPC frame. */
  traceRpc(direction: "send" | "receive", frame: string): void {
    const persist = this.#options.fileLog && this.#options.traceRpc;
    if (!persist && !this.#eventSink) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame) as unknown;
    } catch {
      parsed = { unparseable: true, byte_length: Buffer.byteLength(frame), sha256: sha256(Buffer.from(frame)) };
    }
    const correlation = this.#correlateRpc(direction, parsed);
    const redaction = redactCredentialsWithMetadata(parsed);
    const safeFrame = redactPrivateReasoning(redaction.value);
    const record = this.#record({
      level: "trace",
      scope: "adapter-host.rpc",
      event: "rpc.frame",
      message: `adapter-host RPC ${direction}`,
      runId: correlation.runId,
      invocationId: correlation.invocationId,
      agentSessionId: correlation.agentSessionId,
      adapterType: correlation.adapterType,
      data: {
        direction,
        ...(correlation.rpcMethod ? { rpc_method: correlation.rpcMethod } : {}),
        ...(correlation.rpcId ? { rpc_id: correlation.rpcId } : {}),
        frame: safeFrame,
        complete: redaction.complete,
        excluded_credential_paths: redaction.excludedCredentialPaths
      }
    }, "restricted");
    this.#eventSink?.(record);
    if (!persist) return;
    this.#schedule(async () => { await this.#write(record, "rpc", false); }, true);
  }

  /** Record one provider milestone under its trusted invocation identity. */
  async observeProvider(identity: ObservationIdentity, observation: ProviderObservation): Promise<CaptureReceipt> {
    const captureId = `cap_${randomUUID()}`;
    const isInput = observation.event === "provider.input";
    const enabled = this.#options.fileLog && (
      (isInput && this.#options.captureProviderIo !== "off")
      || (!isInput && this.#options.captureProviderIo === "full")
    );
    if (!enabled && !this.#eventSink) return { captureId, state: "disabled", complete: false };
    if (this.#closed) throw traceCaptureError("writer_closed");
    const projection = observation.carrier ? projectCarrier(observation.carrier) : undefined;
    const observationRedaction = redactCredentialsWithMetadata(observation.data ?? {});
    const safeObservationData = redactPrivateReasoning(observationRedaction.value) as Record<string, unknown>;
    const complete = (projection?.complete ?? true) && observationRedaction.complete;
    const record = this.#record({
      level: "trace",
      scope: "provider.io",
      event: observation.event,
      message: providerObservationMessage(observation.event),
      runId: identity.runId,
      invocationId: identity.invocationId,
      agentSessionId: identity.agentSessionId,
      adapterType: identity.adapterType,
      data: {
        ...safeObservationData,
        capture_id: captureId,
        precision: "provider_cli_visible",
        complete,
        ...(observationRedaction.excludedCredentialPaths.length > 0
          ? { excluded_credential_paths: observationRedaction.excludedCredentialPaths }
          : {}),
        ...(observation.rpcMethod ? { rpc_method: observation.rpcMethod } : {}),
        ...(observation.providerSessionId ? { provider_session_id: observation.providerSessionId } : {}),
        ...(observation.providerRequestId ? { provider_request_id: observation.providerRequestId } : {}),
        ...(projection ? { projection } : {})
      }
    }, "restricted");
    const receipt: CaptureReceipt = {
      captureId,
      state: this.#options.requireProviderCapture && isInput ? "durable" : "accepted",
      complete,
      ...(projection ? { sha256: projection.sha256, byteLength: projection.byte_length } : {})
    };
    this.#eventSink?.(record);
    if (!enabled) return { captureId, state: "disabled", complete };

    if (this.#options.requireProviderCapture && isInput) {
      try {
        await this.#enqueueCounted(async () => {
          if (this.#degradedReason && !this.#capacityBlocked) {
            throw Object.assign(new Error("observability storage is degraded"), { code: this.#degradedReason });
          }
          const persisted = await this.#write(record, "provider-io", true);
          if (!persisted) {
            throw Object.assign(new Error("current-day observability capacity is exhausted"), {
              code: "current_day_over_cap"
            });
          }
          await this.#write(
            this.#captureReceipt(identity, captureId, complete ? "persisted" : "failed", complete ? undefined : "incomplete_projection"),
            "provider-io",
            true,
            true
          );
          if (!complete) throw traceCaptureError("incomplete_projection");
        });
      } catch (error) {
        this.#degrade(error);
        throw traceCaptureError(errorCode(error));
      }
      return receipt;
    }

    const scheduled = this.#schedule(async () => {
      try {
        const persisted = await this.#write(record, "provider-io", false);
        if (!persisted) {
          await this.#attemptFailedReceipt(identity, captureId, "current_day_over_cap");
          return;
        }
        await this.#write(
          this.#captureReceipt(identity, captureId, complete ? "persisted" : "failed", complete ? undefined : "incomplete_projection"),
          "provider-io",
          false,
          true
        );
      } catch (error) {
        await this.#attemptFailedReceipt(identity, captureId, errorCode(error));
        throw error;
      }
    }, true);
    if (!scheduled) {
      this.#scheduleFailedReceipt(identity, captureId, "writer_queue_full");
      return { ...receipt, complete: false };
    }
    return receipt;
  }

  /** Read the newest matching records from every retained shard. */
  async query(options: QueryLogOptions = {}): Promise<StoredLogRecord[]> {
    if (!this.#options.fileLog) return [];
    try {
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
        let content: string;
        try {
          content = await readFile(file.path, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        for (const line of content.split(/\r?\n/)) {
          if (!line) continue;
          try {
            const value = JSON.parse(line) as StoredLogRecord;
            if (options.runId && value.run_id !== options.runId) continue;
            if (options.invocationId && value.invocation_id !== options.invocationId) continue;
            insertNewestRecord(records, value, limit);
          } catch {
            // A concurrently appended trailing line becomes visible on the next query.
          }
        }
      }
      return records;
    } catch (error) {
      this.#degrade(error);
      throw error;
    }
  }

  /** Run retention and capacity maintenance in writer order. */
  async cleanup(): Promise<void> {
    if (!this.#options.fileLog) return;
    try {
      await this.#enqueue(() => this.#runMaintenance());
    } catch (error) {
      this.#degrade(error);
      throw error;
    }
  }

  async flush(): Promise<void> {
    await this.#tail;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#maintenanceTimer) clearInterval(this.#maintenanceTimer);
    await this.flush();
  }

  #record(input: LogInput, sensitivity: LogSensitivity): RecordEnvelope {
    const data = input.data ? redactRecord(input.data) : undefined;
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
      ...(input.agentSessionId ? { agent_session_id: input.agentSessionId } : {}),
      ...(input.adapterType ? { adapter_type: input.adapterType } : {}),
      ...(data ? { data } : {})
    };
  }

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

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.#tail.then(operation);
    this.#tail = task.catch(() => undefined);
    return task;
  }

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

  async #write(
    record: RecordEnvelope,
    sink: "operational" | "rpc" | "provider-io",
    durable: boolean,
    bypassCapacity = false
  ): Promise<boolean> {
    const day = localDay(new Date(record.ts));
    if (this.#lastMaintenanceDay !== day) await this.#runMaintenance(day);
    if (!bypassCapacity && !this.#admitRecordAtCapacity(record, sink)) return false;
    const evaluation = sink !== "operational";
    const directory = evaluation
      ? join(this.#options.directory, day, "evaluation")
      : join(this.#options.directory, day);
    const directoryChain = await ensureSecureDirectory(directory, this.#options.directory);
    const baseName = sink === "operational" ? this.#options.component : sink;
    const key = `${day}:${sink}`;
    let active = this.#files.get(key);
    if (!active) active = await resolveActiveFile(directory, baseName, day, this.#options.maxFileBytes);
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    let rotated = false;
    if (active.size > 0 && active.size + bytes > this.#options.maxFileBytes) {
      active = { day, shard: active.shard + 1, path: shardPath(directory, baseName, active.shard + 1), size: 0 };
      rotated = true;
    }
    await this.#append(active.path, line, durable);
    if (durable) await syncDirectoryChain(directory, this.#options.directory);
    await revalidateSecureDirectoryChain(directoryChain);
    active.size += bytes;
    this.#files.set(key, active);
    if (rotated) await this.#runMaintenance(day);
    return true;
  }

  #scheduleMaintenance(): void {
    if (this.#closed || this.#maintenancePending) return;
    this.#maintenancePending = true;
    void this.#enqueue(() => this.#runMaintenance())
      .catch(error => this.#degrade(error))
      .finally(() => { this.#maintenancePending = false; });
  }

  async #runMaintenance(currentDay = localDay(this.#now())): Promise<void> {
    await ensureSecureDirectory(this.#options.directory);
    this.#lastMaintenanceDay = currentDay;
    const files = await collectLogFiles(this.#options.directory);
    const cutoffs = {
      operational: retentionCutoff(this.#now(), this.#options.retentionDays),
      evaluation: retentionCutoff(this.#now(), this.#options.traceRetentionDays),
      crash: retentionCutoff(this.#now(), this.#options.crashRetentionDays)
    };
    for (const file of files) {
      if (file.day && file.day < cutoffs[file.category]) await removeLogFile(file.path);
    }
    const entries = await readdir(this.#options.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !DATE_DIRECTORY.test(entry.name)) continue;
      const dayPath = join(this.#options.directory, entry.name);
      await removeIfEmpty(join(dayPath, "evaluation"));
      await removeIfEmpty(dayPath);
    }
    await this.#enforceCapacity(currentDay);
  }

  async #enforceCapacity(currentDay: string): Promise<void> {
    const files = await collectLogFiles(this.#options.directory);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    if (total <= this.#options.maxTotalBytes) {
      this.#capacityBlocked = false;
      this.#resetCapacityRateLimit();
      return;
    }
    const candidates = files
      .filter(file => file.day !== undefined && file.day !== currentDay)
      .sort(compareCapacityCandidates);
    for (const file of candidates) {
      await removeLogFile(file.path);
      total -= file.size;
      if (total <= this.#options.maxTotalBytes) {
        this.#capacityBlocked = false;
        this.#resetCapacityRateLimit();
        return;
      }
    }
    this.#capacityBlocked = true;
    this.#setDegraded("current_day_over_cap", false);
  }

  #admitRecordAtCapacity(record: RecordEnvelope, sink: "operational" | "rpc" | "provider-io"): boolean {
    if (!this.#capacityBlocked) return true;
    if (sink === "operational"
      && record.level !== "trace"
      && record.level !== "debug"
      && this.#admitCapacityOperationalRecord()) {
      return true;
    }
    this.#droppedRecords += 1;
    return false;
  }

  #admitCapacityOperationalRecord(): boolean {
    const now = this.#now().getTime();
    if (this.#capacityRateWindowStartedAt === undefined
      || now - this.#capacityRateWindowStartedAt >= CAPACITY_OPERATIONAL_RATE_WINDOW_MS
      || now < this.#capacityRateWindowStartedAt) {
      this.#capacityRateWindowStartedAt = now;
      this.#capacityRateWindowCount = 0;
    }
    if (this.#capacityRateWindowCount >= CAPACITY_OPERATIONAL_RATE_LIMIT) return false;
    this.#capacityRateWindowCount += 1;
    return true;
  }

  #resetCapacityRateLimit(): void {
    this.#capacityRateWindowStartedAt = undefined;
    this.#capacityRateWindowCount = 0;
  }

  #captureReceipt(
    identity: ObservationIdentity,
    captureId: string,
    state: "persisted" | "failed",
    reason?: string
  ): RecordEnvelope {
    return this.#record({
      level: state === "persisted" ? "trace" : "error",
      scope: "provider.io",
      event: "capture.receipt",
      message: `provider capture ${state}`,
      runId: identity.runId,
      invocationId: identity.invocationId,
      agentSessionId: identity.agentSessionId,
      adapterType: identity.adapterType,
      data: { capture_id: captureId, state, complete: state === "persisted", ...(reason ? { reason } : {}) }
    }, "restricted");
  }

  #scheduleFailedReceipt(identity: ObservationIdentity, captureId: string, reason: string): void {
    this.#schedule(() => this.#attemptFailedReceipt(identity, captureId, reason), false);
  }

  async #attemptFailedReceipt(identity: ObservationIdentity, captureId: string, reason: string): Promise<void> {
    try {
      await this.#write(this.#captureReceipt(identity, captureId, "failed", reason), "provider-io", false, true);
    } catch {
      // The original failure remains authoritative. This is a best-effort receipt
      // because the same sink may be unavailable (for example persistent EACCES).
    }
  }

  #degrade(error: unknown): void {
    this.#droppedRecords += 1;
    this.#setDegraded(errorCode(error), false);
  }

  #setDegraded(reason: string, alwaysReport: boolean): void {
    const changed = this.#degradedReason !== reason;
    this.#degradedReason = reason;
    if (alwaysReport || changed) {
      this.#stderr(`[octo-harness logging.degraded] component=${this.#options.component} reason=${reason} dropped=${this.#droppedRecords}`);
    }
  }

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
      agentSessionId: optionalStringValue(request.agentSessionId) ?? optionalStringValue(params.agentSessionId),
      adapterType: optionalStringValue(params.adapterType) ?? optionalStringValue(request.adapterType)
    };
    if (rpcId) correlation = mergeDefined(this.#rpcRequests.get(rpcId), correlation);
    if (invocationId) correlation = mergeDefined(this.#rpcInvocations.get(invocationId), correlation);
    if (direction === "send" && rpcId && value.method) this.#rpcRequests.set(rpcId, correlation);
    if (invocationId && (correlation.runId || correlation.agentSessionId || correlation.adapterType)) {
      this.#rpcInvocations.set(invocationId, correlation);
    }
    if (direction === "receive" && rpcId && ("result" in value || "error" in value)) this.#rpcRequests.delete(rpcId);
    if (value.method === "invoke.done" && invocationId) this.#rpcInvocations.delete(invocationId);
    return correlation;
  }
}

function validateOptions(options: ObservabilityOptions, dependencies: WriterDependencies): void {
  if (typeof options.directory !== "string" || options.directory.trim().length === 0) {
    throw new TypeError("observability directory must be a non-empty string");
  }
  if (!/^[a-z0-9-]+$/.test(options.component)) {
    throw new TypeError("observability component must contain only lowercase letters, digits, and hyphens");
  }
  if (typeof options.logLevel !== "string" || !Object.hasOwn(LEVELS, options.logLevel)) {
    throw new TypeError("observability logLevel is invalid");
  }
  if (options.captureProviderIo !== "off"
    && options.captureProviderIo !== "input"
    && options.captureProviderIo !== "full") {
    throw new TypeError("observability captureProviderIo is invalid");
  }
  for (const [name, value] of [
    ["fileLog", options.fileLog],
    ["verbose", options.verbose],
    ["traceRpc", options.traceRpc],
    ["requireProviderCapture", options.requireProviderCapture]
  ] as const) {
    if (typeof value !== "boolean") throw new TypeError(`observability ${name} must be a boolean`);
  }
  for (const [name, value] of [
    ["retentionDays", options.retentionDays],
    ["traceRetentionDays", options.traceRetentionDays],
    ["crashRetentionDays", options.crashRetentionDays],
    ["maxFileBytes", options.maxFileBytes],
    ["maxTotalBytes", options.maxTotalBytes]
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`observability ${name} must be a positive safe integer`);
    }
  }
  if (options.requireProviderCapture && !options.fileLog) {
    throw new TypeError("strict provider capture requires fileLog");
  }
  if (options.requireProviderCapture && options.captureProviderIo === "off") {
    throw new TypeError("strict provider capture requires provider input capture");
  }
  if (dependencies.maintenanceIntervalMs !== undefined
    && (!Number.isSafeInteger(dependencies.maintenanceIntervalMs) || dependencies.maintenanceIntervalMs < 0)) {
    throw new TypeError("observability maintenanceIntervalMs must be a non-negative safe integer");
  }
  for (const [name, value] of [
    ["now", dependencies.now],
    ["stderr", dependencies.stderr],
    ["append", dependencies.append],
    ["operationalSink", dependencies.operationalSink],
    ["eventSink", dependencies.eventSink]
  ] as const) {
    if (value !== undefined && typeof value !== "function") {
      throw new TypeError(`observability ${name} dependency must be a function`);
    }
  }
}

function insertNewestRecord(records: StoredLogRecord[], value: StoredLogRecord, limit: number): void {
  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareStoredRecords(records[middle], value) <= 0) low = middle + 1;
    else high = middle;
  }
  records.splice(low, 0, value);
  if (records.length > limit) records.shift();
}

function compareStoredRecords(left: StoredLogRecord, right: StoredLogRecord): number {
  const timestamp = left.ts.localeCompare(right.ts);
  if (timestamp) return timestamp;
  const leftProcessInstance = typeof left.process_instance_id === "string" ? left.process_instance_id : "";
  const rightProcessInstance = typeof right.process_instance_id === "string" ? right.process_instance_id : "";
  const processInstance = leftProcessInstance.localeCompare(rightProcessInstance);
  if (processInstance) return processInstance;
  const leftSequence = typeof left.seq === "number" ? left.seq : 0;
  const rightSequence = typeof right.seq === "number" ? right.seq : 0;
  return leftSequence - rightSequence;
}

function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  const redaction = redactCredentialsWithMetadata(value);
  const safe = redactPrivateReasoning(redaction.value) as Record<string, unknown>;
  if (redaction.excludedCredentialPaths.length === 0 && redaction.complete) return safe;
  return {
    ...safe,
    _redaction: {
      complete: redaction.complete,
      redacted: redaction.excludedCredentialPaths.length > 0,
      excluded_credential_paths: redaction.excludedCredentialPaths
    }
  };
}

function mergeDefined(base: RpcCorrelation | undefined, override: RpcCorrelation): RpcCorrelation {
  return {
    rpcId: override.rpcId ?? base?.rpcId,
    rpcMethod: override.rpcMethod ?? base?.rpcMethod,
    runId: override.runId ?? base?.runId,
    invocationId: override.invocationId ?? base?.invocationId,
    agentSessionId: override.agentSessionId ?? base?.agentSessionId,
    adapterType: override.adapterType ?? base?.adapterType
  };
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function providerObservationMessage(event: ProviderObservation["event"]): string {
  switch (event) {
    case "provider.input": return "provider input captured";
    case "provider.dispatch.written": return "provider input written";
    case "provider.dispatch.acknowledged": return "provider acknowledged request";
    case "provider.output.first": return "provider emitted first output";
    case "provider.output": return "provider output captured";
    case "provider.dispatch.failed": return "provider dispatch failed";
  }
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "logging_error";
}

function traceCaptureError(reason: string): Error {
  return Object.assign(new Error(`provider trace capture failed: ${reason}`), { code: "trace_capture_failed" });
}

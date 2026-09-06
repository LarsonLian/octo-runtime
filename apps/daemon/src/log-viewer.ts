import { constants, type Dirent } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";
import type { StoredLogRecord } from "@mininglamp-oss/octo-harness-observability";
import type { Run, Store } from "@mininglamp-oss/octo-harness-core";

const VIEWER_RUN_LIMIT = 100;
const VIEWER_QUERY_LIMIT = 1000;
const VIEWER_INDEX_LIMIT = 5000;
const VIEWER_FILE_READ_LIMIT = 1024 * 1024;
const RUN_STALL_THRESHOLD_MS = 30_000;
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const TERMINAL_EVENT_TYPES = new Set(["run.finished", "run.error", "run.stopped"]);

interface ViewerRunSummary {
  runId: string;
  status: string;
  sessionId: string;
  conversation: { id: string; type?: string; title?: string; channel?: string };
  invocationId?: string;
  chatTurnId?: string;
  adapterType?: string;
  model?: string;
  providerSessionId?: string;
  queuedAt?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  stallMs: number;
  stalled: boolean;
  lastEventAt?: string;
  eventCount: number;
}

interface IndexedLogRecord {
  key: string;
  ordinal: number;
  path: string;
  record: StoredLogRecord;
}

interface IndexedFile {
  offset: number;
  remainder: Buffer;
  restricted: boolean;
  device: number;
  inode: number;
}

interface ViewerLogFile {
  path: string;
  restricted: boolean;
}

interface ViewerPage {
  records: StoredLogRecord[];
  cursor: string;
  hasMore: boolean;
  reset: boolean;
}

interface DecodedViewerCursor {
  ordinal?: number;
  foreignInstance: boolean;
}

/**
 * Maintain a process-local, bounded JSONL tail for the Viewer.
 *
 * Existing shards contribute only their newest 1 MiB, while subsequent polls
 * read strictly from the last byte offset. This prevents a two-second Viewer
 * refresh from repeatedly parsing the full retention set. Cursor order is the
 * daemon's monotonic ingestion order, so wall-clock rollback cannot skip records.
 */
export class ViewerLogIndex {
  readonly #root: string;
  readonly #instanceId = randomUUID();
  readonly #files = new Map<string, IndexedFile>();
  readonly #records = new Map<string, IndexedLogRecord>();
  #nextOrdinal = 1;
  #refreshTail: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async refresh(includeSensitive: boolean): Promise<void> {
    const task = this.#refreshTail.then(() => this.#refresh(includeSensitive));
    this.#refreshTail = task.catch(() => undefined);
    return task;
  }

  records(includeSensitive: boolean): StoredLogRecord[] {
    return [...this.#records.values()]
      .filter(item => includeSensitive || item.record.sensitivity !== "restricted")
      .map(item => item.record);
  }

  page(
    allowed: Set<StoredLogRecord>,
    after: string | undefined,
    limit: number,
    includeSensitive: boolean
  ): ViewerPage {
    const visible = [...this.#records.values()]
      .filter(item => allowed.has(item.record))
      .filter(item => includeSensitive || item.record.sensitivity !== "restricted");
    const highWater = this.#nextOrdinal - 1;
    const decodedCursor = this.#decodeCursor(after);
    const afterOrdinal = decodedCursor.ordinal;
    const oldestOrdinal = Math.min(...[...this.#records.values()].map(item => item.ordinal), highWater + 1);
    if (afterOrdinal !== undefined && afterOrdinal > highWater) {
      throw new TypeError("after must be a valid viewer cursor");
    }
    const reset = decodedCursor.foreignInstance
      || (afterOrdinal !== undefined && afterOrdinal < oldestOrdinal - 1);

    if (afterOrdinal === undefined || reset) {
      const records = visible
        .sort((left, right) => compareLogRecords(left.record, right.record))
        .slice(-limit)
        .map(item => item.record);
      return { records, cursor: this.#encodeCursor(highWater), hasMore: false, reset };
    }

    const pending = visible
      .filter(item => item.ordinal > afterOrdinal)
      .sort((left, right) => left.ordinal - right.ordinal);
    const batch = pending.slice(0, limit);
    const hasMore = pending.length > batch.length;
    const cursorOrdinal = hasMore ? batch.at(-1)?.ordinal ?? afterOrdinal : highWater;
    return {
      records: batch.map(item => item.record).sort(compareLogRecords),
      cursor: this.#encodeCursor(cursorOrdinal),
      hasMore,
      reset: false
    };
  }

  async #refresh(includeSensitive: boolean): Promise<void> {
    const files = await listViewerLogFiles(this.#root, includeSensitive);
    const visiblePaths = new Set(files.map(file => file.path));
    for (const [path, state] of this.#files) {
      if ((!state.restricted || includeSensitive) && !visiblePaths.has(path)) this.#removeFile(path);
    }
    for (const file of files) await this.#readFile(file);
  }

  async #readFile(file: ViewerLogFile): Promise<void> {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    let handle;
    try {
      handle = await open(file.path, constants.O_RDONLY | noFollow);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    try {
      const stats = await handle.stat();
      const uid = process.getuid?.();
      if (!stats.isFile() || (uid !== undefined && stats.uid !== uid)) {
        throw new Error(`unsafe Viewer log file owner or type: ${file.path}`);
      }
      let prior = this.#files.get(file.path);
      if (prior && (prior.device !== stats.dev || prior.inode !== stats.ino || stats.size < prior.offset)) {
        // A daily rollover, external truncation, or replacement invalidates both
        // the byte cursor and every record previously attributed to this pathname.
        this.#removeFile(file.path);
        prior = undefined;
      }
      let offset = prior?.offset ?? Math.max(0, stats.size - VIEWER_FILE_READ_LIMIT);
      let remainder = prior?.remainder ?? Buffer.alloc(0);
      let discardLeadingFragment = prior === undefined && offset > 0;
      if (stats.size - offset > VIEWER_FILE_READ_LIMIT) {
        offset = Math.max(0, stats.size - VIEWER_FILE_READ_LIMIT);
        remainder = Buffer.alloc(0);
        discardLeadingFragment = offset > 0;
      }
      const length = Math.min(stats.size - offset, VIEWER_FILE_READ_LIMIT);
      if (length <= 0) {
        this.#files.set(file.path, {
          offset: stats.size,
          remainder,
          restricted: file.restricted,
          device: stats.dev,
          inode: stats.ino
        });
        return;
      }
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      let complete = Buffer.concat([remainder, buffer.subarray(0, bytesRead)]);
      if (discardLeadingFragment) {
        const firstNewline = complete.indexOf(0x0a);
        complete = firstNewline < 0 ? Buffer.alloc(0) : complete.subarray(firstNewline + 1);
      }
      const lastNewline = complete.lastIndexOf(0x0a);
      const body = lastNewline < 0 ? Buffer.alloc(0) : complete.subarray(0, lastNewline);
      const nextRemainder = lastNewline < 0 ? complete : complete.subarray(lastNewline + 1);
      this.#files.set(file.path, {
        offset: offset + bytesRead,
        remainder: Buffer.from(nextRemainder),
        restricted: file.restricted,
        device: stats.dev,
        inode: stats.ino
      });
      let lineNumber = 0;
      for (const line of body.toString("utf8").split("\n")) {
        lineNumber += 1;
        if (!line) continue;
        const record = parseStoredLogRecord(line);
        if (!record) continue;
        const key = logRecordKey(record, file.path, offset, lineNumber);
        if (this.#records.has(key)) continue;
        this.#records.set(key, { key, ordinal: this.#nextOrdinal++, path: file.path, record });
      }
      this.#trim();
    } finally {
      await handle.close();
    }
  }

  #trim(): void {
    if (this.#records.size <= VIEWER_INDEX_LIMIT) return;
    const excess = [...this.#records.values()]
      .sort((left, right) => left.ordinal - right.ordinal)
      .slice(0, this.#records.size - VIEWER_INDEX_LIMIT);
    for (const item of excess) this.#records.delete(item.key);
  }

  #removeFile(path: string): void {
    this.#files.delete(path);
    for (const item of this.#records.values()) {
      if (item.path === path) this.#records.delete(item.key);
    }
  }

  #encodeCursor(ordinal: number): string {
    return Buffer.from(JSON.stringify({ instance: this.#instanceId, ordinal }), "utf8").toString("base64url");
  }

  #decodeCursor(value: string | undefined): DecodedViewerCursor {
    if (!value) return { foreignInstance: false };
    try {
      const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
      if (!isRecord(decoded)
        || typeof decoded.instance !== "string"
        || typeof decoded.ordinal !== "number"
        || !Number.isSafeInteger(decoded.ordinal)
        || decoded.ordinal < 0) {
        throw new TypeError("invalid cursor fields");
      }
      return decoded.instance === this.#instanceId
        ? { ordinal: decoded.ordinal, foreignInstance: false }
        : { foreignInstance: true };
    } catch {
      throw new TypeError("after must be a valid viewer cursor");
    }
  }
}

/** Build the Viewer read model from authoritative state plus the incremental tail. */
export async function viewerTraceSnapshot({
  store,
  index,
  params
}: {
  store: Store;
  index: ViewerLogIndex;
  params: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const requestedRunId = optionalString(params.runId);
  const includeSensitive = params.includeSensitive === true;
  const limit = boundedInteger(params.limit, "limit", 250, VIEWER_QUERY_LIMIT);
  await index.refresh(includeSensitive);
  const allRecords = index.records(includeSensitive)
    .filter(record => logRecordData(record).method !== "logs.query" && logRecordData(record).method !== "logs.viewer");
  const candidateRuns = store.listRuns().slice(-VIEWER_RUN_LIMIT);
  const requestedRun = requestedRunId ? store.getRun(requestedRunId) : undefined;
  if (requestedRun && !candidateRuns.some(run => run.id === requestedRun.id)) candidateRuns.unshift(requestedRun);
  const summaries = candidateRuns
    .map(run => summarizeViewerRun(store, run, allRecords))
    .sort((left, right) => (right.lastEventAt ?? "").localeCompare(left.lastEventAt ?? ""));
  const selectedRunId = requestedRunId ?? summaries[0]?.runId;
  const selectedSummary = summaries.find(summary => summary.runId === selectedRunId);
  const related = new Set(selectViewerRecords(allRecords, selectedRunId, selectedSummary?.chatTurnId));
  const page = index.page(related, optionalString(params.after), limit, includeSensitive);

  const fromSeq = boundedInteger(params.fromSeq, "fromSeq", 1, Number.MAX_SAFE_INTEGER);
  const canonical = selectedRunId ? store.getEvents(selectedRunId) : [];
  const incrementalEvents = canonical.filter(event => event.seq >= fromSeq);
  const events = incrementalEvents.slice(0, limit).map(event => ({
    id: event.id,
    seq: event.seq,
    ts: new Date(event.tsMs).toISOString(),
    event: event.type,
    run_id: event.runId,
    session_id: event.sessionId,
    source: "state"
  }));
  const nextSeq = events.length > 0 ? Number(events.at(-1)!.seq) + 1 : fromSeq;

  return {
    selectedRunId,
    runs: summaries,
    records: page.records,
    events,
    cursor: page.cursor,
    nextSeq,
    reset: page.reset,
    hasMore: page.hasMore || incrementalEvents.length > events.length
  };
}

/** Join only explicit pre-Run ChatTurn and connection identities into a Run. */
export function selectViewerRecords(
  records: StoredLogRecord[],
  runId: string | undefined,
  chatTurnId?: string
): StoredLogRecord[] {
  if (!runId) return records;
  const scoped = records.filter(record => logRunId(record) === runId);
  const connectionIds = new Set(scoped.map(logConnectionId).filter(isDefined));
  const chatTurnIds = new Set([
    ...(chatTurnId ? [chatTurnId] : []),
    ...scoped.map(record => optionalString(logRecordData(record).chat_turn_id)).filter(isDefined)
  ]);
  return records.filter(record => {
    if (logRunId(record) === runId) return true;
    if (logRunId(record)) return false;
    const recordChatTurnId = optionalString(logRecordData(record).chat_turn_id);
    if (recordChatTurnId !== undefined) return chatTurnIds.has(recordChatTurnId);
    const connectionId = logConnectionId(record);
    return connectionId !== undefined
      && connectionIds.has(connectionId)
      && optionalString(record.scope)?.startsWith("transport.") === true
      && record.event.startsWith("transport.connection.");
  });
}

function summarizeViewerRun(store: Store, run: Run, records: StoredLogRecord[]): ViewerRunSummary {
  const events = store.getEvents(run.id);
  const session = store.getSession(run.sessionId);
  const attempt = run.attemptId ? store.getAttempt(run.attemptId) : undefined;
  const task = attempt ? store.getTask(attempt.taskId) : undefined;
  const agent = store.getAgent(task?.agentId ?? session?.agentId ?? "");
  const runRecords = records.filter(record => logRunId(record) === run.id);
  const queued = events.find(event => event.type === "run.queued");
  const started = events.find(event => event.type === "run.running");
  const ended = events.find(event => TERMINAL_EVENT_TYPES.has(event.type));
  const last = events.at(-1);
  const now = Date.now();
  const activityAt = last?.tsMs ?? queued?.tsMs;
  const durationStart = started?.tsMs ?? queued?.tsMs;
  const durationEnd = ended?.tsMs ?? (durationStart === undefined ? undefined : now);
  const active = !TERMINAL_RUN_STATUSES.has(run.status);
  const stallMs = active && activityAt !== undefined ? Math.max(0, now - activityAt) : 0;
  const chatTurnId = runRecords.map(record => optionalString(logRecordData(record).chat_turn_id)).find(isDefined);
  const adapterType = agent?.adapterType
    ?? runRecords.map(record => optionalString(record.adapter_type)).find(isDefined);
  const providerSessionId = optionalString(session?.providerSession?.sessionId)
    ?? runRecords.map(record => optionalString(logRecordData(record).provider_session_id)).find(isDefined);
  return {
    runId: run.id,
    status: run.status,
    sessionId: run.sessionId,
    conversation: {
      id: session?.id ?? run.sessionId,
      ...(session?.type ? { type: session.type } : {}),
      ...(session?.title ? { title: session.title } : {}),
      ...(session?.channel ? { channel: session.channel } : {})
    },
    ...(run.invocationId ? { invocationId: run.invocationId } : {}),
    ...(chatTurnId ? { chatTurnId } : {}),
    ...(adapterType ? { adapterType } : {}),
    ...(typeof agent?.config.model === "string" ? { model: agent.config.model } : {}),
    ...(providerSessionId ? { providerSessionId } : {}),
    ...(queued ? { queuedAt: new Date(queued.tsMs).toISOString() } : {}),
    ...(started ? { startedAt: new Date(started.tsMs).toISOString() } : {}),
    ...(ended ? { endedAt: new Date(ended.tsMs).toISOString() } : {}),
    ...(durationStart !== undefined && durationEnd !== undefined
      ? { durationMs: Math.max(0, durationEnd - durationStart) }
      : {}),
    stallMs,
    stalled: stallMs >= RUN_STALL_THRESHOLD_MS,
    ...(last ? { lastEventAt: new Date(last.tsMs).toISOString() } : {}),
    eventCount: events.length
  };
}

async function listViewerLogFiles(root: string, includeSensitive: boolean): Promise<ViewerLogFile[]> {
  const results: ViewerLogFile[] = [];
  const visit = async (directory: string, restricted: boolean): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (directory === root && entry.name === "crash") continue;
        const nestedRestricted = restricted || entry.name === "evaluation";
        if (!nestedRestricted || includeSensitive) await visit(path, nestedRestricted);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl") && (!restricted || includeSensitive)) {
        results.push({ path, restricted });
      }
    }
  };
  await visit(root, false);
  return results.sort((left, right) => relative(root, left.path).localeCompare(relative(root, right.path)));
}

function parseStoredLogRecord(line: string): StoredLogRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed) || typeof parsed.ts !== "string" || typeof parsed.event !== "string") return undefined;
    return parsed as StoredLogRecord;
  } catch {
    return undefined;
  }
}

function logRecordKey(record: StoredLogRecord, path: string, offset: number, line: number): string {
  const processInstance = optionalString(record.process_instance_id);
  const seq = typeof record.seq === "number" && Number.isSafeInteger(record.seq) ? record.seq : undefined;
  return processInstance && seq !== undefined
    ? `${processInstance}:${seq}`
    : `${path}:${offset}:${line}:${record.ts}:${record.event}`;
}

function logRecordData(record: StoredLogRecord): Record<string, unknown> {
  return isRecord(record.data) ? record.data : {};
}

function logRunId(record: StoredLogRecord): string | undefined {
  return optionalString(record.run_id) ?? optionalString(logRecordData(record).run_id);
}

function logConnectionId(record: StoredLogRecord): string | undefined {
  return optionalString(logRecordData(record).connection_id);
}

function compareLogRecords(left: StoredLogRecord, right: StoredLogRecord): number {
  return left.ts.localeCompare(right.ts)
    || (optionalString(left.process_instance_id) ?? "").localeCompare(optionalString(right.process_instance_id) ?? "")
    || numberValue(left.seq) - numberValue(right.seq);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function boundedInteger(value: unknown, name: string, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

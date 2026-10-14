import { randomUUID } from "node:crypto";

export interface ReplayEvent {
  runId: string;
  seq: number;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: number;
  leaseId: string;
  fencingToken: number;
}
export interface AgentWorkRunInput {
  runId: string;
  agentSessionId?: string;
  commandId: string;
  leaseId: string;
  fencingToken: number;
}
export interface CommandReceipt {
  commandId: string;
  serverSeq: number;
  accepted: boolean;
  error?: Record<string, unknown>;
}
interface MemoryRun {
  input: AgentWorkRunInput;
  next: number;
  sent: number;
  terminal: boolean;
  terminalType?: string;
  paused?: boolean;
  updated: number;
  events: ReplayEvent[];
  bytes: number;
}
export class StreamGapError extends Error {
  constructor(readonly runId: string) {
    super("STREAM_GAP");
    this.name = "StreamGapError";
  }
}
const RETENTION_MS = 120_000;
const PER_RUN_BYTES = 4 << 20;
const GLOBAL_BYTES = 64 << 20;
const MAX_EVENTS = 4096;
const TERMINALS = new Set(["run.completed", "run.failed", "run.cancelled"]);

/** 有界的进程内事件回放窗口；不落盘、不保存持久化水位，也不按云端 ACK 删除事件。 */
export class AgentWorkStore {
  readonly #runs = new Map<string, MemoryRun>();
  readonly #commands = new Map<string, { receipt: CommandReceipt; expires: number }>();
  readonly #workspaces = new Map<string, string>();
  readonly #epoch = randomUUID();
  #bytes = 0;
  #lastCommand = 0;
  get lastAckedCommandSeq(): number {
    return this.#lastCommand;
  }
  setLastAckedCommandSeq(seq: number): void {
    this.#lastCommand = Math.max(this.#lastCommand, seq);
  }
  // 进程重启后 epoch 改变，旧订阅游标不能误用到新事件流。
  streamId(runId: string): string {
    return `host:${this.#epoch}:${runId}`;
  }
  conversationWorkspace(key: string, candidate: string): { path: string; created: boolean } {
    const prior = this.#workspaces.get(key);
    if (prior) return { path: prior, created: false };
    if (this.#workspaces.size >= 1024)
      this.#workspaces.delete(this.#workspaces.keys().next().value!);
    this.#workspaces.set(key, candidate);
    return { path: candidate, created: true };
  }
  getCommandReceipt(id: string): CommandReceipt | undefined {
    const v = this.#commands.get(id);
    if (!v) return undefined;
    if (v.expires < Date.now()) {
      this.#commands.delete(id);
      return undefined;
    }
    return structuredClone(v.receipt);
  }
  recordCommandReceipt(
    commandId: string,
    serverSeq: number,
    accepted: boolean,
    error?: Record<string, unknown>,
    expiresAt?: number
  ): void {
    if (error && Buffer.byteLength(JSON.stringify(error)) > 65536)
      throw new Error("COMMAND_RECEIPT_TOO_LARGE");
    if (!this.#commands.has(commandId) && this.#commands.size >= 4096)
      this.#commands.delete(this.#commands.keys().next().value!);
    this.#commands.set(commandId, {
      receipt: {
        commandId,
        serverSeq,
        accepted,
        ...(error ? { error: structuredClone(error) } : {})
      },
      expires: Math.min(expiresAt ?? Infinity, Date.now() + RETENTION_MS)
    });
  }
  // 同一 Run 只能复用原租约与 fencing token，拒绝旧执行者覆盖当前执行身份。
  upsertRun(input: AgentWorkRunInput): void {
    const prior = this.#runs.get(input.runId);
    if (prior) {
      if (prior.input.leaseId !== input.leaseId || prior.input.fencingToken !== input.fencingToken)
        throw new Error("RUN_LEASE_MISMATCH");
      return;
    }
    this.reconcile();
    if (this.#runs.size >= 128) throw new Error("RUN_CAPACITY_EXHAUSTED");
    this.#runs.set(input.runId, {
      input: { ...input },
      next: 1,
      sent: 0,
      terminal: false,
      updated: Date.now(),
      events: [],
      bytes: 0
    });
  }
  runExists(id: string): boolean {
    return this.#runs.has(id);
  }
  activeRunIds(): string[] {
    return [...this.#runs].filter(([, r]) => !r.terminal).map(([id]) => id);
  }
  retainedRunIds(): string[] {
    return [...this.#runs.keys()];
  }
  terminalType(id: string): string | undefined {
    return this.#runs.get(id)?.terminalType;
  }
  pauseCloudStream(id: string): void {
    const r = this.#runs.get(id);
    if (r) r.paused = true;
  }
  discardRun(id: string): boolean {
    const r = this.#runs.get(id);
    if (!r) return false;
    this.#bytes -= r.bytes;
    return this.#runs.delete(id);
  }
  #drop(r: MemoryRun): void {
    const v = r.events.shift();
    if (v) {
      const bytes = Buffer.byteLength(JSON.stringify(v));
      r.bytes -= bytes;
      this.#bytes -= bytes;
    }
  }
  // 分配递增序号并保留原事件；超过单 Run 或全局容量时淘汰最早事件。
  allocateAndAppend(
    runId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): { seq: number; eventId: string } {
    const r = this.#runs.get(runId);
    if (!r) throw new Error("RUN_EXPIRED");
    const row: ReplayEvent = {
      runId,
      seq: r.next,
      eventId: `evt_${randomUUID()}`,
      eventType,
      payload: structuredClone(payload),
      createdAt: Date.now(),
      leaseId: r.input.leaseId,
      fencingToken: r.input.fencingToken
    };
    const bytes = Buffer.byteLength(JSON.stringify(row));
    if (bytes > 256 << 10) throw new Error("STREAM_EVENT_TOO_LARGE");
    r.next++;
    r.updated = row.createdAt;
    r.terminal ||= TERMINALS.has(eventType);
    if (TERMINALS.has(eventType)) r.terminalType = eventType;
    r.events.push(row);
    r.bytes += bytes;
    this.#bytes += bytes;
    while (r.bytes > PER_RUN_BYTES || r.events.length > MAX_EVENTS) this.#drop(r);
    while (this.#bytes > GLOBAL_BYTES) {
      let oldest: MemoryRun | undefined;
      for (const x of this.#runs.values()) {
        if (x.events.length && (!oldest || x.events[0].createdAt < oldest.events[0].createdAt))
          oldest = x;
      }
      if (!oldest) break;
      this.#drop(oldest);
    }
    return { seq: row.seq, eventId: row.eventId };
  }
  listSendable(limit: number): ReplayEvent[] {
    const rows: ReplayEvent[] = [];
    for (const [id, r] of this.#runs) {
      if (r.paused) continue;
      if (r.events[0] && r.sent + 1 < r.events[0].seq) throw new StreamGapError(id);
      for (const v of r.events) {
        if (v.seq > r.sent) {
          rows.push(structuredClone(v));
          if (rows.length >= limit) return rows;
        }
      }
    }
    return rows;
  }
  markSent(runId: string, seq: number): void {
    const r = this.#runs.get(runId);
    if (r) r.sent = Math.max(r.sent, seq);
  }
  // 只能从仍在回放窗口内的游标恢复；已淘汰的数据明确报缺口，不假装续传成功。
  resume(runId: string, after: number): void {
    const r = this.#runs.get(runId);
    if (!r) throw new Error("STREAM_EXPIRED");
    if (!Number.isSafeInteger(after) || after < 0 || after >= r.next)
      throw new Error("STREAM_CURSOR_INVALID");
    if (after < r.next - 1 && (!r.events.length || after + 1 < r.events[0].seq))
      throw new StreamGapError(runId);
    r.sent = after;
  }
  read(
    runId: string,
    streamId: string | undefined,
    after: number
  ): { streamId: string; latestSeq: number; events: ReplayEvent[] } {
    this.reconcile();
    if (streamId && streamId !== this.streamId(runId)) throw new Error("STREAM_EXPIRED");
    const r = this.#runs.get(runId);
    if (!r) throw new Error("STREAM_EXPIRED");
    if (!Number.isSafeInteger(after) || after < 0 || after >= r.next)
      throw new Error("STREAM_CURSOR_INVALID");
    if (after < r.next - 1 && (!r.events.length || after + 1 < r.events[0].seq))
      throw new StreamGapError(runId);
    return {
      streamId: this.streamId(runId),
      latestSeq: r.next - 1,
      events: r.events.filter((v) => v.seq > after).map((v) => structuredClone(v))
    };
  }
  outboxBytes(): number {
    return this.#bytes;
  }
  pendingCount(): number {
    return [...this.#runs.values()].reduce(
      (n, r) => n + r.events.filter((v) => v.seq > r.sent).length,
      0
    );
  }
  oldestUnackedAgeMs(): number | null {
    let oldest = Infinity;
    for (const r of this.#runs.values()) {
      const v = r.events.find((e) => e.seq > r.sent);
      if (v) oldest = Math.min(oldest, v.createdAt);
    }
    return Number.isFinite(oldest) ? Date.now() - oldest : null;
  }
  // 保留时间与 ACK 无关；终态 Run 超时后连同材料快照一起释放。
  reconcile(now = Date.now()): void {
    for (const [id, r] of this.#runs) {
      while (r.events[0] && now - r.events[0].createdAt > RETENTION_MS) this.#drop(r);
      if (r.terminal && now - r.updated > RETENTION_MS) this.discardRun(id);
    }
    for (const [id, c] of this.#commands) if (c.expires < now) this.#commands.delete(id);
  }
  dbBytes(): number {
    return 0;
  }
  walBytes(): number {
    return 0;
  }
  close(): void {
    this.#runs.clear();
    this.#commands.clear();
    this.#workspaces.clear();
    this.#bytes = 0;
  }
}

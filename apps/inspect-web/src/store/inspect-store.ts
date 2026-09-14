import {
  EVENT_SOURCES,
  isRecord,
  normalizeEvent,
  normalizeLog,
  type ConnectionState,
  type InspectRecord,
  type RunSummary
} from "../domain";
import { compileQuery, type QueryField } from "../query";

const MAX_EVENT_ROWS = 6_000;
const MAX_EVENT_BYTES = 6 * 1024 * 1024;
const MAX_RUNS = 100;

export interface InspectSnapshot {
  events: readonly InspectRecord[];
  filteredEvents: readonly InspectRecord[];
  logs: readonly InspectRecord[];
  filteredLogs: readonly InspectRecord[];
  runs: readonly RunSummary[];
  status: Record<string, unknown>;
  serverMemory: Record<string, unknown>;
  connection: ConnectionState;
  connectionMessage: string;
  query: string;
  queryError?: { message: string; offset: number };
  retainedBytes: number;
}

export class InspectStore {
  readonly #listeners = new Set<() => void>();
  readonly #runIndex = new Map<string, RunSummary>();
  #predicate = compileQuery("").predicate;
  #snapshot: InspectSnapshot = {
    events: [],
    filteredEvents: [],
    logs: [],
    filteredLogs: [],
    runs: [],
    status: {},
    serverMemory: {},
    connection: "connecting",
    connectionMessage: "正在连接",
    query: "",
    retainedBytes: 0
  };

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): InspectSnapshot => this.#snapshot;

  setConnection(connection: ConnectionState, connectionMessage: string): void {
    this.#update({ connection, connectionMessage });
  }

  setStatus(status: unknown, memory: unknown): void {
    this.#update({
      status: isRecord(status) ? status : {},
      serverMemory: isRecord(memory) ? memory : {}
    });
  }

  appendEvents(messages: readonly { value: Record<string, unknown>; raw: string }[]): void {
    if (messages.length === 0) return;
    const existingSequences = new Set(
      this.#snapshot.events.flatMap(event => event.localSeq === undefined ? [] : [event.localSeq])
    );
    const additions = messages
      .map(message => normalizeEvent(message.value, message.raw))
      .filter(event => {
        if (event.localSeq === undefined) return true;
        if (existingSequences.has(event.localSeq)) return false;
        existingSequences.add(event.localSeq);
        return true;
      });
    if (additions.length === 0) return;

    const newestFirst = [...additions].reverse();
    const events = [...newestFirst, ...this.#snapshot.events];
    let retainedBytes = this.#snapshot.retainedBytes + additions.reduce((total, event) => total + event.bytes, 0);
    while (events.length > MAX_EVENT_ROWS || retainedBytes > MAX_EVENT_BYTES) {
      const event = events.pop();
      if (!event) break;
      retainedBytes -= event.bytes;
    }

    for (const event of additions) this.#trackRun(event);
    this.#update({
      events,
      filteredEvents: events.filter(this.#predicate),
      runs: [...this.#runIndex.values()],
      retainedBytes
    });
  }

  setLogs(value: unknown): void {
    const logs = Array.isArray(value)
      ? value.filter(isRecord).map((item, index) => normalizeLog(item, index)).sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      : [];
    this.#update({ logs, filteredLogs: logs.filter(this.#predicate) });
  }

  setQuery(query: string): void {
    const compiled = compileQuery(query);
    if (!compiled.error) this.#predicate = compiled.predicate;
    this.#update({
      query,
      queryError: compiled.error,
      filteredEvents: compiled.error ? this.#snapshot.filteredEvents : this.#snapshot.events.filter(this.#predicate),
      filteredLogs: compiled.error ? this.#snapshot.filteredLogs : this.#snapshot.logs.filter(this.#predicate)
    });
  }

  clearEvents(): void {
    this.#runIndex.clear();
    this.#update({ events: [], filteredEvents: [], runs: [], retainedBytes: 0 });
  }

  valueOptions(): Partial<Record<QueryField, readonly string[]>> {
    const values = <T>(select: (event: InspectRecord) => T): T[] =>
      [...new Set(this.#snapshot.events.map(select).filter(Boolean))];
    return {
      profile: values(event => event.profile),
      runtime_id: values(event => event.runtimeId),
      source: EVENT_SOURCES,
      stage: values(event => event.stage),
      direction: ["inbound", "outbound"],
      type: values(event => event.type),
      adapter_type: values(event => event.adapterType),
      session_id: values(event => event.sessionId),
      agent_run_id: values(event => event.runId),
      invocation_id: values(event => event.invocationId),
      status: ["ok", "warning", "error"]
    };
  }

  #trackRun(event: InspectRecord): void {
    if (!event.runId) return;
    const key = `${event.profile}\u0000${event.runId}`;
    this.#runIndex.delete(key);
    this.#runIndex.set(key, {
      id: event.runId,
      profile: event.profile,
      type: event.type,
      occurredAt: event.occurredAt
    });
    while (this.#runIndex.size > MAX_RUNS) {
      const oldest = this.#runIndex.keys().next().value;
      if (oldest === undefined) break;
      this.#runIndex.delete(oldest);
    }
  }

  #update(next: Partial<InspectSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...next };
    for (const listener of this.#listeners) listener();
  }
}

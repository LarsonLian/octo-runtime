import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentConfig, EventEnvelope, ProviderSession } from "@orbtex-ai/orbtex-protocol";

export type TriggerKind = "manual" | "event" | "interval";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type TaskStatus = RunStatus;

export interface Agent {
  id: string;
  name: string;
  adapterType: string;
  config: AgentConfig;
}

export interface TriggerTaskTemplate {
  title: string;
  description: string;
}

export interface Trigger {
  id: string;
  name: string;
  enabled: boolean;
  kind: TriggerKind;
  agentId: string;
  task: TriggerTaskTemplate;
  eventType?: string;
  filter?: Record<string, unknown>;
  everyMs?: number;
}

export interface TriggerOccurrence {
  id: string;
  triggerId: string;
  externalEventId: string;
  kind: TriggerKind;
  payload: Record<string, unknown>;
  createdAt: number;
  taskId: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  agentId: string;
  status: TaskStatus;
  sessionId: string;
  createdAt: number;
  activeRunId?: string;
}

export interface Attempt {
  id: string;
  taskId: string;
  number: number;
  status: RunStatus;
  runId: string;
  triggerOccurrenceId?: string;
  sourceType: string;
  sourceId?: string;
}

export interface Session {
  id: string;
  type: "chat" | "task";
  status: "active" | "closed";
  agentId?: string;
  title?: string;
  channel?: string;
  createdAt?: number;
  activeRunId?: string;
  providerSession?: ProviderSession;
}

export interface Run {
  id: string;
  sessionId: string;
  status: RunStatus;
  nextSeq: number;
  attemptId?: string;
  prompt?: string;
  invocationId?: string;
}

export interface StoreSnapshot {
  agents: Array<[string, Agent]>;
  triggers: Array<[string, Trigger]>;
  occurrences: Array<[string, TriggerOccurrence]>;
  tasks: Array<[string, Task]>;
  attempts: Array<[string, Attempt]>;
  sessions: Array<[string, Session]>;
  runs: Array<[string, Run]>;
  events: Array<[string, EventEnvelope[]]>;
}

export interface Store {
  agents: Map<string, Agent>;
  triggers: Map<string, Trigger>;
  occurrences: Map<string, TriggerOccurrence>;
  tasks: Map<string, Task>;
  attempts: Map<string, Attempt>;
  sessions: Map<string, Session>;
  runs: Map<string, Run>;
  events: Map<string, EventEnvelope[]>;
  appendEvent(event: EventEnvelope): boolean;
  commit(): Promise<void>;
}

export class MemoryStore implements Store {
  agents = new Map<string, Agent>();
  triggers = new Map<string, Trigger>();
  occurrences = new Map<string, TriggerOccurrence>();
  tasks = new Map<string, Task>();
  attempts = new Map<string, Attempt>();
  sessions = new Map<string, Session>();
  runs = new Map<string, Run>();
  events = new Map<string, EventEnvelope[]>();

  appendEvent(event: EventEnvelope): boolean {
    const stream = this.events.get(event.runId) ?? [];
    if (stream.some(item => item.seq === event.seq)) return false;
    stream.push(event);
    this.events.set(event.runId, stream);
    return true;
  }

  async commit(): Promise<void> {}

  snapshot(): StoreSnapshot {
    return {
      agents: [...this.agents.entries()],
      triggers: [...this.triggers.entries()],
      occurrences: [...this.occurrences.entries()],
      tasks: [...this.tasks.entries()],
      attempts: [...this.attempts.entries()],
      sessions: [...this.sessions.entries()],
      runs: [...this.runs.entries()],
      events: [...this.events.entries()]
    };
  }
}

export class JsonFileStore extends MemoryStore {
  readonly #file: string;
  #writes: Promise<void> = Promise.resolve();

  constructor(file: string) {
    super();
    this.#file = file;
  }

  static async open(file: string): Promise<JsonFileStore> {
    const store = new JsonFileStore(file);
    try {
      const data = JSON.parse(await readFile(file, "utf8")) as Partial<StoreSnapshot> & { version?: number };
      if (data.version !== 1) throw new Error(`unsupported store version: ${data.version}`);
      store.agents = new Map(data.agents ?? []);
      store.triggers = new Map(data.triggers ?? []);
      store.occurrences = new Map(data.occurrences ?? []);
      store.tasks = new Map(data.tasks ?? []);
      store.attempts = new Map(data.attempts ?? []);
      store.sessions = new Map(data.sessions ?? []);
      store.runs = new Map(data.runs ?? []);
      store.events = new Map(data.events ?? []);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return store;
  }

  override async commit(): Promise<void> {
    const body = JSON.stringify({ version: 1, ...this.snapshot() }, null, 2) + "\n";
    // 串行化并发提交，再通过同目录 rename 原子替换，避免留下半写入的状态文件。
    this.#writes = this.#writes.then(async () => {
      await mkdir(dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.#file);
    });
    return this.#writes;
  }
}

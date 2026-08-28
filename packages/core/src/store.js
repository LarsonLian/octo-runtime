import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const COLLECTIONS = ["agents", "triggers", "occurrences", "tasks", "attempts", "sessions", "runs", "events"];

export class MemoryStore {
  agents = new Map();
  triggers = new Map();
  occurrences = new Map();
  tasks = new Map();
  attempts = new Map();
  sessions = new Map();
  runs = new Map();
  events = new Map();

  appendEvent(event) {
    const stream = this.events.get(event.runId) ?? [];
    if (stream.some(item => item.seq === event.seq)) return false;
    stream.push(event);
    this.events.set(event.runId, stream);
    return true;
  }

  async commit() {}

  snapshot() {
    return Object.fromEntries(COLLECTIONS.map(name => [name, [...this[name].entries()]]));
  }
}

export class JsonFileStore extends MemoryStore {
  #file;
  #writes = Promise.resolve();

  constructor(file) { super(); this.#file = file; }

  static async open(file) {
    const store = new JsonFileStore(file);
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      if (data.version !== 1) throw new Error(`unsupported store version: ${data.version}`);
      for (const name of COLLECTIONS) store[name] = new Map(data[name] ?? []);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return store;
  }

  async commit() {
    const body = JSON.stringify({ version: 1, ...this.snapshot() }, null, 2) + "\n";
    this.#writes = this.#writes.then(async () => {
      await mkdir(dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.#file);
    });
    return this.#writes;
  }
}

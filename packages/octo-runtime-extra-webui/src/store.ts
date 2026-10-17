import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
export interface Session {
  id: string;
  title: string;
  projectPath: string;
  updatedAt: number;
  revision: number;
  adapter: string;
  model: string;
  effort: string;
  providerSession?: Record<string, unknown>;
  messages: unknown[];
}
export function validMessages(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.every((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return false;
      const row = message as Record<string, unknown>;
      return (
        typeof row.id === "string" &&
        typeof row.role === "string" &&
        ["user", "assistant", "system"].includes(row.role) &&
        typeof row.content === "string" &&
        typeof row.createdAt === "number" &&
        Number.isFinite(row.createdAt)
      );
    })
  );
}
export function validBinding(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).sessionId === "string" &&
    !!(value as Record<string, unknown>).sessionId
  );
}
export class SessionStore {
  records: Session[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly path: string) {}
  async open() {
    try {
      const text = await readFile(this.path, "utf8");
      if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error("WEBUI_STORE_TOO_LARGE");
      const data = JSON.parse(text) as { version: number; sessions: Session[] };
      if (
        data.version !== 1 ||
        !Array.isArray(data.sessions) ||
        data.sessions.length > 100 ||
        data.sessions.some(
          (s) =>
            typeof s.id !== "string" ||
            !/^[a-f0-9-]{36}$/.test(s.id) ||
            typeof s.projectPath !== "string" ||
            typeof s.title !== "string" ||
            !["adapter", "model", "effort"].every(
              (key) => typeof s[key as keyof Session] === "string"
            ) ||
            !Number.isFinite(s.updatedAt) ||
            !validMessages(s.messages) ||
            (s.providerSession !== undefined && !validBinding(s.providerSession)) ||
            !Number.isSafeInteger(s.revision) ||
            s.revision < 0
        )
      )
        throw new Error("WEBUI_STORE_INVALID");
      if (new Set(data.sessions.map((session) => session.id)).size !== data.sessions.length)
        throw new Error("WEBUI_STORE_INVALID");
      this.records = data.sessions;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  change<T>(operation: (records: Session[]) => T): Promise<T> {
    const task = this.queue
      .catch(() => undefined)
      .then(async () => {
        const next = structuredClone(this.records);
        const result = operation(next);
        const text = JSON.stringify({ version: 1, sessions: next });
        if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error("WEBUI_STORE_TOO_LARGE");
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
        this.records = next;
        return result;
      });
    this.queue = task;
    return task;
  }
}

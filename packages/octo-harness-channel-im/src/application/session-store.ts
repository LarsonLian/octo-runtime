import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { InvokeRequest, ProviderSession } from "@mininglamp-oss/octo-harness-protocol";

export interface ImSessionOccurrence {
  text: string;
  sessionId: string;
  runId: string;
  snapshot?: Omit<InvokeRequest, "signal">;
}

export interface ImSessionBinding {
  id?: string;
  generation: number;
  providerSession?: ProviderSession;
}

export interface ImSessionStore {
  read(key: string): ImSessionBinding | undefined;
  save(key: string, binding: ImSessionBinding): void;
  reset(key: string, controlId: string): ImSessionBinding;
  occurrence(key: string, id: string): ImSessionOccurrence | undefined;
  remember(key: string, id: string, value: ImSessionOccurrence): void;
  close?(): void;
}

export class MemoryImSessionStore implements ImSessionStore {
  readonly #bindings = new Map<string, ImSessionBinding>();
  readonly #controls = new Map<string, ImSessionBinding>();
  readonly #occurrences = new Map<string, ImSessionOccurrence>();
  read(key: string) {
    const value = this.#bindings.get(key);
    return value && structuredClone(value);
  }
  save(key: string, value: ImSessionBinding) {
    this.#bindings.set(key, structuredClone(value));
  }
  reset(key: string, id: string) {
    const controlKey = JSON.stringify([key, id]),
      previous = this.#controls.get(controlKey);
    if (previous) return structuredClone(this.#bindings.get(key)!);
    const binding = { generation: (this.read(key)?.generation ?? 1) + 1 };
    this.save(key, binding);
    this.#controls.set(controlKey, binding);
    return binding;
  }
  occurrence(key: string, id: string) {
    return this.#occurrences.get(JSON.stringify([key, id]));
  }
  remember(key: string, id: string, value: ImSessionOccurrence) {
    this.#occurrences.set(JSON.stringify([key, id]), structuredClone(value));
  }
}

/** Business mappings and occurrence receipts, never a Host event outbox. */
export class SqliteImSessionStore implements ImSessionStore {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS im_sessions(scope TEXT PRIMARY KEY, binding_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS im_controls(scope TEXT NOT NULL, control_id TEXT NOT NULL, PRIMARY KEY(scope,control_id));
      CREATE TABLE IF NOT EXISTS im_occurrences(scope TEXT NOT NULL, occurrence_id TEXT NOT NULL, receipt_json TEXT NOT NULL, PRIMARY KEY(scope,occurrence_id));`);
  }
  read(key: string): ImSessionBinding | undefined {
    const row = this.#db.prepare("SELECT binding_json FROM im_sessions WHERE scope=?").get(key) as
      { binding_json: string } | undefined;
    return row && JSON.parse(row.binding_json);
  }
  save(key: string, value: ImSessionBinding): void {
    this.#db
      .prepare(
        "INSERT INTO im_sessions VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET binding_json=excluded.binding_json"
      )
      .run(key, JSON.stringify(value));
  }
  reset(key: string, id: string): ImSessionBinding {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (
        !this.#db.prepare("SELECT 1 FROM im_controls WHERE scope=? AND control_id=?").get(key, id)
      ) {
        this.save(key, { generation: (this.read(key)?.generation ?? 1) + 1 });
        this.#db.prepare("INSERT INTO im_controls VALUES(?,?)").run(key, id);
      }
      const result = this.read(key)!;
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  occurrence(key: string, id: string): ImSessionOccurrence | undefined {
    const row = this.#db
      .prepare("SELECT receipt_json FROM im_occurrences WHERE scope=? AND occurrence_id=?")
      .get(key, id) as { receipt_json: string } | undefined;
    return row && JSON.parse(row.receipt_json);
  }
  remember(key: string, id: string, value: ImSessionOccurrence): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare("INSERT INTO im_occurrences VALUES(?,?,?)")
        .run(key, id, JSON.stringify(value));
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    this.#db.close();
  }
}

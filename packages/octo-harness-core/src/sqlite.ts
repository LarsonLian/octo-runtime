import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const WAL_PRAGMAS = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA wal_autocheckpoint = 1000;
  PRAGMA journal_size_limit = 67108864;
  PRAGMA auto_vacuum = INCREMENTAL;
`;

/**
 * Open or create a WAL-mode, power-loss-durable SQLite database.
 * The directory is 0700 and the database plus its -wal/-shm sidecar files are
 * 0600, so only the current host account can access them. The caller is
 * responsible for creating tables afterwards (schemas differ).
 */
export function openWalDatabase(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(WAL_PRAGMAS);
  for (const suffix of ["", "-wal", "-shm"]) chmodQuiet(`${file}${suffix}`, 0o600);
  return db;
}

/** chmod a file that may not exist yet; silently skip when the file is absent. */
export function chmodQuiet(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

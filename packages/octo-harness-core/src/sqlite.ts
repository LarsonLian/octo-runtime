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
 * 打开或创建一个 WAL 模式、掉电耐久的 SQLite 数据库。
 * 目录 0700、数据库及其 -wal/-shm 边车文件 0600，仅允许当前宿主账号访问。
 * 调用方负责随后建表（schema 各不相同）。
 */
export function openWalDatabase(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(WAL_PRAGMAS);
  for (const suffix of ["", "-wal", "-shm"]) chmodQuiet(`${file}${suffix}`, 0o600);
  return db;
}

/** chmod 一个可能尚未创建的文件；文件不存在时静默跳过。 */
export function chmodQuiet(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

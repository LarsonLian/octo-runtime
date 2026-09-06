import { constants, type Dirent } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rmdir, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ActiveFile, RetainedFile } from "./types.js";

export const DATE_DIRECTORY = /^\d{4}-\d{2}-\d{2}$/;

export interface DirectoryIdentity {
  path: string;
  device: number;
  inode: number;
}

/** Fail fast when strict capture cannot promise no-follow durable writes. */
export function assertStrictStorageCapabilities(): void {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("strict provider capture requires O_NOFOLLOW support");
  }
  if (typeof constants.O_DIRECTORY !== "number") {
    throw new Error("strict provider capture requires directory descriptor support");
  }
}

/** Append through a no-follow descriptor and revalidate the opened inode. */
export async function appendSecure(path: string, line: string, durable: boolean): Promise<void> {
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") throw new Error("secure log append requires O_NOFOLLOW support");
  const before = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (before?.isSymbolicLink() || (before && !before.isFile())) throw new Error(`unsafe log file: ${path}`);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollow;
  const handle = await open(path, flags, 0o600);
  try {
    const stats = await handle.stat();
    const uid = process.getuid?.();
    if (!stats.isFile() || (uid !== undefined && stats.uid !== uid)) {
      throw new Error(`unsafe log file owner or type: ${path}`);
    }
    if (before && (before.dev !== stats.dev || before.ino !== stats.ino)) {
      throw new Error(`log file changed before append: ${path}`);
    }
    const linked = await lstat(path);
    if (linked.isSymbolicLink() || linked.dev !== stats.dev || linked.ino !== stats.ino) {
      throw new Error(`log file changed during append: ${path}`);
    }
    await handle.chmod(0o600);
    await handle.writeFile(line, "utf8");
    if (durable) await handle.sync();
    const after = await lstat(path);
    if (after.isSymbolicLink() || after.dev !== stats.dev || after.ino !== stats.ino) {
      throw new Error(`log file changed after append: ${path}`);
    }
  } finally {
    await handle.close();
  }
  if (durable) await syncDirectory(dirname(path));
}

/** Create descendants one component at a time, rejecting symlinks and foreign owners. */
export async function ensureSecureDirectory(path: string, root = path): Promise<DirectoryIdentity[]> {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`log path escapes configured root: ${resolvedPath}`);
  }
  await ensureLogRoot(resolvedRoot);
  const relativePath = relative(resolvedRoot, resolvedPath);
  const paths = [resolvedRoot];
  if (relativePath) {
    let current = resolvedRoot;
    for (const part of relativePath.split(sep)) {
      current = join(current, part);
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      paths.push(current);
    }
  }
  const uid = process.getuid?.();
  const identities: DirectoryIdentity[] = [];
  for (const candidate of paths) {
    const stats = await lstat(candidate);
    if (stats.isSymbolicLink() || !stats.isDirectory() || (uid !== undefined && stats.uid !== uid)) {
      throw new Error(`unsafe log directory owner or type: ${candidate}`);
    }
    await chmod(candidate, 0o700);
    identities.push({ path: candidate, device: stats.dev, inode: stats.ino });
  }
  return identities;
}

/** Revalidate that no directory in a previously checked chain was replaced. */
export async function revalidateSecureDirectoryChain(identities: DirectoryIdentity[]): Promise<void> {
  const uid = process.getuid?.();
  for (const identity of identities) {
    const stats = await lstat(identity.path);
    if (stats.isSymbolicLink()
      || !stats.isDirectory()
      || stats.dev !== identity.device
      || stats.ino !== identity.inode
      || (uid !== undefined && stats.uid !== uid)) {
      throw new Error(`log directory changed during append: ${identity.path}`);
    }
  }
}

async function ensureLogRoot(root: string): Promise<void> {
  try {
    const existing = await lstat(root);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`unsafe log directory owner or type: ${root}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(root, { recursive: true, mode: 0o700 });
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directoryFlag = constants.O_DIRECTORY;
  const noFollow = constants.O_NOFOLLOW;
  if (typeof directoryFlag !== "number") throw new Error("directory synchronization is unavailable");
  if (typeof noFollow !== "number") throw new Error("secure directory synchronization is unavailable");
  const handle = await open(path, constants.O_RDONLY | directoryFlag | noFollow);
  try {
    const stats = await handle.stat();
    const uid = process.getuid?.();
    if (!stats.isDirectory() || (uid !== undefined && stats.uid !== uid)) {
      throw new Error(`unsafe directory owner or type: ${path}`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Synchronize new directory entries from the leaf back to the configured root. */
export async function syncDirectoryChain(path: string, root: string): Promise<void> {
  let current = resolve(path);
  const resolvedRoot = resolve(root);
  while (true) {
    await syncDirectory(current);
    if (current === resolvedRoot) return;
    const parent = dirname(current);
    if (!current.startsWith(`${resolvedRoot}${sep}`) || parent === current) {
      throw new Error(`log path escapes configured root: ${current}`);
    }
    current = parent;
  }
}

/** Resolve the first existing shard with room, or the next unused shard. */
export async function resolveActiveFile(
  directory: string,
  base: string,
  day: string,
  maxBytes: number
): Promise<ActiveFile> {
  let shard = 0;
  while (true) {
    const path = shardPath(directory, base, shard);
    try {
      const stats = await lstat(path);
      if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`unsafe log file: ${path}`);
      if (stats.size < maxBytes) return { day, shard, path, size: stats.size };
      shard += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { day, shard, path, size: 0 };
      throw error;
    }
  }
}

export function shardPath(directory: string, base: string, shard: number): string {
  return join(directory, shard === 0 ? `${base}.jsonl` : `${base}.${String(shard).padStart(3, "0")}.jsonl`);
}

/** Walk physical directories only and derive ordering from embedded timestamps. */
export async function collectLogFiles(root: string): Promise<RetainedFile[]> {
  const results: RetainedFile[] = [];
  const visit = async (directory: string, inheritedDay?: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      const directoryDay = DATE_DIRECTORY.test(entry.name) ? entry.name : inheritedDay;
      if (entry.isDirectory()) {
        await visit(path, directoryDay);
        continue;
      }
      const rel = relative(root, path);
      const category = rel.split(sep).includes("evaluation")
        ? "evaluation"
        : rel.split(sep)[0] === "crash" ? "crash" : "operational";
      if (!entry.isFile() || (!entry.name.endsWith(".jsonl") && !(category === "crash" && entry.name.endsWith(".json")))) {
        continue;
      }
      try {
        const stats = await lstat(path);
        if (stats.isSymbolicLink() || !stats.isFile()) continue;
        const oldestTs = await earliestTimestamp(path);
        const day = category === "crash" && oldestTs
          ? localDay(new Date(oldestTs))
          : directoryDay;
        results.push({ path, size: stats.size, category, ...(day ? { day } : {}), ...(oldestTs ? { oldestTs } : {}) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
  };
  await visit(root);
  return results;
}

async function earliestTimestamp(path: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let earliest: string | undefined;
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const value = JSON.parse(line) as { ts?: unknown };
      if (typeof value.ts === "string" && !Number.isNaN(Date.parse(value.ts))) {
        if (earliest === undefined || value.ts < earliest) earliest = value.ts;
      }
    } catch {
      // Ignore corrupt lines; capacity cleanup must not trust mtime as a fallback.
    }
  }
  return earliest;
}

export async function removeIfEmpty(path: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (entries.length === 0) await rmdir(path).catch(error => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
  });
}

/** Restricted evidence is reclaimed before operational and crash evidence. */
export function compareCapacityCandidates(left: RetainedFile, right: RetainedFile): number {
  const priority = (left.category === "evaluation" ? 0 : 1) - (right.category === "evaluation" ? 0 : 1);
  if (priority) return priority;
  const timestamp = (left.oldestTs ?? "~").localeCompare(right.oldestTs ?? "~");
  return timestamp || left.path.localeCompare(right.path);
}

/** Inclusive local-day cutoff: `days=3` keeps today and the previous two buckets. */
export function retentionCutoff(now: Date, days: number): string {
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - Math.max(0, days - 1));
  return localDay(cutoff);
}

export function localDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Remove one file, tolerating only a concurrent deletion by another process. */
export async function removeLogFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

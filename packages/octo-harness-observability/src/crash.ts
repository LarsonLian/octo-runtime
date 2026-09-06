import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export interface CrashReporterOptions {
  directory: string;
  component: string;
  now?: () => Date;
  stderr?: (line: string) => void;
}

export interface CrashReporter {
  close(): void;
}

const SAFE_ERROR_NAMES = new Set([
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError"
]);

/** Install a passive monitor that preserves Node's ordinary fatal-error behavior. */
export function installCrashReporter(options: CrashReporterOptions): CrashReporter {
  validateComponent(options.component);
  const listener = (error: Error, origin: NodeJS.UncaughtExceptionOrigin): void => {
    try {
      writeMinimalCrashReport(options, error, origin);
    } catch (reportError) {
      const code = safeErrorCode(reportError) ?? "crash_report_failed";
      const stderr = options.stderr ?? (line => process.stderr.write(`${line}\n`));
      stderr(`[octo-harness logging.degraded] component=${options.component} reason=${code} sink=crash`);
    }
  };
  process.on("uncaughtExceptionMonitor", listener);
  return { close: () => process.removeListener("uncaughtExceptionMonitor", listener) };
}

/** Synchronously persist low-risk crash metadata before the process exits. */
export function writeMinimalCrashReport(
  options: CrashReporterOptions,
  error: unknown,
  origin: NodeJS.UncaughtExceptionOrigin = "uncaughtException"
): string {
  validateComponent(options.component);
  const now = options.now?.() ?? new Date();
  const root = resolve(options.directory);
  const crashDirectory = join(root, "crash");
  ensureSecureDirectorySync(crashDirectory, root);
  const report = {
    schema_version: 1,
    ts: now.toISOString(),
    event: "process.crash",
    component: options.component,
    pid: process.pid,
    origin,
    error: {
      name: safeErrorName(error),
      ...optionalErrorCode(error),
      stack_frames: safeStackFrames(error)
    },
    process: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch
    }
  };
  const timestamp = now.toISOString().replaceAll("-", "").replaceAll(":", "");
  const path = uniqueCrashPath(crashDirectory, `${options.component}-${timestamp}-${process.pid}`);
  writeSecureFileSync(path, `${JSON.stringify(report)}\n`);
  syncDirectorySync(crashDirectory);
  syncDirectorySync(root);
  return path;
}

function writeSecureFileSync(path: string, content: string): void {
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") throw new Error("secure crash report requires O_NOFOLLOW support");
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600
  );
  try {
    const stats = fstatSync(descriptor);
    const uid = process.getuid?.();
    if (!stats.isFile() || (uid !== undefined && stats.uid !== uid)) {
      throw new Error(`unsafe crash report owner or type: ${path}`);
    }
    const linked = lstatSync(path);
    if (linked.isSymbolicLink() || linked.dev !== stats.dev || linked.ino !== stats.ino) {
      throw new Error(`crash report changed during creation: ${path}`);
    }
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function ensureSecureDirectorySync(path: string, root: string): void {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`crash path escapes configured root: ${resolvedPath}`);
  }
  try {
    mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const paths = [resolvedRoot];
  let current = resolvedRoot;
  const descendant = relative(resolvedRoot, resolvedPath);
  for (const part of descendant ? descendant.split(sep) : []) {
    current = join(current, part);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    paths.push(current);
  }
  const uid = process.getuid?.();
  for (const candidate of paths) {
    const stats = lstatSync(candidate);
    if (stats.isSymbolicLink() || !stats.isDirectory() || (uid !== undefined && stats.uid !== uid)) {
      throw new Error(`unsafe crash directory owner or type: ${candidate}`);
    }
    chmodSync(candidate, 0o700);
  }
}

function syncDirectorySync(path: string): void {
  const directoryFlag = constants.O_DIRECTORY;
  const noFollow = constants.O_NOFOLLOW;
  if (typeof directoryFlag !== "number") throw new Error("directory synchronization is unavailable");
  if (typeof noFollow !== "number") throw new Error("secure directory synchronization is unavailable");
  const descriptor = openSync(path, constants.O_RDONLY | directoryFlag | noFollow);
  try {
    const stats = fstatSync(descriptor);
    const uid = process.getuid?.();
    if (!stats.isDirectory() || (uid !== undefined && stats.uid !== uid)) {
      throw new Error(`unsafe crash directory owner or type: ${path}`);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function uniqueCrashPath(directory: string, base: string): string {
  for (let shard = 0; shard < 1000; shard += 1) {
    const suffix = shard === 0 ? "" : `.${String(shard).padStart(3, "0")}`;
    const path = join(directory, `${base}${suffix}.json`);
    try {
      lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
      throw error;
    }
  }
  throw new Error("crash report shard limit reached");
}

function safeErrorName(error: unknown): string {
  if (!(error instanceof Error) || !SAFE_ERROR_NAMES.has(error.name)) return "Error";
  return error.name;
}

function safeErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : undefined;
}

function optionalErrorCode(error: unknown): { code: string } | Record<string, never> {
  const code = safeErrorCode(error);
  return code ? { code } : {};
}

function safeStackFrames(error: unknown): string[] {
  if (!(error instanceof Error)) return [];
  let stack: string | undefined;
  try {
    stack = error.stack;
  } catch {
    return [];
  }
  if (typeof stack !== "string") return [];
  return stack
    .split(/\r?\n/)
    .filter(frame => /^\s*at\s/.test(frame))
    .slice(0, 32)
    .map(frame => frame.trim().slice(0, 1024));
}

function validateComponent(component: string): void {
  if (!/^[a-z0-9-]+$/.test(component)) {
    throw new TypeError("crash reporter component must contain only lowercase letters, digits, and hyphens");
  }
}

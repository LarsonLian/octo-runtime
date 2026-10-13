import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, win32 } from "node:path";
import { EmbeddedHarnessError } from "./errors.js";

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MACHINE_PATTERN = /^machine_[0-9a-f-]{36}$/;

export interface MachineIdentity {
  schema_version: 1;
  machine_id: string;
}

export interface EmbeddedHomePaths {
  home: string;
  machineFile: string;
  run: string;
  socket: string;
  pidFile: string;
  ownerLock: string;
  sessionFile: string;
  supervisorState: string;
  shutdownFile: string;
}

export interface EmbeddedAccountPaths {
  accountKey: string;
  root: string;
  configFile: string;
  storeFile: string;
  logs: string;
}

export interface EmbeddedProfilePaths {
  name: string;
  root: string;
  configFile: string;
  identityFile: string;
  credentialFile: string;
}

export interface OwnerLock {
  nonce: string;
  release(): void;
}

export function resolveEmbeddedHome(
  appId: string,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; userHome?: string } = {}
): string {
  const slug = appSlug(appId);
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (!localAppData) {
      throw new EmbeddedHarnessError(
        "HOME_UNAVAILABLE",
        "home",
        false,
        "LOCALAPPDATA is required on Windows"
      );
    }
    return win32.join(localAppData, slug, "OctoHarness");
  }
  if (platform === "darwin")
    return join(userHome, "Library", "Application Support", slug, "octo-harness");
  return join(
    env.XDG_STATE_HOME?.trim() || join(userHome, ".local", "state"),
    slug,
    "octo-harness"
  );
}

export function embeddedHomePaths(
  homeInput: string,
  platform: NodeJS.Platform = process.platform
): EmbeddedHomePaths {
  const home = validateHome(homeInput, platform);
  const run = join(home, "run");
  const socket =
    platform === "win32"
      ? `\\\\.\\pipe\\octo-harness-embedded-${createHash("sha256").update(home.toLowerCase()).digest("hex").slice(0, 16)}`
      : join(home, "sockets", "octo-harness-daemon.sock");
  return {
    home,
    machineFile: join(home, "machine.json"),
    run,
    socket,
    pidFile: join(home, "octo-daemon.pid"),
    ownerLock: join(run, "embedded-owner.lock"),
    sessionFile: join(run, "embedded-session.json"),
    supervisorState: join(run, "embedded-supervisor.json"),
    shutdownFile: join(run, "embedded-shutdown")
  };
}

export function accountKeyFor(subjectType: string, subjectId: string): string {
  if (subjectType !== "user" || !subjectId.trim()) {
    throw new EmbeddedHarnessError(
      "SUBJECT_INVALID",
      "home",
      false,
      "a stable user subject is required"
    );
  }
  return base32Hash(`${subjectType}\0${subjectId.trim()}`, 20);
}

export function profileNameFor(appId: string, tenantId: string): string {
  if (!tenantId.trim())
    throw new EmbeddedHarnessError("TENANT_INVALID", "home", false, "tenant id is required");
  const name = `${appSlug(appId)}-${base32Hash(tenantId.trim(), 20)}`;
  if (!PROFILE_PATTERN.test(name)) {
    throw new EmbeddedHarnessError(
      "PROFILE_INVALID",
      "home",
      false,
      `generated profile is invalid: ${name}`
    );
  }
  return name;
}

export function accountPaths(paths: EmbeddedHomePaths, accountKey: string): EmbeddedAccountPaths {
  const root = join(paths.home, "accounts", accountKey);
  return {
    accountKey,
    root,
    configFile: join(root, "config.json"),
    storeFile: join(root, "state.db"),
    logs: join(root, "logs")
  };
}

export function profilePaths(account: EmbeddedAccountPaths, name: string): EmbeddedProfilePaths {
  if (!PROFILE_PATTERN.test(name))
    throw new EmbeddedHarnessError("PROFILE_INVALID", "home", false, `invalid profile: ${name}`);
  const root = join(account.root, name);
  return {
    name,
    root,
    configFile: join(root, "config.json"),
    identityFile: join(root, "identity", "runtime.json"),
    credentialFile: join(root, "credentials", "runtime-token.json")
  };
}

export function ensureEmbeddedHome(paths: EmbeddedHomePaths): MachineIdentity {
  for (const directory of [paths.home, paths.run, join(paths.home, "accounts")])
    mkdirSync(directory, { recursive: true });
  if (process.platform !== "win32") mkdirSync(dirname(paths.socket), { recursive: true });
  if (existsSync(paths.machineFile)) {
    const machine = readJson<MachineIdentity>(paths.machineFile);
    if (machine.schema_version !== 1 || !MACHINE_PATTERN.test(machine.machine_id)) {
      throw new EmbeddedHarnessError(
        "MACHINE_INVALID",
        "home",
        false,
        `invalid machine identity: ${paths.machineFile}`
      );
    }
    return machine;
  }
  const machine: MachineIdentity = { schema_version: 1, machine_id: `machine_${randomUUID()}` };
  writeJsonAtomic(paths.machineFile, machine);
  return machine;
}

export function ensureAccount(account: EmbeddedAccountPaths, profiles: readonly string[]): void {
  if (profiles.length === 0)
    throw new EmbeddedHarnessError(
      "TENANTS_EMPTY",
      "home",
      false,
      "at least one authorized tenant is required"
    );
  mkdirSync(account.logs, { recursive: true });
  for (const profile of profiles) {
    const paths = profilePaths(account, profile);
    mkdirSync(dirname(paths.identityFile), { recursive: true });
    mkdirSync(dirname(paths.credentialFile), { recursive: true });
  }
  const existing = existsSync(account.configFile)
    ? readJson<Record<string, unknown>>(account.configFile)
    : {};
  const currentDefault =
    typeof existing.default_profile === "string" ? existing.default_profile : undefined;
  const defaultProfile =
    currentDefault && profiles.includes(currentDefault) ? currentDefault : [...profiles].sort()[0];
  writeJsonAtomic(account.configFile, {
    ...existing,
    schema_version: 1,
    default_profile: defaultProfile,
    channel: "stable"
  });
}

export function acquireOwnerLock(paths: EmbeddedHomePaths): OwnerLock {
  mkdirSync(paths.run, { recursive: true });
  const nonce = randomUUID();
  const acquire = (): number => openSync(paths.ownerLock, "wx", 0o600);
  let fd: number;
  try {
    fd = acquire();
  } catch (error) {
    if (!isNodeError(error, "EEXIST") || lockOwnerAlive(paths.ownerLock)) {
      throw new EmbeddedHarnessError(
        "HOME_LOCKED",
        "home",
        false,
        "Embedded Harness Home is owned by another process",
        { cause: error }
      );
    }
    rmSync(paths.ownerLock, { force: true });
    fd = acquire();
  }
  writeFileSync(
    fd,
    `${JSON.stringify({ schema_version: 1, pid: process.pid, nonce, created_at: new Date().toISOString() })}\n`
  );
  fsyncSync(fd);
  let released = false;
  return {
    nonce,
    release(): void {
      if (released) return;
      released = true;
      closeSync(fd);
      try {
        const current = readJson<{ nonce?: unknown }>(paths.ownerLock);
        if (current.nonce === nonce) rmSync(paths.ownerLock, { force: true });
      } catch {
        // A missing lock is already released; a replaced lock belongs to another session.
      }
    }
  };
}

export function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new EmbeddedHarnessError("LOCAL_STATE_INVALID", "home", false, `cannot read ${path}`, {
      cause: error
    });
  }
}

export function readJsonOptional<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return readJson<T>(path);
}

export function writeJsonAtomic(path: string, value: unknown, secret = false): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", secret ? 0o600 : 0o644);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (secret && process.platform !== "win32") chmodSync(temporary, 0o600);
  renameWithRetry(temporary, path);
  if (secret && process.platform !== "win32") chmodSync(path, 0o600);
}

export function removeFile(path: string): void {
  rmSync(path, { force: true });
}

function validateHome(homeInput: string, platform: NodeJS.Platform): string {
  const pathApi = platform === "win32" ? win32 : { isAbsolute, resolve, parse };
  if (!homeInput.trim() || !pathApi.isAbsolute(homeInput)) {
    throw new EmbeddedHarnessError(
      "HOME_INVALID",
      "home",
      false,
      "Embedded Harness Home must be an absolute path"
    );
  }
  const home = pathApi.resolve(homeInput);
  const root = pathApi.parse(home).root;
  if (home === root)
    throw new EmbeddedHarnessError(
      "HOME_INVALID",
      "home",
      false,
      "filesystem root cannot be used as Embedded Harness Home"
    );
  if (platform === "win32") {
    const input = homeInput.replaceAll("/", "\\");
    if (input.startsWith("\\\\") || input.startsWith("\\\\?\\") || /^[A-Za-z]:[^\\]/.test(input)) {
      throw new EmbeddedHarnessError(
        "HOME_UNSUPPORTED",
        "home",
        false,
        "Windows Embedded Harness Home must be a local absolute path"
      );
    }
  }
  return home;
}

function appSlug(appId: string): string {
  const slug = appId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!slug || !/^[a-z0-9]/.test(slug)) {
    throw new EmbeddedHarnessError(
      "APP_ID_INVALID",
      "home",
      false,
      "appId must contain an ASCII letter or digit"
    );
  }
  return slug;
}

function base32Hash(value: string, length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = createHash("sha256").update(value).digest();
  let bits = 0;
  let buffer = 0;
  let encoded = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && encoded.length < length) {
      encoded += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (encoded.length === length) break;
  }
  return encoded;
}

function renameWithRetry(source: string, target: string): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      renameSync(source, target);
      return;
    } catch (error) {
      lastError = error;
      if (!isNodeError(error, "EPERM") && !isNodeError(error, "EBUSY")) break;
      const until = Date.now() + 25 * (attempt + 1);
      while (Date.now() < until) {
        // Bounded synchronous retry keeps initialization atomic without a second async API.
      }
    }
  }
  rmSync(source, { force: true });
  throw new EmbeddedHarnessError(
    "WRITE_FAILED",
    "home",
    true,
    `cannot atomically replace ${target}`,
    { cause: lastError }
  );
}

function lockOwnerAlive(path: string): boolean {
  try {
    const lock = readJson<{ pid?: unknown }>(path);
    if (!Number.isSafeInteger(lock.pid) || Number(lock.pid) <= 0) return false;
    process.kill(Number(lock.pid), 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface HarnessHomeConfiguration {
  schema_version: 1;
  default_profile: string;
  enabled_profiles: string[];
  channel: "stable" | "beta";
}

export interface ProfileConfiguration {
  schema_version: 1;
  profile: string;
  server_url: string;
  agent_work_url?: string;
  tenant_id?: string;
  subject_id?: string;
  runtime_name: string;
}

export interface RuntimeIdentity {
  schema_version: 1;
  runtime_id: string;
  credential_id: string;
  system_id: string;
  device_id?: string;
  workspace_id?: string;
  octo_space_id?: string;
  enrolled_at: string;
}

export interface RuntimeCredential {
  schema_version: 1;
  access_token?: string;
  issued_at: string;
  expires_at?: string;
}

export interface PendingEnrollment {
  schema_version: 1;
  attempt_id: string;
  system_id: string;
  server_url: string;
  created_at: string;
}

export interface UpdateJournal {
  schema_version: 1;
  phase: "prepared" | "recovered";
  profile: string;
  service_was_running: boolean;
  prepared_at: string;
  recovered_at?: string;
}

export interface HarnessPaths {
  home: string;
  rootConfig: string;
  profileRoot: string;
  profileConfig: string;
  identity: string;
  credential: string;
  pendingEnrollment: string;
  updateJournal: string;
  setupLock: string;
  pid: string;
  socket: string;
  logs: string;
}

export function defaultHarnessHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (env.OCTO_HARNESS_HOME?.trim()) return resolve(env.OCTO_HARNESS_HOME.trim());
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) return resolve(localAppData, "OctoHarness");
  }
  return resolve(env.HOME?.trim() || homedir(), ".octo-harness");
}

export function harnessPaths(home: string, profile: string): HarnessPaths {
  assertProfileName(profile);
  const absoluteHome = resolve(home);
  const profileRoot = join(absoluteHome, "profiles", profile);
  return {
    home: absoluteHome,
    rootConfig: join(absoluteHome, "config.json"),
    profileRoot,
    profileConfig: join(profileRoot, "config.json"),
    identity: join(absoluteHome, "identity", "runtime.json"),
    credential: join(absoluteHome, "credentials", "runtime-token.json"),
    pendingEnrollment: join(absoluteHome, "setup", "pending-enrollment.json"),
    updateJournal: join(absoluteHome, "run", "update.json"),
    setupLock: join(absoluteHome, "run", "setup.lock"),
    pid: join(absoluteHome, "octo-daemon.pid"),
    socket: process.platform === "win32"
      ? `\\\\.\\pipe\\octo-harness-${portableHomeId(absoluteHome)}`
      : join(absoluteHome, "sockets", "octo-harness-daemon.sock"),
    logs: join(absoluteHome, "logs")
  };
}

export function assertProfileName(profile: string): void {
  if (!PROFILE_NAME.test(profile)) {
    throw new Error("--profile must contain only letters, digits, dot, underscore, or hyphen (maximum 64 characters)");
  }
}

export async function prepareHarnessDirectories(paths: HarnessPaths): Promise<void> {
  await Promise.all([
    secureDirectory(paths.home),
    secureDirectory(join(paths.home, "run")),
    secureDirectory(join(paths.home, "sockets")),
    secureDirectory(paths.logs),
    secureDirectory(dirname(paths.profileConfig)),
    secureDirectory(dirname(paths.identity)),
    secureDirectory(dirname(paths.credential)),
    secureDirectory(dirname(paths.pendingEnrollment))
  ]);
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    if (error instanceof SyntaxError) throw new Error(`invalid JSON file: ${path}`, { cause: error });
    throw error;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(path: string, value: string): Promise<void> {
  await writeFileAtomic(path, value);
}

export async function removeIfPresent(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function withSetupLock<T>(paths: HarnessPaths, action: () => Promise<T>): Promise<T> {
  await secureDirectory(dirname(paths.setupLock));
  const release = await acquireProcessLock(paths.setupLock);
  try {
    return await action();
  } finally {
    await release();
  }
}

export async function reconcileHomeConfiguration(
  paths: HarnessPaths,
  profile: string,
  channel: "stable" | "beta"
): Promise<HarnessHomeConfiguration> {
  const existing = await readJsonFile<HarnessHomeConfiguration>(paths.rootConfig);
  assertHomeConfiguration(existing);
  assertSingleHomeProfile(existing, profile);
  const value: HarnessHomeConfiguration = {
    schema_version: 1,
    default_profile: profile,
    enabled_profiles: [profile],
    channel
  };
  await writeJsonAtomic(paths.rootConfig, value);
  return value;
}

export function assertHomeConfiguration(
  configuration: HarnessHomeConfiguration | undefined
): void {
  if (!configuration) return;
  if (configuration.schema_version !== 1) {
    throw new Error("unsupported Harness Home config schema");
  }
  assertProfileName(configuration.default_profile);
  if (!Array.isArray(configuration.enabled_profiles) || configuration.enabled_profiles.length === 0) {
    throw new Error("Harness Home must contain at least one enabled profile");
  }
  for (const profile of configuration.enabled_profiles) assertProfileName(profile);
  if (!configuration.enabled_profiles.includes(configuration.default_profile)) {
    throw new Error("Harness Home default profile must be enabled");
  }
  if (configuration.enabled_profiles.length !== 1) {
    throw new Error("Harness Home must contain exactly one enabled profile");
  }
}

export function assertSingleHomeProfile(
  configuration: HarnessHomeConfiguration | undefined,
  requestedProfile: string
): void {
  assertHomeConfiguration(configuration);
  if (!configuration) return;
  if (configuration.default_profile !== requestedProfile || configuration.enabled_profiles[0] !== requestedProfile) {
    throw new Error(
      `Harness Home is already bound to profile ${configuration.default_profile}; use a different --home for ${requestedProfile}`
    );
  }
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
}

async function writeFileAtomic(path: string, value: string): Promise<void> {
  await secureDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function acquireProcessLock(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`, "utf8");
      await handle.close();
      return async () => {
        const owner = await readLockOwner(path);
        if (owner === process.pid) await rm(path, { force: true });
      };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const owner = await readLockOwner(path);
      if (owner !== undefined && processAlive(owner)) {
        throw new Error(`another setup process is active (pid ${owner})`, { cause: error });
      }
      await rm(path, { force: true });
    }
  }
  throw new Error("could not acquire setup lock");
}

async function readLockOwner(path: string): Promise<number | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    return typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0
      ? value.pid
      : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

function portableHomeId(home: string): string {
  let hash = 2166136261;
  for (const character of home.toLowerCase()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, open, readFile, rename, rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { runtimeControlEndpoint } from "@mininglamp-oss/octo-runtime-daemon/runtime-endpoint";

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED_PROFILE_NAMES = new Set([
  "config.json",
  "credentials",
  "extras",
  "identity",
  "machine.json",
  "logs",
  "octo-daemon.pid",
  "profiles",
  "run",
  "setup",
  "sockets",
  "state.db"
]);

export interface RuntimeHomeConfiguration {
  schema_version: 1;
  default_profile: string;
  channel: "stable" | "beta";
}

export interface ProfileConfiguration {
  schema_version: 1;
  profile: string;
  server_url: string;
  agent_work_url?: string;
  octo_space_id?: string;
  runtime_name: string;
  agent_identity?: string;
  agent_name?: string;
  adapters?: Record<
    string,
    {
      execution: {
        provider_options: Record<string, string>;
        credential_ref?: string;
        stream_limits?: Record<string, number>;
      };
    }
  >;
}

export interface RuntimeIdentity {
  schema_version: 1;
  profile: string;
  runtime_id: string;
  credential_id: string;
  octo_space_id?: string;
  enrolled_at: string;
}

export interface MachineIdentity {
  schema_version: 1;
  machine_id: string;
}

export interface RuntimeCredential {
  schema_version: 1;
  access_token?: string;
  issued_at: string;
  expires_at?: string;
}

export interface RuntimePaths {
  home: string;
  rootConfig: string;
  machine: string;
  profileRoot: string;
  profileConfig: string;
  identity: string;
  credential: string;
  openclawRoot: string;
  setupLock: string;
  pid: string;
  socket: string;
  logs: string;
}

export function defaultRuntimeHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (env.OCTO_RUNTIME_HOME?.trim()) return resolve(env.OCTO_RUNTIME_HOME.trim());
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) return resolve(localAppData, "OctoRuntime");
  }
  return resolve(env.HOME?.trim() || homedir(), ".octo-runtime");
}

export function runtimePaths(
  home: string,
  profile: string,
  platform: NodeJS.Platform = process.platform
): RuntimePaths {
  assertProfileName(profile);
  const absoluteHome = resolve(home);
  const profileRoot = join(absoluteHome, profile);
  return {
    home: absoluteHome,
    rootConfig: join(absoluteHome, "config.json"),
    machine: join(absoluteHome, "machine.json"),
    profileRoot,
    profileConfig: join(profileRoot, "config.json"),
    identity: join(profileRoot, "identity", "runtime.json"),
    credential: join(profileRoot, "credentials", "runtime-token.json"),
    openclawRoot: join(profileRoot, "adapters", "openclaw"),
    setupLock: join(absoluteHome, "run", "setup.lock"),
    pid: join(absoluteHome, "octo-daemon.pid"),
    socket: runtimeControlEndpoint(absoluteHome, platform),
    logs: join(absoluteHome, "logs")
  };
}

/** Call under the Home setup lock; this label is shared by all profiles, not an authentication key. */
export async function ensureMachineIdentity(paths: RuntimePaths): Promise<MachineIdentity> {
  const existing = await readJsonFile<MachineIdentity>(paths.machine);
  if (existing !== undefined) {
    if (
      !existing ||
      existing.schema_version !== 1 ||
      !/^machine_[0-9a-f-]{36}$/.test(existing.machine_id)
    ) {
      throw new Error(`invalid machine identity: ${paths.machine}`);
    }
    return existing;
  }
  const machine: MachineIdentity = { schema_version: 1, machine_id: `machine_${randomUUID()}` };
  await writeJsonAtomic(paths.machine, machine);
  return machine;
}

export function assertProfileName(profile: string): void {
  if (typeof profile !== "string" || !PROFILE_NAME.test(profile)) {
    throw new Error(
      "--profile must start with a letter or digit and contain only letters, digits, dot, underscore, or hyphen (maximum 128 characters)"
    );
  }
  if (RESERVED_PROFILE_NAMES.has(profile.toLowerCase())) {
    throw new Error(`--profile conflicts with Runtime Home infrastructure: ${profile}`);
  }
}

export async function prepareRuntimeDirectories(paths: RuntimePaths): Promise<void> {
  await Promise.all([
    secureDirectory(paths.home),
    secureDirectory(join(paths.home, "run")),
    secureDirectory(join(paths.home, "sockets")),
    secureDirectory(paths.logs),
    secureDirectory(dirname(paths.profileConfig)),
    secureDirectory(dirname(paths.identity)),
    secureDirectory(dirname(paths.credential)),
    secureDirectory(paths.openclawRoot)
  ]);
}

/** Upgrade the former Home-global Runtime files and profiles/<name> layout. */
export async function migrateLegacyProfileLayout(
  paths: RuntimePaths,
  daemonRunning = false
): Promise<boolean> {
  const legacyProfileRoot = join(paths.home, "profiles", basename(paths.profileRoot));
  const legacyGlobalFiles =
    basename(paths.profileRoot) === "default"
      ? [
          [join(paths.home, "identity", "runtime.json"), paths.identity],
          [join(paths.home, "credentials", "runtime-token.json"), paths.credential]
        ]
      : [];
  const hasLegacyProfile = await pathExists(legacyProfileRoot);
  const hasLegacyGlobal = (
    await Promise.all(legacyGlobalFiles.map(([source]) => pathExists(source)))
  ).some(Boolean);
  if (!hasLegacyProfile && !hasLegacyGlobal) return false;
  if (daemonRunning) throw new Error("stop the daemon before migrating the legacy profile layout");

  const backupRoot = join(
    paths.home,
    "run",
    "profile-layout-v1-backup",
    basename(paths.profileRoot)
  );
  await secureDirectory(dirname(paths.profileRoot));
  if (hasLegacyProfile) {
    if (await pathExists(paths.profileRoot)) {
      await moveToBackup(legacyProfileRoot, join(backupRoot, "nested-profile"));
    } else {
      await rename(legacyProfileRoot, paths.profileRoot);
    }
  }
  await secureDirectory(paths.profileRoot);
  for (const [source, target] of legacyGlobalFiles) {
    if (!(await pathExists(source))) continue;
    if (await pathExists(target)) {
      await moveToBackup(
        target,
        join(backupRoot, "overridden", target.slice(paths.profileRoot.length + 1))
      );
    }
    await secureDirectory(dirname(target));
    await rename(source, target);
  }
  for (const directory of [
    join(paths.home, "identity"),
    join(paths.home, "credentials"),
    join(paths.home, "setup"),
    join(paths.home, "profiles")
  ]) {
    await removeEmptyDirectory(directory);
  }
  await writeJsonAtomic(join(paths.home, "run", "profile-layout-v1.json"), {
    schema_version: 1,
    profile: basename(paths.profileRoot),
    migrated_at: new Date().toISOString(),
    backup: backupRoot
  });
  return true;
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    if (error instanceof SyntaxError)
      throw new Error(`invalid JSON file: ${path}`, { cause: error });
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

export async function withSetupLock<T>(paths: RuntimePaths, action: () => Promise<T>): Promise<T> {
  await secureDirectory(dirname(paths.setupLock));
  const release = await acquireProcessLock(paths.setupLock);
  try {
    return await action();
  } finally {
    await release();
  }
}

export async function reconcileHomeConfiguration(
  paths: RuntimePaths,
  profile: string,
  channel: "stable" | "beta"
): Promise<RuntimeHomeConfiguration> {
  const existing = await readJsonFile<RuntimeHomeConfiguration>(paths.rootConfig);
  assertHomeConfiguration(existing);
  const value: RuntimeHomeConfiguration = {
    schema_version: 1,
    default_profile: existing?.default_profile ?? profile,
    channel
  };
  await writeJsonAtomic(paths.rootConfig, value);
  return value;
}

export function assertHomeConfiguration(configuration: RuntimeHomeConfiguration | undefined): void {
  if (!configuration) return;
  if (configuration.schema_version !== 1) {
    throw new Error("unsupported Runtime Home config schema");
  }
  assertProfileName(configuration.default_profile);
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
}

async function moveToBackup(source: string, target: string): Promise<void> {
  if (await pathExists(target))
    throw new Error(`profile migration backup already exists: ${target}`);
  await secureDirectory(dirname(target));
  await rename(source, target);
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT") && !isNodeError(error, "ENOTEMPTY")) throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
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
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
        "utf8"
      );
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

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

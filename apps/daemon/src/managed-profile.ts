import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentWorkRuntimeOptions } from "./agent-work-runtime.js";

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_PROFILE_NAMES = new Set([
  "config.json",
  "credentials",
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

interface HarnessHomeConfiguration {
  schema_version?: unknown;
  default_profile?: unknown;
}

interface ProfileConfiguration {
  schema_version?: unknown;
  profile?: unknown;
  agent_work_url?: unknown;
  tenant_id?: unknown;
  subject_id?: unknown;
  runtime_name?: unknown;
}

interface RuntimeIdentity {
  schema_version?: unknown;
  runtime_id?: unknown;
}

interface RuntimeCredential {
  schema_version?: unknown;
  access_token?: unknown;
}

/** Load every enabled Home-bound Runtime. Secrets never enter service definitions or argv. */
export function loadManagedAgentWorks(
  home: string,
  requestedProfile?: string
): AgentWorkRuntimeOptions[] | undefined {
  const root = readJsonOptional<HarnessHomeConfiguration>(join(home, "config.json"));
  if (!root) return undefined;
  if (root.schema_version !== 1) throw new Error("unsupported Harness Home config schema");
  const defaultProfile = requiredString(root.default_profile, "default_profile");
  const profiles = discoverProfiles(home);
  if (!profiles.includes(defaultProfile)) throw new Error(`default profile ${defaultProfile} is missing`);
  if (requestedProfile && !profiles.includes(requestedProfile)) {
    throw new Error(`managed profile ${requestedProfile} does not exist in this Harness Home`);
  }
  const orderedProfiles = [defaultProfile, ...profiles.filter(profile => profile !== defaultProfile)];
  const runtimes = orderedProfiles
    .map(profile => loadManagedProfile(home, profile))
    .filter((runtime): runtime is AgentWorkRuntimeOptions => runtime !== undefined);
  assertUniqueRuntimeBindings(runtimes);
  return runtimes;
}

function loadManagedProfile(home: string, profile: string): AgentWorkRuntimeOptions | undefined {
  if (!isProfileName(profile)) {
    throw new Error(`Harness Home profile is invalid: ${profile}`);
  }
  const profileRoot = join(home, profile);
  const config = readJsonRequired<ProfileConfiguration>(join(profileRoot, "config.json"));
  const identity = readJsonRequired<RuntimeIdentity>(join(profileRoot, "identity", "runtime.json"));
  if (config.schema_version !== 1 || config.profile !== profile) throw new Error(`managed profile ${profile} is invalid`);
  if (identity.schema_version !== 1) throw new Error(`managed Runtime identity for ${profile} is invalid`);
  const baseUrl = optionalString(config.agent_work_url);
  if (!baseUrl) return undefined;
  const credential = readJsonRequired<RuntimeCredential>(join(profileRoot, "credentials", "runtime-token.json"));
  if (credential.schema_version !== 1) throw new Error(`managed Runtime credential for ${profile} is invalid`);
  return {
    profile,
    baseUrl,
    token: requiredString(credential.access_token, "access_token"),
    runtimeId: requiredString(identity.runtime_id, "runtime_id"),
    runtimeName: optionalString(config.runtime_name) ?? "octo-harness-local",
    storePath: join(profileRoot, "agent-work.db"),
    channelContext: {
      store: "sqlite",
      projection: "delta",
      providerPersistence: "append_only",
      storePath: join(profileRoot, "channel-context.db")
    }
  };
}

function assertUniqueRuntimeBindings(runtimes: AgentWorkRuntimeOptions[]): void {
  const bindings = new Map<string, string>();
  for (const runtime of runtimes) {
    if (!runtime.runtimeId) continue;
    const binding = `${new URL(runtime.baseUrl).toString()}\u0000${runtime.runtimeId}`;
    const existing = bindings.get(binding);
    if (existing) {
      throw new Error(`profiles ${existing} and ${runtime.profile} use the same Agent Work Runtime binding`);
    }
    bindings.set(binding, runtime.profile ?? "default");
  }
}

function discoverProfiles(home: string): string[] {
  return readdirSync(home, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(isProfileName)
    .filter(profile => existsSync(join(home, profile, "config.json")))
    .sort();
}

function isProfileName(profile: string): boolean {
  return PROFILE_NAME.test(profile) && !RESERVED_PROFILE_NAMES.has(profile.toLowerCase());
}

function readJsonOptional<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw new Error(`cannot read managed config ${path}`, { cause: error });
  }
}

function readJsonRequired<T>(path: string): T {
  const value = readJsonOptional<T>(path);
  if (!value) throw new Error(`managed setup file is missing: ${path}`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`managed ${name} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

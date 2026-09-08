import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentWorkRuntimeOptions } from "./agent-work-runtime.js";

interface HarnessHomeConfiguration {
  schema_version?: unknown;
  default_profile?: unknown;
  enabled_profiles?: unknown;
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
  system_id?: unknown;
}

interface RuntimeCredential {
  schema_version?: unknown;
  access_token?: unknown;
}

/** Load the Home-bound Runtime. Secrets never enter service definitions or argv. */
export function loadManagedAgentWork(
  home: string,
  requestedProfile?: string
): AgentWorkRuntimeOptions | undefined {
  const root = readJsonOptional<HarnessHomeConfiguration>(join(home, "config.json"));
  if (!root) return undefined;
  if (root.schema_version !== 1) throw new Error("unsupported Harness Home config schema");
  const defaultProfile = requiredString(root.default_profile, "default_profile");
  const enabledProfiles = profileList(root.enabled_profiles);
  if (enabledProfiles.length !== 1 || enabledProfiles[0] !== defaultProfile) {
    throw new Error("Harness Home must contain exactly one enabled profile");
  }
  if (!enabledProfiles.includes(defaultProfile)) {
    throw new Error("Harness Home default profile must be enabled");
  }
  if (requestedProfile && !enabledProfiles.includes(requestedProfile)) {
    throw new Error(`managed profile ${requestedProfile} is not enabled in this Harness Home`);
  }
  return loadManagedProfile(home, defaultProfile);
}

function loadManagedProfile(home: string, profile: string): AgentWorkRuntimeOptions | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) {
    throw new Error(`Harness Home profile is invalid: ${profile}`);
  }
  const profileRoot = join(home, "profiles", profile);
  const config = readJsonRequired<ProfileConfiguration>(join(profileRoot, "config.json"));
  const identity = readJsonRequired<RuntimeIdentity>(join(home, "identity", "runtime.json"));
  if (config.schema_version !== 1 || config.profile !== profile) throw new Error(`managed profile ${profile} is invalid`);
  if (identity.schema_version !== 1) throw new Error(`managed Runtime identity for ${profile} is invalid`);
  const baseUrl = optionalString(config.agent_work_url);
  if (!baseUrl) return undefined;
  const credential = readJsonRequired<RuntimeCredential>(join(home, "credentials", "runtime-token.json"));
  if (credential.schema_version !== 1) throw new Error(`managed Runtime credential for ${profile} is invalid`);
  return {
    profile,
    baseUrl,
    token: requiredString(credential.access_token, "access_token"),
    runtimeId: requiredString(identity.runtime_id, "runtime_id"),
    runtimeName: optionalString(config.runtime_name) ?? "octo-harness-local",
    fingerprint: requiredString(identity.system_id, "system_id"),
    storePath: join(home, "agent-work.db"),
    channelContext: {
      store: "sqlite",
      projection: "delta",
      providerPersistence: "append_only",
      storePath: join(home, "channel-context.db")
    }
  };
}

function profileList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("managed enabled_profiles must contain at least one profile");
  }
  const profiles = value.map((profile, index) => requiredString(profile, `enabled_profiles[${index}]`));
  for (const profile of profiles) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) {
      throw new Error(`managed enabled profile is invalid: ${profile}`);
    }
  }
  return [...new Set(profiles)];
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

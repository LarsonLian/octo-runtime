import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentWorkRuntimeOptions } from "./agent-work-runtime.js";
import type { BusinessServiceBinding } from "./tool-authorizations.js";

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
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
  business_service_bindings?: unknown;
  schema_version?: unknown;
  profile?: unknown;
  agent_work_url?: unknown;
  octo_space_id?: unknown;
  runtime_name?: unknown;
  adapters?: unknown;
}

interface RuntimeIdentity {
  schema_version?: unknown;
  profile?: unknown;
  runtime_id?: unknown;
}

interface RuntimeCredential {
  schema_version?: unknown;
  access_token?: unknown;
}

interface AdapterExecutionManifest {
  provider_agent_id?: unknown;
  provider_options?: unknown;
  credential_ref?: unknown;
}

interface AdapterCredentialManifest {
  schema_version?: unknown;
  provider_options?: unknown;
}

/** Load every enabled Home-bound Runtime. Secrets never enter service definitions or argv. */
export function loadManagedAgentWorks(
  home: string,
  requestedProfile?: string
): AgentWorkRuntimeOptions[] | undefined {
  const root = readJsonOptional<HarnessHomeConfiguration>(join(home, "config.json"));
  if (!root) return undefined;
  const profiles = discoverProfiles(home);
  if (requestedProfile && !profiles.includes(requestedProfile)) {
    throw new Error(`managed profile ${requestedProfile} does not exist in this Harness Home`);
  }
  return loadManagedAgentWorksFromRoot(home, profiles);
}

/** Load only an explicit allowlist from a normal profile root. */
export function loadManagedAgentWorksFromRoot(
  rootPath: string,
  profiles: readonly string[],
  options: { discoverLocalOpenClaw?: boolean } = {}
): AgentWorkRuntimeOptions[] {
  const root = readJsonRequired<HarnessHomeConfiguration>(join(rootPath, "config.json"));
  if (root.schema_version !== 1) throw new Error("unsupported Harness Home config schema");
  const defaultProfile = requiredString(root.default_profile, "default_profile");
  const uniqueProfiles = [...new Set(profiles)];
  if (!uniqueProfiles.includes(defaultProfile)) throw new Error(`default profile ${defaultProfile} is missing`);
  for (const profile of uniqueProfiles) {
    if (!isProfileName(profile)) throw new Error(`Harness Home profile is invalid: ${profile}`);
  }
  const orderedProfiles = [defaultProfile, ...uniqueProfiles.filter(profile => profile !== defaultProfile)];
  const runtimes = orderedProfiles
    .map(profile => loadManagedProfile(rootPath, profile, options))
    .filter((runtime): runtime is AgentWorkRuntimeOptions => runtime !== undefined);
  assertUniqueRuntimeBindings(runtimes);
  return runtimes;
}

function loadManagedProfile(home: string, profile: string, options: { discoverLocalOpenClaw?: boolean }): AgentWorkRuntimeOptions | undefined {
  if (!isProfileName(profile)) {
    throw new Error(`Harness Home profile is invalid: ${profile}`);
  }
  const profileRoot = join(home, profile);
  const config = readJsonRequired<ProfileConfiguration>(join(profileRoot, "config.json"));
  const identity = readJsonRequired<RuntimeIdentity>(join(profileRoot, "identity", "runtime.json"));
  if (config.schema_version !== 1 || config.profile !== profile) throw new Error(`managed profile ${profile} is invalid`);
  if (identity.schema_version !== 1 || identity.profile !== profile) throw new Error(`managed Runtime identity for ${profile} is invalid`);
  const baseUrl = optionalString(config.agent_work_url);
  if (!baseUrl) return undefined;
  const credential = readJsonRequired<RuntimeCredential>(join(profileRoot, "credentials", "runtime-token.json"));
  if (credential.schema_version !== 1) throw new Error(`managed Runtime credential for ${profile} is invalid`);
  const adapterConfigurations = readAdapterConfigurations(profileRoot, config.adapters, options.discoverLocalOpenClaw);
  return {
    profile,
    baseUrl,
    token: requiredString(credential.access_token, "access_token"),
    runtimeId: requiredString(identity.runtime_id, "runtime_id"),
    runtimeName: optionalString(config.runtime_name) ?? "octo-harness-local",
    businessServiceBindings: readBusinessServiceBindings(config.business_service_bindings),
    storePath: join(profileRoot, "agent-work.db"),
    channelContext: {
      store: "sqlite",
      projection: "delta",
      providerPersistence: "append_only",
      storePath: join(profileRoot, "channel-context.db")
    },
    ...(Object.keys(adapterConfigurations).length ? { adapterConfigurations } : {})
  };
}

function readAdapterConfigurations(
  profileRoot: string,
  adaptersValue: unknown,
  discoverLocalOpenClaw = false
): NonNullable<AgentWorkRuntimeOptions["adapterConfigurations"]> {
  const adapters = objectValue(adaptersValue);
  if (!adapters) return {};
  return Object.fromEntries(Object.entries(adapters)
    .filter(([type]) => !discoverLocalOpenClaw || type !== "openclaw")
    .map(([adapterType, value]) => {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(adapterType)) {
      throw new Error(`managed adapter type is invalid: ${adapterType}`);
    }
    const adapter = objectValue(value);
    const execution = objectValue(adapter?.execution) as AdapterExecutionManifest | undefined;
    if (!execution) throw new Error(`managed ${adapterType} adapter execution manifest is missing`);
    const publicOptions = stringRecord(execution.provider_options, `${adapterType} provider_options`);
    assertNoCredentialLikeOptions(publicOptions, adapterType);
    const credentialRef = optionalString(execution.credential_ref);
    const credentialOptions = credentialRef
      ? readCredentialOptions(profileRoot, credentialRef, adapterType)
      : {};
    if (Object.hasOwn(execution, "managed_workspace")) throw new TypeError("LOCAL_PLUGIN_CONFIGURATION_REQUIRED");
    return [adapterType, {
      ...(optionalString(execution.provider_agent_id)
        ? { providerAgentId: optionalString(execution.provider_agent_id) }
        : {}),
      providerOptions: { ...publicOptions, ...credentialOptions }
    }];
  }));
}

function readBusinessServiceBindings(value: unknown): Partial<Record<"task" | "discussion", BusinessServiceBinding>> {
  if (value === undefined) return {};
  const entries = objectValue(value);
  if (!entries || Object.keys(entries).some(key => !["task", "discussion"].includes(key))) throw new TypeError("BUSINESS_SERVICE_BINDING_INVALID");
  const result: Partial<Record<"task" | "discussion", BusinessServiceBinding>> = {};
  for (const kind of ["task", "discussion"] as const) {
    if (entries[kind] === undefined) continue;
    const binding = objectValue(entries[kind]);
    if (!binding || Object.keys(binding).some(key => !["serviceSubjectId", "url"].includes(key))
      || typeof binding.serviceSubjectId !== "string" || !binding.serviceSubjectId || binding.serviceSubjectId.length > 96 || typeof binding.url !== "string") throw new TypeError("BUSINESS_SERVICE_BINDING_INVALID");
    const url = new URL(binding.url);
    if (url.username || url.password || url.hash || !["http:", "https:"].includes(url.protocol)) throw new TypeError("BUSINESS_SERVICE_BINDING_INVALID");
    result[kind] = { serviceSubjectId: binding.serviceSubjectId, url: url.href };
  }
  return result;
}

function readCredentialOptions(profileRoot: string, credentialRef: string, adapterType: string): Record<string, string> {
  const credentialsRoot = realpathSync(join(profileRoot, "credentials"));
  const credentialPath = realpathSync(resolve(profileRoot, credentialRef));
  const relativeCredential = relative(credentialsRoot, credentialPath);
  if (relativeCredential.startsWith("..") || isAbsolute(relativeCredential)) {
    throw new Error(`managed ${adapterType} credential_ref resolves outside the profile credentials directory`);
  }
  const credential = readJsonRequired<AdapterCredentialManifest>(credentialPath);
  if (credential.schema_version !== 1) throw new Error(`managed ${adapterType} credential is invalid`);
  return stringRecord(credential.provider_options, `${adapterType} credential provider_options`);
}

function stringRecord(value: unknown, name: string): Record<string, string> {
  const record = objectValue(value);
  if (!record) throw new Error(`managed ${name} is required`);
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, requiredString(entry, `${name}.${key}`)]));
}

function assertNoCredentialLikeOptions(options: Record<string, string>, adapterType: string): void {
  for (const key of Object.keys(options)) {
    if (/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL)/i.test(key)) {
      throw new Error(`managed ${adapterType} public provider_options contains credential-like key ${key}`);
    }
  }
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

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

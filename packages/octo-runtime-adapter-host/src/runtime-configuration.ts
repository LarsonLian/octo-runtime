import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AdapterProbeOptions } from "@mininglamp-oss/octo-runtime-adapter-sdk";
interface AdapterExecutionManifest {
  provider_options?: unknown;
  credential_ref?: unknown;
}
interface AdapterCredentialManifest {
  schema_version?: unknown;
  provider_options?: unknown;
}
export function readAdapterConfigurations(
  profileRoot: string,
  adaptersValue: unknown
): Record<string, AdapterProbeOptions> {
  const adapters = objectValue(adaptersValue);
  const connections = { openclaw: { providerOptions: { OPENCLAW_RUNTIME_ROOT: profileRoot } } };
  if (!adapters) return connections;
  if (adapters.openclaw !== undefined)
    throw new Error(
      "OpenClaw uses adapters/openclaw/connection.json; remove the obsolete external binding and configure this Runtime connection"
    );
  return {
    ...connections,
    ...Object.fromEntries(
      Object.entries(adapters).map(([adapterType, value]) => {
        if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(adapterType)) {
          throw new Error(`managed adapter type is invalid: ${adapterType}`);
        }
        const adapter = objectValue(value);
        const execution = objectValue(adapter?.execution) as AdapterExecutionManifest | undefined;
        if (!execution)
          throw new Error(`managed ${adapterType} adapter execution manifest is missing`);
        const publicOptions = stringRecord(
          execution.provider_options,
          `${adapterType} provider_options`
        );
        assertNoCredentialLikeOptions(publicOptions, adapterType);
        const credentialRef = optionalString(execution.credential_ref);
        const credentialOptions = credentialRef
          ? readCredentialOptions(profileRoot, credentialRef, adapterType)
          : {};
        if (Object.hasOwn(execution, "managed_workspace"))
          throw new TypeError("LOCAL_PLUGIN_CONFIGURATION_REQUIRED");
        return [
          adapterType,
          {
            providerOptions: { ...publicOptions, ...credentialOptions }
          }
        ];
      })
    )
  };
}

function readCredentialOptions(
  profileRoot: string,
  credentialRef: string,
  adapterType: string
): Record<string, string> {
  const credentialsRoot = realpathSync(join(profileRoot, "credentials"));
  const credentialPath = realpathSync(resolve(profileRoot, credentialRef));
  const relativeCredential = relative(credentialsRoot, credentialPath);
  if (relativeCredential.startsWith("..") || isAbsolute(relativeCredential)) {
    throw new Error(
      `managed ${adapterType} credential_ref resolves outside the profile credentials directory`
    );
  }
  const credential = readJsonRequired<AdapterCredentialManifest>(credentialPath);
  if (credential.schema_version !== 1)
    throw new Error(`managed ${adapterType} credential is invalid`);
  return stringRecord(credential.provider_options, `${adapterType} credential provider_options`);
}

function stringRecord(value: unknown, name: string): Record<string, string> {
  const record = objectValue(value);
  if (!record) throw new Error(`managed ${name} is required`);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, requiredString(entry, `${name}.${key}`)])
  );
}

function assertNoCredentialLikeOptions(options: Record<string, string>, adapterType: string): void {
  for (const key of Object.keys(options)) {
    if (/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL)/i.test(key)) {
      throw new Error(
        `managed ${adapterType} public provider_options contains credential-like key ${key}`
      );
    }
  }
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
    ? (value as Record<string, unknown>)
    : undefined;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

import { randomUUID } from "node:crypto";
import { readJsonOptional, writeJsonAtomic, type DaemonProfilePaths } from "./home.js";
import type { AuthorizedTenant } from "./types.js";

export interface LocalRuntimeIdentity {
  schema_version: 1;
  profile: string;
  runtime_id: string;
  octo_space_id: string;
  credential_id?: string;
  enrolled_at?: string;
}

export function ensureLocalRuntime(
  profile: DaemonProfilePaths,
  tenant: AuthorizedTenant
): LocalRuntimeIdentity {
  const saved = readJsonOptional<LocalRuntimeIdentity>(profile.identityFile);
  if (
    saved &&
    (saved.schema_version !== 1 ||
      saved.profile !== profile.name ||
      saved.octo_space_id !== tenant.id ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(saved.runtime_id))
  ) {
    throw new Error("LOCAL_RUNTIME_IDENTITY_INVALID");
  }
  const identity = saved ?? {
    schema_version: 1,
    profile: profile.name,
    runtime_id: `runtime_${randomUUID()}`,
    octo_space_id: tenant.id
  };
  if (!saved) writeJsonAtomic(profile.identityFile, identity);
  const configuration = readJsonOptional<Record<string, unknown>>(profile.configFile);
  writeJsonAtomic(profile.configFile, {
    ...configuration,
    schema_version: 1,
    profile: profile.name,
    octo_space_id: tenant.id
  });
  return identity;
}

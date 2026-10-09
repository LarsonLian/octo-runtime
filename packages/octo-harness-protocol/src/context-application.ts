import type { ContextApplicationEvidence } from "./generated/protocol-types.js";

export function assertContextApplicationEvidence(value: unknown): asserts value is ContextApplicationEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("CONTEXT_APPLICATION_INVALID");
  const row = value as Record<string, unknown>;
  const required = ["schema", "compiler_version", "catalog_version", "context_hash", "compiled_hash", "run_id", "lease_id", "fencing_token", "adapter_type", "provider_session_id", "provider_ack", "loaded_skills"];
  if (Object.keys(row).length !== required.length || required.some(key => !(key in row))
    || row.schema !== "octo.context-application/v1" || row.compiler_version !== "octo.context-compiler/v2"
    || row.catalog_version !== "octo.context-catalog/v2" || row.adapter_type !== "codex" || row.provider_ack !== "turn/start"
    || ["context_hash", "compiled_hash"].some(key => typeof row[key] !== "string" || !/^sha256:[a-f0-9]{64}$/.test(row[key]))
    || ["run_id", "lease_id", "provider_session_id"].some(key => typeof row[key] !== "string" || !row[key])
    || !Number.isSafeInteger(row.fencing_token) || Number(row.fencing_token) <= 0
    || !Array.isArray(row.loaded_skills) || row.loaded_skills.length > 64 || new Set(row.loaded_skills).size !== row.loaded_skills.length
    || row.loaded_skills.some(name => typeof name !== "string" || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(name))) {
    throw new TypeError("CONTEXT_APPLICATION_INVALID");
  }
}

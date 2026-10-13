import { assertMcpServers, type IssuedToolAuthorization, type McpStreamableHttpServer, type ToolAuthorization } from "@mininglamp-oss/octo-harness-protocol";

export interface BusinessServiceBinding {
  serviceSubjectId: string;
  url: string;
}
export type BusinessServiceConnections = Partial<Record<"task" | "discussion", McpStreamableHttpServer>>;

const frameworkTools = {
  task: new Set(["task_get_materials", "task_authorize_material_snapshot", "task_prepare_output", "task_commit_output", "task_fail_output"]),
  discussion: new Set(["discussion_prepare_output", "discussion_commit_output", "discussion_fail_output"])
};

/** A service binding consumes only operations implemented by Harness, not the recipient's entire grant. */
export function unconsumedToolAuthorizations(grants: readonly IssuedToolAuthorization[], bindings: Partial<Record<"task" | "discussion", BusinessServiceBinding>> = {}): IssuedToolAuthorization[] {
  return grants.flatMap<IssuedToolAuthorization>(grant => {
    const [first, ...rest] = grant.allowed_tools.filter(tool => !(["task", "discussion"] as const).some(kind =>
      bindings[kind]?.serviceSubjectId === grant.service_subject_id && frameworkTools[kind].has(tool)));
    return first ? [{ ...grant, allowed_tools: [first, ...rest], resource_refs: [...grant.resource_refs] }] : [];
  });
}

function assertIntents(value: unknown): asserts value is ToolAuthorization[] {
  if (!Array.isArray(value) || value.length > 32) throw new TypeError("TOOL_AUTHORIZATION_INVALID");
  const seen = new Set<string>();
  for (const item of value as unknown[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError("TOOL_AUTHORIZATION_INVALID");
    const row = item as Record<string, unknown>;
    if (Object.keys(row).length !== 3 || Object.keys(row).some(key => !["service_subject_id", "allowed_tools", "resource_refs"].includes(key))
      || typeof row.service_subject_id !== "string" || !row.service_subject_id || row.service_subject_id.length > 96 || seen.has(row.service_subject_id)) throw new TypeError("TOOL_AUTHORIZATION_INVALID");
    for (const key of ["allowed_tools", "resource_refs"]) {
      const items: unknown = row[key];
      if (!Array.isArray(items) || !items.length || items.length > 128 || new Set(items).size !== items.length
        || (items as unknown[]).some(entry => typeof entry !== "string" || !entry || entry.length > 512)) throw new TypeError("TOOL_AUTHORIZATION_INVALID");
    }
    seen.add(row.service_subject_id);
  }
}

function assertAuthorization(value: unknown): asserts value is IssuedToolAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("TOOL_AUTHORIZATION_INVALID");
  const row = value as Record<string, unknown>;
  const keys = ["service_subject_id", "allowed_tools", "resource_refs", "token", "octo_space_id", "namespace", "expires_at"];
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))
    || ["service_subject_id", "token", "octo_space_id", "namespace", "expires_at"].some(key => typeof row[key] !== "string" || !row[key])
    || ["allowed_tools", "resource_refs"].some(key => !Array.isArray(row[key]) || row[key].length === 0 || row[key].length > 128 || row[key].some(item => typeof item !== "string" || !item) || new Set(row[key]).size !== row[key].length)
    || String(row.service_subject_id).length > 96 || String(row.token).length > 512
    || !String(row.token).startsWith("octo_run_") || !Number.isFinite(Date.parse(String(row.expires_at))) || Date.parse(String(row.expires_at)) <= Date.now()) throw new TypeError("TOOL_AUTHORIZATION_INVALID");
}

export async function resolveToolAuthorizations(requested: readonly ToolAuthorization[], options: {
  baseUrl: string; headers: Record<string, string>; runId: string; leaseId: string; fencingToken: number; signal: AbortSignal;
}): Promise<IssuedToolAuthorization[]> {
  assertIntents(requested);
  if (!requested.length) return [];
  const response = await fetch(options.baseUrl.replace(/\/$/, "") + "/v1/runtime/context/authorizations/resolve", {
    method: "POST", headers: { ...options.headers, "Content-Type": "application/json" }, redirect: "error",
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]),
    body: JSON.stringify({ run_id: options.runId, lease_id: options.leaseId, fencing_token: options.fencingToken })
  });
  if (!response.ok) throw new Error("TOOL_AUTHORIZATION_RESOLVE_FAILED");
  const body = await response.json() as { data?: { authorizations?: unknown } };
  const grants = body.data?.authorizations;
  if (!Array.isArray(grants) || grants.length !== requested.length) throw new TypeError("TOOL_AUTHORIZATION_INVALID");
  const validated: IssuedToolAuthorization[] = [];
  const seen = new Set<string>();
  for (const grant of grants) {
    assertAuthorization(grant);
    const intent = requested.find(item => item.service_subject_id === grant.service_subject_id);
    if (!intent || seen.has(grant.service_subject_id)
      || grant.allowed_tools.length !== intent.allowed_tools.length || grant.resource_refs.length !== intent.resource_refs.length
      || grant.allowed_tools.some(tool => !intent.allowed_tools.includes(tool)) || grant.resource_refs.some(ref => !intent.resource_refs.includes(ref))) throw new TypeError("TOOL_AUTHORIZATION_SCOPE_MISMATCH");
    seen.add(grant.service_subject_id);
    validated.push(grant);
  }
  options.signal.throwIfAborted();
  return validated;
}

/** Endpoints originate exclusively in trusted local configuration. */
export function businessServiceConnections(grants: readonly IssuedToolAuthorization[], bindings: Partial<Record<"task" | "discussion", BusinessServiceBinding>> = {}): BusinessServiceConnections {
  const result: BusinessServiceConnections = {};
  for (const kind of ["task", "discussion"] as const) {
    const binding = bindings[kind];
    if (!binding) continue;
    const grant = grants.find(value => value.service_subject_id === binding.serviceSubjectId);
    if (!grant) continue;
    const url = new URL(binding.url);
    if (url.username || url.password || url.hash || !["http:", "https:"].includes(url.protocol)) throw new TypeError("BUSINESS_SERVICE_BINDING_INVALID");
    const connection: McpStreamableHttpServer = { type: "streamable_http", url: url.href, headers: { Authorization: `Bearer ${grant.token}`, "X-Space-ID": grant.octo_space_id, "X-Namespace": grant.namespace } };
    assertMcpServers({ [kind]: connection });
    result[kind] = connection;
  }
  return result;
}

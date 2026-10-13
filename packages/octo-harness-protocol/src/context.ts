import type {
  ApprovalMode,
  ContextEnvsPayload,
  ContextEnvelope,
  ContextItem,
  McpServers,
  ResolvedExecutionPlan
} from "./generated/protocol-types.js";
import { RUNTIME_SELECTION_SCHEMA } from "./runtime-selection.js";

export const CONTEXT_SCHEMA = "octo.context-envelope/v3" as const;
export const RUNTIME_RUN_CONTRACT = Object.freeze({
  schema_version: 7,
  routing_schema: RUNTIME_SELECTION_SCHEMA,
  context_schema: CONTEXT_SCHEMA,
  approval_schema: "octo.approval-request/v1"
} as const);
export const CONTEXT_MAX_BYTES = 65_536;
export const CONTEXT_MAX_ITEMS = 32;
export const APPROVAL_MODES: readonly ApprovalMode[] = ["ask", "assisted", "full_access"];

export function assertAgentSource(value: unknown): asserts value is "preset" | "provisioned" {
  if (value !== "preset" && value !== "provisioned") throw new TypeError("AGENT_SOURCE_INVALID");
}

export function assertApprovalMode(value: unknown): asserts value is ApprovalMode {
  if (!APPROVAL_MODES.includes(value as ApprovalMode))
    throw new TypeError("APPROVAL_MODE_UNSUPPORTED");
}

export function assertContextEnvelope(value: unknown): asserts value is ContextEnvelope {
  object(value, "CONTEXT_REQUIRED");
  fields(value, ["schema", "items"]);
  if (value.schema !== CONTEXT_SCHEMA || !Array.isArray(value.items))
    throw new TypeError("CONTEXT_SCHEMA_INVALID");
  if (value.items.length > CONTEXT_MAX_ITEMS) throw new TypeError("CONTEXT_BUDGET_EXCEEDED");
  assertJsonValue(value);
  const keys = new Set<string>();
  for (const item of value.items) {
    object(item, "CONTEXT_SCHEMA_INVALID");
    fields(item, ["namespace", "name", "guidance", "payload"]);
    for (const property of ["namespace", "name"]) {
      const text = item[property];
      if (typeof text !== "string" || text.length > 96 || !/^[a-z0-9][a-z0-9._-]*$/.test(text))
        throw new TypeError("CONTEXT_SCHEMA_INVALID");
    }
    const key = JSON.stringify([item.namespace, item.name]);
    if (keys.has(key)) throw new TypeError("CONTEXT_KEY_DUPLICATED");
    keys.add(key);
    if (item.guidance !== undefined) {
      if (typeof item.guidance !== "string") throw new TypeError("CONTEXT_SCHEMA_INVALID");
      if (
        ["octo.execution", "octo.runtime", "octo.security", "octo.control"].includes(
          String(item.namespace)
        )
      )
        throw new TypeError("CONTEXT_GUIDANCE_FORBIDDEN");
    }
    object(item.payload, "CONTEXT_SCHEMA_INVALID");
    publicPayload(item.namespace as string, item.name as string, item.payload);
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > CONTEXT_MAX_BYTES)
    throw new TypeError("CONTEXT_BUDGET_EXCEEDED");
}

export function contextItem(
  context: ContextEnvelope,
  namespace: string,
  name: string
): ContextItem | undefined {
  return context.items.find((item) => item.namespace === namespace && item.name === name);
}

export function canonicalContext(context: ContextEnvelope): string {
  assertContextEnvelope(context);
  return JSON.stringify(
    sorted({
      schema: context.schema,
      items: context.items
    })
  );
}

export function mergeContext(
  defaults: ContextEnvelope,
  overrides: ContextEnvelope
): ContextEnvelope {
  assertContextEnvelope(defaults);
  assertContextEnvelope(overrides);
  const items = new Map<string, ContextItem>();
  for (const item of [...defaults.items, ...overrides.items]) {
    const key = JSON.stringify([item.namespace, item.name]);
    const previous = items.get(key);
    const next = structuredClone(item);
    if (
      previous &&
      item.namespace === "octo.execution" &&
      ["model", "limits"].includes(item.name)
    ) {
      next.payload = { ...previous.payload, ...next.payload };
    }
    if (previous && item.namespace === "octo.execution" && item.name === "envs")
      next.payload = { ...mergeContextEnvs(previous.payload, next.payload) };
    if (previous && item.namespace === "octo.execution" && item.name === "mcp")
      next.payload = {
        mcpServers: {
          ...(previous.payload.mcpServers as McpServers),
          ...(next.payload.mcpServers as McpServers)
        }
      };
    if (previous && item.namespace === "octo.runtime" && item.name === "selection") {
      for (const field of ["offline_behavior", "failover"])
        if (next.payload[field] === undefined && previous.payload[field] !== undefined)
          next.payload[field] = previous.payload[field];
    }
    if (previous && item.namespace === "octo.content" && item.name === "references")
      next.payload.entries = mergeReferences(
        previous.payload.entries as Record<string, unknown>[],
        next.payload.entries as Record<string, unknown>[]
      );
    items.set(key, next);
  }
  const result: ContextEnvelope = { schema: CONTEXT_SCHEMA, items: [...items.values()] };
  assertContextEnvelope(result);
  return JSON.parse(canonicalContext(result)) as ContextEnvelope;
}

export function assertResolvedExecutionPlan(
  value: unknown
): asserts value is ResolvedExecutionPlan {
  object(value, "RESOLVED_EXECUTION_PLAN_REQUIRED");
  assertJsonValue(value);
  fields(value, [
    "agent_source",
    "adapter_type",
    "provider_agent_id",
    "workdir",
    "workspace",
    "approval_mode",
    "model",
    "effort",
    "required_capabilities",
    "required_execution_features",
    "runtime_limits",
    "provider_compatibility",
    "envs",
    "mcp"
  ]);
  if (value.envs !== undefined) assertContextEnvs(value.envs);
  if (value.mcp !== undefined) assertContextMcp(value.mcp);
  assertAgentSource(value.agent_source);
  text(value.adapter_type);
  assertProviderAgent(value.adapter_type, value.provider_agent_id);
  if (typeof value.workdir !== "string") throw new TypeError("CONTEXT_SCHEMA_INVALID");
  if (value.workspace !== undefined) {
    object(value.workspace, "RESOLVED_EXECUTION_PLAN_INVALID");
    executionField("octo.execution", "workspace", value.workspace);
  }
  if (
    !value.workdir &&
    value.agent_source !== "preset" &&
    (!isObject(value.workspace) || value.workspace.mode !== "random")
  )
    throw new TypeError("RESOLVED_EXECUTION_PLAN_INVALID");
  if (
    isObject(value.workspace) &&
    value.workspace.mode === "none" &&
    (value.agent_source !== "preset" || value.workdir !== "")
  )
    throw new TypeError("RESOLVED_EXECUTION_PLAN_INVALID");
  if (value.agent_source === "preset" && typeof value.provider_agent_id !== "string")
    throw new TypeError("PRESET_AGENT_TARGET_REQUIRED");
  assertApprovalMode(value.approval_mode);
  for (const property of ["model", "effort"])
    if (value[property] !== undefined) text(value[property]);
  if (
    value.required_capabilities !== undefined &&
    (!Array.isArray(value.required_capabilities) ||
      value.required_capabilities.some((item) => typeof item !== "string" || !item))
  )
    throw new TypeError("RESOLVED_EXECUTION_PLAN_INVALID");
  if (
    Array.isArray(value.required_capabilities) &&
    value.required_capabilities.some((item) => item !== "react")
  )
    throw new TypeError("RESOLVED_EXECUTION_PLAN_INVALID");
  if (
    value.required_execution_features !== undefined &&
    (!Array.isArray(value.required_execution_features) ||
      value.required_execution_features.some((item) => typeof item !== "string" || !item))
  )
    throw new TypeError("RESOLVED_EXECUTION_PLAN_INVALID");
  for (const property of ["runtime_limits", "provider_compatibility"])
    if (value[property] !== undefined) object(value[property], "RESOLVED_EXECUTION_PLAN_INVALID");
  if (value.runtime_limits !== undefined) {
    object(value.runtime_limits, "RESOLVED_EXECUTION_PLAN_INVALID");
    limits(value.runtime_limits);
  }
}

export function assertContextMcp(value: unknown): asserts value is { mcpServers: McpServers } {
  object(value, "CONTEXT_SCHEMA_INVALID");
  fields(value, ["mcpServers"]);
  try {
    assertMcpServers(value.mcpServers, true);
  } catch {
    throw new TypeError("CONTEXT_SCHEMA_INVALID");
  }
}

export function assertMcpServers(value: unknown, templates = false): asserts value is McpServers {
  if (!isObject(value)) throw new TypeError("mcpServers must be an object");
  const entries = Object.entries(value);
  if (entries.length > 32) throw new TypeError("mcpServers must not contain more than 32 servers");
  for (const [name, server] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
      throw new TypeError("mcpServers contains an invalid server name");
    }
    if (!isObject(server)) throw new TypeError(`mcpServers.${name} must be an object`);
    const allowed =
      server.type === "stdio"
        ? new Set([
            "type",
            "command",
            "args",
            "env",
            "cwd",
            "required",
            "startupTimeoutMs",
            "toolTimeoutMs"
          ])
        : server.type === "streamable_http"
          ? new Set(["type", "url", "headers", "required", "startupTimeoutMs", "toolTimeoutMs"])
          : undefined;
    if (!allowed) throw new TypeError(`mcpServers.${name}.type is unsupported`);
    for (const key of Object.keys(server)) {
      if (!allowed.has(key)) throw new TypeError(`mcpServers.${name}.${key} is unsupported`);
    }
    if (server.type === "stdio") {
      requireNonEmptyString(server, "command", `mcpServers.${name}`);
      assertStringArray(server.args, `mcpServers.${name}.args`, 128);
      assertStringRecord(server.env, `mcpServers.${name}.env`, 128);
      for (const [key, value] of Object.entries(server.env ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /\0/.test(String(value)))
          throw new TypeError(`MCP_ENV_INVALID: ${name}.${key}`);
      }
      if (server.cwd !== undefined && (typeof server.cwd !== "string" || server.cwd.length === 0)) {
        throw new TypeError(`mcpServers.${name}.cwd must be a non-empty string when present`);
      }
    } else {
      requireNonEmptyString(server, "url", `mcpServers.${name}`);
      const templated = templates && /\$\$?\{[A-Za-z_][A-Za-z0-9_]*\}/.test(server.url as string);
      let parsed: URL;
      try {
        parsed = new URL(templated ? "https://template.invalid" : (server.url as string));
      } catch {
        throw new TypeError(`mcpServers.${name}.url must be an absolute HTTP URL`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new TypeError(`mcpServers.${name}.url must be an absolute HTTP URL`);
      }
      if (Array.from(server.url as string).length > 4096) {
        throw new TypeError(`mcpServers.${name}.url must not exceed 4096 characters`);
      }
      assertStringRecord(server.headers, `mcpServers.${name}.headers`, 64);
      const seen = new Set<string>();
      for (const [key, value] of Object.entries(server.headers ?? {})) {
        if (
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
          /[\r\n\0]/.test(String(value)) ||
          seen.has(key.toLowerCase())
        )
          throw new TypeError(`MCP_HEADER_INVALID: ${name}.${key}`);
        seen.add(key.toLowerCase());
      }
    }
    if (server.required !== undefined && typeof server.required !== "boolean") {
      throw new TypeError(`mcpServers.${name}.required must be boolean when present`);
    }
    assertMcpTimeout(server.startupTimeoutMs, `mcpServers.${name}.startupTimeoutMs`, 300_000);
    assertMcpTimeout(server.toolTimeoutMs, `mcpServers.${name}.toolTimeoutMs`, 3_600_000);
  }
}

function requireNonEmptyString(value: Record<string, unknown>, key: string, path: string): void {
  if (typeof value[key] !== "string" || value[key].length === 0) {
    throw new TypeError(`${path}.${key} must be a non-empty string`);
  }
}

function assertStringArray(value: unknown, path: string, limit: number): void {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    value.length > limit ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new TypeError(`${path} must be an array of strings`);
  }
}

function assertStringRecord(value: unknown, path: string, limit: number): void {
  if (value === undefined) return;
  if (
    !isObject(value) ||
    Object.keys(value).length > limit ||
    Object.values(value).some((item) => typeof item !== "string")
  ) {
    throw new TypeError(`${path} must be a string map`);
  }
}

function assertMcpTimeout(value: unknown, path: string, maximum: number): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || Number(value) < 100 || Number(value) > maximum) {
    throw new TypeError(`${path} is out of range`);
  }
}

export function assertJsonValue(value: unknown): void {
  json(value, 0);
}

export function mergeReferences(
  base: Record<string, unknown>[],
  next: Record<string, unknown>[]
): Record<string, unknown>[] {
  const entries = new Map(
    [...base, ...next].map((entry) => [String(entry.resource_ref), structuredClone(entry)])
  );
  return [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, entry]) => entry);
}

function publicPayload(namespace: string, name: string, value: Record<string, unknown>): void {
  if (namespace === "octo.execution" && name === "mcp") {
    assertContextMcp(value);
    return;
  }
  if (namespace === "octo.execution" && name === "envs") {
    assertContextEnvs(value);
    return;
  }
  if (namespace === "octo.resources") throw new TypeError("CONTEXT_TYPE_REMOVED");
  if (namespace === "octo.execution" && name === "model") {
    fields(value, ["selection", "reasoning"]);
    if (!Object.keys(value).length) throw new TypeError("CONTEXT_SCHEMA_INVALID");
    for (const [key, setting] of Object.entries(value)) {
      object(setting, "CONTEXT_SCHEMA_INVALID");
      executionField("octo.execution", key === "selection" ? "model" : "reasoning", setting);
    }
    return;
  }
  if (
    (namespace === "octo.execution" && ["adapter", "workspace", "limits"].includes(name)) ||
    (namespace === "octo.runtime" && name === "selection") ||
    (namespace === "octo.security" && name === "approval_policy")
  ) {
    executionField(namespace, name, value);
    return;
  }
  if (
    (namespace === "octo.content" && ["inline", "references"].includes(name)) ||
    (namespace === "octo.control" && name === "instructions")
  ) {
    fields(value, ["entries"]);
    if (!Array.isArray(value.entries) || (name !== "instructions" && value.entries.length === 0))
      throw new TypeError("CONTEXT_SCHEMA_INVALID");
    const refs = new Set<string>();
    for (const entry of value.entries) {
      object(entry, "CONTEXT_SCHEMA_INVALID");
      if (name === "instructions") {
        fields(entry, ["text", "source"]);
        text(entry.text);
        if (!["revision", "agent_configuration", "platform_policy"].includes(String(entry.source)))
          throw new TypeError("CONTEXT_SCHEMA_INVALID");
      } else if (name === "references") {
        resource(entry);
        const ref = String(entry.resource_ref);
        if (refs.has(ref)) throw new TypeError("CONTEXT_SCHEMA_INVALID");
        refs.add(ref);
      } else if (name === "inline") {
        fields(entry, ["text", "resource_ref", "source", "summary"]);
        text(entry.text);
        if (entry.resource_ref !== undefined) text(entry.resource_ref);
        if (
          entry.source !== undefined &&
          typeof entry.source !== "string" &&
          !isObject(entry.source)
        )
          throw new TypeError("CONTEXT_SCHEMA_INVALID");
        if (entry.summary !== undefined && typeof entry.summary !== "string")
          throw new TypeError("CONTEXT_SCHEMA_INVALID");
      } else throw new TypeError("CONTEXT_SCHEMA_INVALID");
    }
    return;
  }
  // Unknown optional types remain opaque until a consumer explicitly supports them.
}

function executionField(namespace: string, name: string, value: Record<string, unknown>): void {
  if (namespace === "octo.execution") {
    if (name === "adapter") {
      fields(value, ["type", "provider_agent_id"]);
      text(value.type);
      assertProviderAgent(value.type, value.provider_agent_id);
      return;
    }
    if (name === "model" || name === "reasoning") {
      const property = name === "model" ? "id" : "effort";
      fields(value, [property, "use_provider_default"]);
      if (value.use_provider_default === true && value[property] === undefined) return;
      if (value.use_provider_default !== undefined) throw new TypeError("CONTEXT_SCHEMA_INVALID");
      text(value[property]);
      return;
    }
    if (name === "workspace") {
      fields(value, ["mode", "path"]);
      if (value.mode === "none" && value.path === undefined) return;
      if (value.mode === "fixed") {
        text(value.path);
        return;
      }
      if (value.mode === "random" && value.path === undefined) return;
      throw new TypeError("CONTEXT_SCHEMA_INVALID");
    }
    if (name === "limits") {
      limits(value);
      return;
    }
  }
  if (namespace === "octo.runtime" && name === "selection") {
    fields(value, [
      "mode",
      "runtime_id",
      "runtime_ids",
      "strategy",
      "offline_behavior",
      "failover"
    ]);
    if (
      value.offline_behavior !== undefined &&
      value.offline_behavior !== "wait" &&
      value.offline_behavior !== "fail"
    )
      throw new TypeError("CONTEXT_SCHEMA_INVALID");
    if (
      value.failover !== undefined &&
      value.failover !== "none" &&
      value.failover !== "candidates"
    )
      throw new TypeError("CONTEXT_SCHEMA_INVALID");
    if (value.mode === "explicit" && value.failover !== undefined && value.failover !== "none")
      throw new TypeError("CONTEXT_SCHEMA_INVALID");
    if (
      value.mode === "explicit" &&
      value.runtime_ids === undefined &&
      value.strategy === undefined
    ) {
      text(value.runtime_id);
      return;
    }
    if (
      value.mode === "candidates" &&
      value.runtime_id === undefined &&
      value.strategy === "preferred_failover"
    ) {
      stringList(value.runtime_ids, 64, 1);
      return;
    }
    throw new TypeError("CONTEXT_SCHEMA_INVALID");
  }
  if (namespace === "octo.security" && name === "approval_policy") {
    fields(value, ["mode"]);
    assertApprovalMode(value.mode);
    return;
  }
  throw new TypeError("CONTEXT_TYPE_UNSUPPORTED");
}

function limits(value: Record<string, unknown>): void {
  const bounds: Record<string, number> = {
    first_frame_timeout_ms: 1_800_000,
    model_idle_timeout_ms: 3_600_000,
    model_idle_warning_ms: 3_600_000,
    tool_timeout_ms: 86_400_000,
    tool_wall_timeout_ms: 86_400_000,
    run_timeout_ms: 86_400_000,
    cancel_grace_ms: 60_000
  };
  fields(value, [...Object.keys(bounds), "model_idle_policy", "enforcement"]);
  for (const [key, setting] of Object.entries(value)) {
    if (key === "model_idle_policy" || key === "enforcement") {
      if (setting !== "enforce" && setting !== "observe")
        throw new TypeError("CONTEXT_SCHEMA_INVALID");
    } else integer(setting, 100, bounds[key]);
  }
  if (
    value.enforcement === "observe" &&
    ["model_idle_policy", "model_idle_warning_ms", "tool_wall_timeout_ms"].some(
      (key) => key in value
    )
  )
    throw new TypeError("CONTEXT_SCHEMA_INVALID");
}

function resource(value: Record<string, unknown>): void {
  fields(value, ["resource_ref", "resolver", "locator", "params", "authorization_ref", "revision"]);
  text(value.resource_ref);
  for (const property of ["authorization_ref", "revision"])
    if (value[property] !== undefined) text(value[property]);
  if (value.params !== undefined) object(value.params, "CONTEXT_SCHEMA_INVALID");
  const locator = value.locator;
  object(locator, "CONTEXT_SCHEMA_INVALID");
  if (value.resolver !== "mcp") throw new TypeError("CONTEXT_SCHEMA_INVALID");
  fields(locator, ["server_ref", "tool"]);
  text(locator.server_ref);
  text(locator.tool);
}

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum)
    throw new TypeError("CONTEXT_SCHEMA_INVALID");
}

function stringList(value: unknown, maximum: number, minimum = 0): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum ||
    value.some((item) => typeof item !== "string" || !item) ||
    new Set(value).size !== value.length
  )
    throw new TypeError("CONTEXT_SCHEMA_INVALID");
}

function assertProviderAgent(type: string, id: unknown): void {
  if (type === "openclaw") {
    if (typeof id !== "string" || !/^[a-z0-9_][a-z0-9_-]{0,63}$/.test(id))
      throw new TypeError("CONTEXT_SCHEMA_INVALID");
  } else if (id !== undefined) throw new TypeError("CONTEXT_SCHEMA_INVALID");
}

function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new TypeError("CONTEXT_SCHEMA_INVALID");
}

function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError("CONTEXT_SCHEMA_INVALID");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown, code: string): asserts value is Record<string, unknown> {
  if (!isObject(value)) throw new TypeError(code);
}

function json(value: unknown, depth: number): void {
  if (depth > 32) throw new TypeError("CONTEXT_SCHEMA_INVALID");
  if (typeof value === "string") {
    if (/[\uD800-\uDFFF]/u.test(value)) throw new TypeError("CONTEXT_SCHEMA_INVALID");
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) json(item, depth + 1);
    return;
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      json(key, depth + 1);
      json(item, depth + 1);
    }
    return;
  }
  throw new TypeError("CONTEXT_SCHEMA_INVALID");
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (isObject(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])])
    );
  return value;
}

/** Environment names are values in a list, never dynamic protocol object keys. */
export function assertContextEnvs(value: unknown): asserts value is ContextEnvsPayload {
  object(value, "CONTEXT_SCHEMA_INVALID");
  fields(value, ["env_variables"]);
  if (!Array.isArray(value.env_variables) || value.env_variables.length > 128)
    throw new TypeError("CONTEXT_SCHEMA_INVALID");
  const keys = new Set<string>();
  for (const entry of value.env_variables) {
    object(entry, "CONTEXT_SCHEMA_INVALID");
    fields(entry, ["key", "value"]);
    if (
      typeof entry.key !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.key) ||
      typeof entry.value !== "string" ||
      entry.value.includes("\0") ||
      keys.has(entry.key)
    )
      throw new TypeError("CONTEXT_SCHEMA_INVALID");
    keys.add(entry.key);
  }
}

export function mergeContextEnvs(base: unknown, overrides: unknown): ContextEnvsPayload {
  assertContextEnvs(base);
  assertContextEnvs(overrides);
  const entries = new Map(
    [...base.env_variables, ...overrides.env_variables].map((entry) => [entry.key, entry.value])
  );
  return {
    env_variables: [...entries]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => ({ key, value }))
  };
}

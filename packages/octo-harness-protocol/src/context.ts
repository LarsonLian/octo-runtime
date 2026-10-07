import { createHash } from "node:crypto";
import type { ApprovalMode, ContextEnvelope, ContextItem, McpServers, ResolvedExecutionPlan } from "./generated/protocol-types.js";
import { RUNTIME_SELECTION_SCHEMA } from "./runtime-selection.js";

export const CONTEXT_SCHEMA = "octo.context-envelope/v1" as const;
export const RUNTIME_RUN_CONTRACT = Object.freeze({
  schema_version: 3,
  routing_schema: RUNTIME_SELECTION_SCHEMA,
  context_schema: CONTEXT_SCHEMA,
  approval_schema: "octo.approval-request/v1"
} as const);
export const CONTEXT_MAX_BYTES = 65_536;
export const CONTEXT_MAX_ITEMS = 32;
export const APPROVAL_MODES: readonly ApprovalMode[] = ["ask", "assisted", "full_access"];

export function assertApprovalMode(value: unknown): asserts value is ApprovalMode {
  if (!APPROVAL_MODES.includes(value as ApprovalMode)) throw new TypeError("APPROVAL_MODE_UNSUPPORTED");
}

export function assertContextEnvelope(value: unknown): asserts value is ContextEnvelope {
  object(value, "CONTEXT_REQUIRED");
  fields(value, ["schema", "items"]);
  if (value.schema !== CONTEXT_SCHEMA || !Array.isArray(value.items)) throw new TypeError("CONTEXT_SCHEMA_INVALID");
  if (value.items.length > CONTEXT_MAX_ITEMS) throw new TypeError("CONTEXT_BUDGET_EXCEEDED");
  assertJsonValue(value);
  const keys = new Set<string>();
  for (const item of value.items) {
    object(item, "CONTEXT_SCHEMA_INVALID");
    fields(item, ["namespace", "name", "payload"]);
    for (const property of ["namespace", "name"]) {
      const text = item[property];
      if (typeof text !== "string" || text.length > 96 || !/^[a-z0-9][a-z0-9._-]*$/.test(text)) throw new TypeError("CONTEXT_SCHEMA_INVALID");
    }
    const key = JSON.stringify([item.namespace, item.name]);
    if (keys.has(key)) throw new TypeError("CONTEXT_KEY_DUPLICATED");
    keys.add(key);
    object(item.payload, "CONTEXT_SCHEMA_INVALID");
    payload(item.namespace as string, item.name as string, item.payload);
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > CONTEXT_MAX_BYTES) throw new TypeError("CONTEXT_BUDGET_EXCEEDED");
}

export function contextItem(context: ContextEnvelope, namespace: string, name: string): ContextItem | undefined {
  return context.items.find(item => item.namespace === namespace && item.name === name);
}

export function canonicalContext(context: ContextEnvelope): string {
  assertContextEnvelope(context);
  return JSON.stringify(sorted({ schema: context.schema, items: [...context.items].sort((left, right) =>
    left.namespace < right.namespace ? -1 : left.namespace > right.namespace ? 1 : left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ) }));
}

export function contextHash(context: ContextEnvelope): string {
  return `sha256:${createHash("sha256").update(canonicalContext(context)).digest("hex")}`;
}

export function mergeContext(defaults: ContextEnvelope, overrides: ContextEnvelope): ContextEnvelope {
  assertContextEnvelope(defaults);
  assertContextEnvelope(overrides);
  const items = new Map<string, ContextItem>();
  for (const item of [...defaults.items, ...overrides.items]) items.set(JSON.stringify([item.namespace, item.name]), structuredClone(item));
  const result: ContextEnvelope = { schema: CONTEXT_SCHEMA, items: [...items.values()] };
  assertContextEnvelope(result);
  return JSON.parse(canonicalContext(result)) as ContextEnvelope;
}

export function assertResolvedExecutionPlan(value: unknown): asserts value is ResolvedExecutionPlan {
  object(value, "RESOLVED_EXECUTION_PLAN_REQUIRED");
  assertJsonValue(value);
  fields(value, ["adapter_type", "workdir", "approval_mode", "model", "effort", "required_capabilities", "runtime_limits", "mcp_servers", "provider_compatibility"]);
  text(value.adapter_type);
  text(value.workdir);
  assertApprovalMode(value.approval_mode);
  for (const property of ["model", "effort"]) if (value[property] !== undefined) text(value[property]);
  if (value.required_capabilities !== undefined && (!Array.isArray(value.required_capabilities) || value.required_capabilities.some(item => typeof item !== "string" || !item))) throw new TypeError("RESOLVED_EXECUTION_PLAN_INVALID");
  for (const property of ["runtime_limits", "provider_compatibility"]) if (value[property] !== undefined) object(value[property], "RESOLVED_EXECUTION_PLAN_INVALID");
  if (value.runtime_limits !== undefined) {
    object(value.runtime_limits, "RESOLVED_EXECUTION_PLAN_INVALID");
    limits(value.runtime_limits);
  }
  if (value.mcp_servers !== undefined) assertMcpServers(value.mcp_servers);
}

export function assertMcpServers(value: unknown): asserts value is McpServers {
  if (!isObject(value)) throw new TypeError("mcpServers must be an object");
  const entries = Object.entries(value);
  if (entries.length > 32) throw new TypeError("mcpServers must not contain more than 32 servers");
  for (const [name, server] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
      throw new TypeError("mcpServers contains an invalid server name");
    }
    if (!isObject(server)) throw new TypeError(`mcpServers.${name} must be an object`);
    const allowed = server.type === "stdio"
      ? new Set(["type", "command", "args", "env", "cwd", "required", "startupTimeoutMs", "toolTimeoutMs"])
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
      if (server.cwd !== undefined && (typeof server.cwd !== "string" || server.cwd.length === 0)) {
        throw new TypeError(`mcpServers.${name}.cwd must be a non-empty string when present`);
      }
    } else {
      requireNonEmptyString(server, "url", `mcpServers.${name}`);
      let parsed: URL;
      try {
        parsed = new URL(server.url as string);
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
  if (!Array.isArray(value) || value.length > limit || value.some(item => typeof item !== "string")) {
    throw new TypeError(`${path} must be an array of strings`);
  }
}

function assertStringRecord(value: unknown, path: string, limit: number): void {
  if (value === undefined) return;
  if (!isObject(value) || Object.keys(value).length > limit || Object.values(value).some(item => typeof item !== "string")) {
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

function payload(namespace: string, name: string, value: Record<string, unknown>): void {
  if (namespace === "octo.execution") {
    if (name === "adapter") { fields(value, ["type"]); text(value.type); return; }
    if (name === "model" || name === "reasoning") {
      const property = name === "model" ? "id" : "effort";
      fields(value, [property, "use_provider_default"]);
      if (value.use_provider_default === true && value[property] === undefined) return;
      if (value.use_provider_default !== undefined) throw new TypeError("CONTEXT_SCHEMA_INVALID");
      text(value[property]); return;
    }
    if (name === "workspace") { fields(value, ["mode", "path"]); if (value.mode !== "fixed") throw new TypeError("CONTEXT_SCHEMA_INVALID"); text(value.path); return; }
    if (name === "limits") { limits(value); return; }
  }
  if (namespace === "octo.runtime" && name === "selection") {
    fields(value, ["mode", "runtime_id"]);
    if (value.mode === "binding" && value.runtime_id === undefined) return;
    if (value.mode === "explicit") { text(value.runtime_id); return; }
    throw new TypeError("CONTEXT_SCHEMA_INVALID");
  }
  if (namespace === "octo.security" && name === "approval_policy") { fields(value, ["mode"]); assertApprovalMode(value.mode); return; }
  if ((namespace === "octo.content" && ["selections", "resources"].includes(name)) || (namespace === "octo.control" && name === "instructions")) {
    fields(value, ["entries"]);
    if (!Array.isArray(value.entries)) throw new TypeError("CONTEXT_SCHEMA_INVALID");
    for (const entry of value.entries) {
      object(entry, "CONTEXT_SCHEMA_INVALID");
      if (name === "instructions") {
        fields(entry, ["text", "source"]); text(entry.text); text(entry.source);
        if (!["revision", "agent_configuration", "platform_policy"].includes(entry.source)) throw new TypeError("CONTEXT_SCHEMA_INVALID");
      } else if (name === "resources") {
        resource(entry);
      } else {
        fields(entry, ["text", "resource_ref", "source", "summary"]);
        text(entry.text);
        if (entry.resource_ref !== undefined) text(entry.resource_ref);
        if (entry.source !== undefined && typeof entry.source !== "string" && !isObject(entry.source)) throw new TypeError("CONTEXT_SCHEMA_INVALID");
        if (entry.summary !== undefined && typeof entry.summary !== "string") throw new TypeError("CONTEXT_SCHEMA_INVALID");
      }
    }
    return;
  }
  if (namespace === "octo.content" && name === "continuity") {
    continuity(value);
    return;
  }
  if (namespace === "octo.content" && name === "delivery_policy") {
    fields(value, ["focus", "budget"]);
    if (value.focus !== undefined) {
      if (!Array.isArray(value.focus)) throw new TypeError("CONTEXT_SCHEMA_INVALID");
      for (const focus of value.focus) text(focus);
    }
    if (value.budget !== undefined) {
      object(value.budget, "CONTEXT_SCHEMA_INVALID"); fields(value.budget, ["max_inline_bytes", "max_items"]);
      if (value.budget.max_inline_bytes !== undefined) integer(value.budget.max_inline_bytes, 1, CONTEXT_MAX_BYTES);
      if (value.budget.max_items !== undefined) integer(value.budget.max_items, 1, CONTEXT_MAX_ITEMS);
    }
    return;
  }
  throw new TypeError("CONTEXT_TYPE_UNSUPPORTED");
}

function limits(value: Record<string, unknown>): void {
  const bounds: Record<string, number> = {
    first_frame_timeout_ms: 1_800_000, model_idle_timeout_ms: 3_600_000, model_idle_warning_ms: 3_600_000,
    tool_timeout_ms: 86_400_000, tool_wall_timeout_ms: 86_400_000, run_timeout_ms: 86_400_000, cancel_grace_ms: 60_000
  };
  fields(value, [...Object.keys(bounds), "model_idle_policy", "enforcement"]);
  for (const [key, setting] of Object.entries(value)) {
    if (key === "model_idle_policy" || key === "enforcement") {
      if (setting !== "enforce" && setting !== "observe") throw new TypeError("CONTEXT_SCHEMA_INVALID");
    } else integer(setting, 100, bounds[key]);
  }
  if (value.enforcement === "observe" && ["model_idle_policy", "model_idle_warning_ms", "tool_wall_timeout_ms"].some(key => key in value)) throw new TypeError("CONTEXT_SCHEMA_INVALID");
}

function resource(value: Record<string, unknown>): void {
  fields(value, ["resource_ref", "resolver", "locator", "params", "authorization_ref", "revision"]);
  text(value.resource_ref);
  for (const property of ["authorization_ref", "revision"]) if (value[property] !== undefined) text(value[property]);
  if (value.params !== undefined) object(value.params, "CONTEXT_SCHEMA_INVALID");
  const locator = value.locator;
  object(locator, "CONTEXT_SCHEMA_INVALID");
  if (value.resolver === "mcp") {
    fields(locator, ["server_ref", "tool"]); text(locator.server_ref); text(locator.tool);
  } else if (value.resolver === "cli" || value.resolver === "local_tool") {
    fields(locator, ["operation_ref"]); text(locator.operation_ref);
  } else if (value.resolver === "snapshot") {
    fields(locator, ["snapshot_ref", "digest"]); text(locator.snapshot_ref);
    if (typeof locator.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(locator.digest) || "params" in value) throw new TypeError("CONTEXT_SCHEMA_INVALID");
  } else throw new TypeError("CONTEXT_SCHEMA_INVALID");
}

function continuity(value: Record<string, unknown>): void {
  fields(value, ["scope", "consumer_key", "session_generation", "trigger_message_id", "trigger_seq", "trigger_fact"]);
  object(value.scope, "CONTEXT_SCHEMA_INVALID");
  fields(value.scope, ["tenant_id", "endpoint_id", "channel", "account_id", "bot_id", "conversation_id", "thread_id"]);
  for (const property of ["tenant_id", "endpoint_id", "channel", "bot_id", "conversation_id"]) text(value.scope[property]);
  if (value.scope.account_id !== null && typeof value.scope.account_id !== "string") throw new TypeError("CONTEXT_SCHEMA_INVALID");
  if (value.scope.thread_id !== undefined && value.scope.thread_id !== null && typeof value.scope.thread_id !== "string") throw new TypeError("CONTEXT_SCHEMA_INVALID");
  text(value.consumer_key);
  text(value.trigger_message_id);
  integer(value.session_generation, 1);
  if (value.trigger_seq !== undefined) integer(value.trigger_seq, 0);
  const fact = value.trigger_fact;
  object(fact, "CONTEXT_SCHEMA_INVALID");
  fields(fact, ["message_id", "message_seq", "sender", "occurred_at_ms", "parts", "flags"]);
  text(fact.message_id);
  if (fact.message_seq !== undefined) integer(fact.message_seq, 0);
  integer(fact.occurred_at_ms, 1);
  object(fact.sender, "CONTEXT_SCHEMA_INVALID");
  fields(fact.sender, ["id", "kind", "label"]);
  text(fact.sender.id); text(fact.sender.kind);
  if (fact.sender.label !== undefined && typeof fact.sender.label !== "string") throw new TypeError("CONTEXT_SCHEMA_INVALID");
  if (!Array.isArray(fact.parts) || fact.parts.length === 0) throw new TypeError("CONTEXT_SCHEMA_INVALID");
  for (const part of fact.parts) {
    object(part, "CONTEXT_SCHEMA_INVALID"); text(part.type);
    if (part.text !== undefined && typeof part.text !== "string") throw new TypeError("CONTEXT_SCHEMA_INVALID");
  }
  if (fact.flags !== undefined) {
    object(fact.flags, "CONTEXT_SCHEMA_INVALID"); fields(fact.flags, ["self", "control"]);
    for (const flag of Object.values(fact.flags)) if (typeof flag !== "boolean") throw new TypeError("CONTEXT_SCHEMA_INVALID");
  }
  if (fact.message_id !== value.trigger_message_id || fact.message_seq !== value.trigger_seq || ("message_seq" in fact) !== ("trigger_seq" in value)) throw new TypeError("CONTEXT_SCHEMA_INVALID");
}

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new TypeError("CONTEXT_SCHEMA_INVALID");
}

function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError("CONTEXT_SCHEMA_INVALID");
}

function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("CONTEXT_SCHEMA_INVALID");
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
  if (Array.isArray(value)) { for (const item of value) json(item, depth + 1); return; }
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
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  return value;
}

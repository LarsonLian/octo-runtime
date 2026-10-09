import type { ContextConfiguration, ContextEnvelope, ContextItem, ContextCapabilityReference, ContextCapabilitySelectionPayload } from "./generated/protocol-types.js";
import { assertContextEnvelope, canonicalContext, mergeContext, mergeReferences, CONTEXT_SCHEMA, RESOURCE_CONTEXT_KINDS } from "./context.js";
import { contextTypeDefinition } from "./context-catalog.js";

const empty = (): ContextEnvelope => ({ schema: CONTEXT_SCHEMA, items: [] });
const keyOf = (item: ContextItem): string => `${item.namespace}/${item.name}`;
const resourceKey = (item: { resource_id: string }): string => item.resource_id;
const selection = (envelope: ContextEnvelope, name: string): ContextCapabilitySelectionPayload | undefined =>
  envelope.items.find(item => item.namespace === "octo.resources" && item.name === name)?.payload as ContextCapabilitySelectionPayload | undefined;

/** 校验可持久化配置；身份、资源权限和强制来源仍由 Worker 验证。 */
export function assertContextConfiguration(value: unknown): asserts value is ContextConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["defaults", "mandatory"].includes(key))) throw new TypeError("CONTEXT_CONFIGURATION_INVALID");
  resolveContextConfiguration(value as ContextConfiguration, empty());
}

function validateLayers(configuration: ContextConfiguration): void {
  for (const envelope of [configuration.defaults, configuration.mandatory]) {
    assertContextEnvelope(envelope);
    for (const item of envelope.items) {
      if (!contextTypeDefinition(item.namespace, item.name).persistent) throw new TypeError("CONTEXT_CONFIGURATION_TYPE_FORBIDDEN");
    }
  }
}

/**
 * Each type resolves defaults, request and mandatory using its own contract.
 * mandatory 检查原请求后补入约束，不能通过默认覆盖隐藏冲突。
 */
export function resolveContextConfiguration(configuration: ContextConfiguration, request: ContextEnvelope): ContextEnvelope {
  validateLayers(configuration);
  assertContextEnvelope(request);
  const effective = mergeContext(configuration.defaults, request);
  const items = new Map(effective.items.map(item => [keyOf(item), item]));
  for (const required of configuration.mandatory.items) {
    const key = keyOf(required);
    if (required.namespace === "octo.resources") continue;
    const supplied = request.items.find(item => keyOf(item) === key);
    if (key === "octo.execution/model" || key === "octo.execution/limits") {
      const selected = items.get(key) ?? { ...required, payload: {} };
      selected.payload = structuredClone(selected.payload);
      for (const [field, constraint] of Object.entries(required.payload)) {
        const override = supplied?.payload[field];
        if (override !== undefined && !equal(constraint, override)) conflict(`${key}.${field}`);
        selected.payload[field] = structuredClone(constraint);
      }
      items.set(key, selected);
    } else if (key === "octo.content/references") {
      const selected = items.get(key);
      const references = required.payload.entries as Record<string, unknown>[];
      for (const entry of references) {
        const override = (supplied?.payload.entries as Record<string, unknown>[] | undefined)?.find(value => value.resource_ref === entry.resource_ref);
        if (override && !equal(override, entry)) conflict(`${key}.${String(entry.resource_ref)}`);
      }
      const entries = mergeReferences((selected?.payload.entries ?? []) as Record<string, unknown>[], references);
      items.set(key, { ...required, payload: { entries } });
    } else if (key === "octo.runtime/selection") {
      items.set(key, supplied ? { ...required, payload: constrainRuntime(required.payload, supplied.payload) } : structuredClone(required));
    } else {
      if (supplied && !equal(required.payload, supplied.payload)) conflict(key);
      items.set(key, structuredClone(required));
    }
  }
  for (const name of Object.keys(RESOURCE_CONTEXT_KINDS)) {
  const required = selection(configuration.mandatory, name);
  const resources = new Map<string, ContextCapabilityReference>();
  for (const layer of [configuration.defaults, configuration.mandatory, request]) {
    const scope = selection(layer, name);
    for (const excluded of scope?.exclude ?? []) {
      const key = resourceKey(excluded);
      if (required?.include.some(item => resourceKey(item) === key)) conflict(`octo.resources/${name}.${key}`);
      resources.delete(key);
    }
    for (const reference of scope?.include ?? []) resources.set(resourceKey(reference), structuredClone(reference));
  }
  const supplied = selection(request, name);
  for (const excluded of required?.exclude ?? []) {
    const key = resourceKey(excluded);
    if (supplied?.include.some(item => resourceKey(item) === key)) conflict(`octo.resources/${name}.${key}`);
    resources.delete(key);
  }
  for (const forced of required?.include ?? []) {
    const key = resourceKey(forced);
    const override = supplied?.include.find(item => resourceKey(item) === key);
    if (override && (forced.invoke && override.invoke === false || !componentsContain(override.components, forced.components))) conflict(`octo.resources/${name}.${key}`);
    const chosen = resources.get(key) ?? structuredClone(forced);
    if (forced.invoke) chosen.invoke = true;
    if (!componentsContain(chosen.components, forced.components)) chosen.components = structuredClone(forced.components);
    resources.set(key, chosen);
  }
  const key = `octo.resources/${name}`;
  if (items.has(key) || required || resources.size) items.set(key, { namespace: "octo.resources", name, payload: {
    include: [...resources.values()].sort((a, b) => resourceKey(a) < resourceKey(b) ? -1 : resourceKey(a) > resourceKey(b) ? 1 : 0), exclude: []
  } });
  }
  return JSON.parse(canonicalContext({ schema: CONTEXT_SCHEMA, items: [...items.values()] })) as ContextEnvelope;
}

function constrainRuntime(required: Record<string, unknown>, supplied: Record<string, unknown>): Record<string, unknown> {
  for (const field of ["offline_behavior", "failover"]) if (required[field] !== undefined && supplied[field] !== undefined && required[field] !== supplied[field]) conflict(`runtime.${field}`);
  const allowed = required.mode === "explicit" ? [required.runtime_id] : required.runtime_ids as string[];
  const selected = supplied.mode === "explicit" ? [supplied.runtime_id] : supplied.runtime_ids as string[];
  if (!selected.length || selected.some(id => !allowed.includes(id))) conflict("runtime");
  const result = structuredClone(supplied);
  for (const field of ["offline_behavior", "failover"]) if (required[field] !== undefined) result[field] = required[field];
  if (result.mode === "candidates") result.runtime_ids = allowed.filter(id => selected.includes(id));
  return result;
}
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(sort(left)) === JSON.stringify(sort(right)); }
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sort(item)]));
  return value;
}
function componentsContain(selected?: string[], required?: string[]): boolean {
  if (selected === undefined) return true;
  if (required === undefined) return false;
  return required.every(component => selected.includes(component));
}
function conflict(key: string): never { throw new TypeError(`CONTEXT_MANDATORY_CONFLICT: ${key}`); }

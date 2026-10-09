import type { ContextConfiguration, ContextEnvelope, ContextItem, ContextCapabilityReference, ContextCapabilitySelectionPayload } from "./generated/protocol-types.js";
import { assertContextEnvelope, canonicalContext, mergeContext } from "./context.js";
import { contextTypeDefinition } from "./context-catalog.js";

const empty = (): ContextEnvelope => ({ schema: "octo.context-envelope/v1", items: [] });
const keyOf = (item: ContextItem): string => `${item.namespace}/${item.name}`;
const selection = (envelope: ContextEnvelope, namespace: string): ContextCapabilitySelectionPayload | undefined =>
  envelope.items.find(item => item.namespace === namespace && item.name === "selection")?.payload as ContextCapabilitySelectionPayload | undefined;

/** 校验配置形状、可持久化类型和两层配置的一致性；本函数不授予配置编辑权限。 */
export function assertContextConfiguration(value: unknown): asserts value is ContextConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["defaults", "mandatory"].includes(key))) throw new TypeError("CONTEXT_CONFIGURATION_INVALID");
  const configuration = value as ContextConfiguration;
  validateLayers(configuration);
  resolveContextConfiguration(configuration, empty());
}

function validateLayers(configuration: ContextConfiguration): void {
  for (const envelope of [configuration.defaults, configuration.mandatory]) {
    assertContextEnvelope(envelope);
    for (const item of envelope.items) {
      const definition = contextTypeDefinition(item.namespace, item.name);
      if (!definition.persistent) throw new TypeError("CONTEXT_CONFIGURATION_TYPE_FORBIDDEN");
    }
  }
}

/**
 * 按类型规则装配 defaults、request 和 mandatory，返回规范化的有效 Context。
 * 强制约束针对原始 request 检查，防止后续覆盖掩盖冲突；冲突时抛错。
 * 本函数不修改输入，也不读取资源。调用方仍须验证身份、资源权限和平台限制。
 */
export function resolveContextConfiguration(configuration: ContextConfiguration, request: ContextEnvelope): ContextEnvelope {
  validateLayers(configuration);
  assertContextEnvelope(request);
  const effective = mergeContext(configuration.defaults, request);
  const items = new Map(effective.items.map(item => [keyOf(item), item]));
  for (const required of configuration.mandatory.items) {
    const key = keyOf(required);
    const definition = contextTypeDefinition(required.namespace, required.name);
    if (definition.merge === "capability_set") continue;
    const supplied = request.items.find(item => keyOf(item) === key);
    if (supplied && definition.mandatory !== "capability_union" && !mandatoryAllows(required, supplied)) conflict(key);
    const selected = items.get(key);
    const forced = structuredClone(required);
    if (definition.mandatory === "runtime_subset" && supplied) {
      forced.payload = structuredClone(supplied.payload);
      for (const property of ["offline_behavior", "failover"]) {
        if (required.payload[property] !== undefined) forced.payload[property] = required.payload[property];
      }
      if (forced.payload.mode === "candidates") {
        const allowed = required.payload.mode === "explicit" ? [required.payload.runtime_id] : required.payload.runtime_ids as string[];
        forced.payload.runtime_ids = allowed.filter(id => (supplied.payload.runtime_ids as string[]).includes(id as string));
      }
    }
    if (definition.mandatory === "capability_union") {
      if (required.payload.execution_features !== undefined || selected?.payload.execution_features !== undefined) forced.payload.execution_features = [...new Set([
        ...required.payload.execution_features as string[] ?? [], ...selected?.payload.execution_features as string[] ?? []
      ])];
      forced.payload.capabilities = [...new Set([
        ...required.payload.capabilities as string[], ...selected?.payload.capabilities as string[] ?? []
      ])];
    }
    items.set(key, forced);
  }
  // 资源选择按标识执行 include/exclude；mandatory 固定版本、组件范围和 invoke 要求。
  for (const namespace of ["octo.plugins", "octo.skills", "octo.connectors"]) {
    const required = selection(configuration.mandatory, namespace);
    const resources = new Map<string, ContextCapabilityReference>();
    for (const layer of [configuration.defaults, configuration.mandatory, request]) {
      const scope = selection(layer, namespace);
      for (const excluded of scope?.exclude ?? []) {
        if (required?.include.some(item => item.resource_id === excluded)) conflict(excluded);
        resources.delete(excluded);
      }
      for (const reference of scope?.include ?? []) resources.set(reference.resource_id, structuredClone(reference));
    }
    const supplied = selection(request, namespace);
    for (const excluded of required?.exclude ?? []) {
      if (supplied?.include.some(item => item.resource_id === excluded)) conflict(excluded);
      resources.delete(excluded);
    }
    for (const forced of required?.include ?? []) {
      const override = supplied?.include.find(item => item.resource_id === forced.resource_id);
      if (override && (override.version !== forced.version || forced.invoke && override.invoke === false
        || !componentsContain(override.components, forced.components))) conflict(forced.resource_id);
      const chosen = resources.get(forced.resource_id);
      if (!chosen || chosen.version !== forced.version) resources.set(forced.resource_id, structuredClone(forced));
      else {
        if (forced.invoke) chosen.invoke = true;
        if (!componentsContain(chosen.components, forced.components)) chosen.components = structuredClone(forced.components);
      }
    }
    const key = `${namespace}/selection`;
    if (items.has(key) || resources.size) {
      items.set(key, { namespace, name: "selection", payload: {
        include: [...resources.values()].sort((a, b) => a.resource_id < b.resource_id ? -1 : a.resource_id > b.resource_id ? 1 : 0), exclude: []
      } });
    }
  }
  return JSON.parse(canonicalContext({ schema: effective.schema, items: [...items.values()] })) as ContextEnvelope;
}

function mandatoryAllows(required: ContextItem, supplied: ContextItem): boolean {
  if (keyOf(required) === "octo.runtime/selection") {
    const constraint = required.payload;
    const value = supplied.payload;
    if (value.offline_behavior !== undefined && constraint.offline_behavior !== undefined
      && value.offline_behavior !== constraint.offline_behavior) return false;
    if (value.failover !== undefined && constraint.failover !== undefined && value.failover !== constraint.failover) return false;
    const ids = value.mode === "explicit" ? [value.runtime_id] : value.runtime_ids as string[];
    const allowed = constraint.mode === "explicit" ? [constraint.runtime_id] : constraint.runtime_ids as string[];
    return ids.length > 0 && ids.every(id => allowed.includes(id as string));
  }
  return canonicalContext({ schema: "octo.context-envelope/v1", items: [required] })
    === canonicalContext({ schema: "octo.context-envelope/v1", items: [supplied] });
}

function componentsContain(selected?: string[], required?: string[]): boolean {
  if (selected === undefined) return true;
  if (required === undefined) return false;
  return required.every(component => selected.includes(component));
}

function conflict(key: string): never { throw new TypeError(`CONTEXT_MANDATORY_CONFLICT: ${key}`); }

import type {
  ContextConfiguration,
  ContextEnvelope,
  ContextItem
} from "./generated/protocol-types.js";
import {
  assertContextEnvelope,
  canonicalContext,
  mergeContext,
  mergeContextEnvs,
  assertContextEnvs,
  assertContextMcp,
  CONTEXT_SCHEMA
} from "./context.js";
import { findContextTypeDefinition } from "./context-catalog.js";

const empty = (): ContextEnvelope => ({ schema: CONTEXT_SCHEMA, items: [] });
const keyOf = (item: ContextItem): string => `${item.namespace}/${item.name}`;
/** 校验可持久化配置；身份、资源权限和强制来源仍由 Worker 验证。 */
export function assertContextConfiguration(value: unknown): asserts value is ContextConfiguration {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["defaults", "mandatory"].includes(key))
  )
    throw new TypeError("CONTEXT_CONFIGURATION_INVALID");
  resolveContextConfiguration(value as ContextConfiguration, empty());
}

function validateLayers(configuration: ContextConfiguration): void {
  for (const [layer, envelope] of [configuration.defaults, configuration.mandatory].entries()) {
    assertContextEnvelope(envelope);
    for (const item of envelope.items) {
      if (!findContextTypeDefinition(item.namespace, item.name)?.persistent)
        throw new TypeError("CONTEXT_CONFIGURATION_TYPE_FORBIDDEN");
      if (item.namespace === "octo.control") {
        const entries = item.payload.entries as { source: string }[];
        if (layer === 0 || entries.some(entry => entry.source !== "agent_configuration"))
          throw new TypeError("CONTEXT_CONFIGURATION_TYPE_FORBIDDEN");
      }
    }
  }
}

/**
 * Each type resolves defaults, request and mandatory using its own contract.
 * mandatory 检查原请求后补入约束，不能通过默认覆盖隐藏冲突。
 */
export function resolveContextConfiguration(
  configuration: ContextConfiguration,
  request: ContextEnvelope
): ContextEnvelope {
  validateLayers(configuration);
  assertContextEnvelope(request);
  const effective = mergeContext(configuration.defaults, request);
  const items = new Map(effective.items.map((item) => [keyOf(item), item]));
  for (const required of configuration.mandatory.items) {
    const key = keyOf(required);
    const supplied = request.items.find((item) => keyOf(item) === key);
    if (key === "octo.execution/model" || key === "octo.execution/limits") {
      const selected = items.get(key) ?? { ...required, payload: {} };
      selected.payload = structuredClone(selected.payload);
      for (const [field, constraint] of Object.entries(required.payload)) {
        const override =
          supplied && Object.hasOwn(supplied.payload, field) ? supplied.payload[field] : undefined;
        if (override !== undefined && !equal(constraint, override)) conflict(`${key}.${field}`);
        selected.payload = { ...selected.payload, [field]: structuredClone(constraint) };
      }
      items.set(key, selected);
    } else if (key === "octo.execution/mcp") {
      assertContextMcp(required.payload);
      const suppliedPayload = supplied?.payload ?? { mcpServers: {} };
      assertContextMcp(suppliedPayload);
      for (const [name, server] of Object.entries(required.payload.mcpServers)) {
        if (
          Object.hasOwn(suppliedPayload.mcpServers, name) &&
          !equal(server, suppliedPayload.mcpServers[name])
        )
          conflict(`${key}.${name}`);
      }
      items.set(key, {
        ...required,
        payload: {
          mcpServers: {
            ...(items.get(key)?.payload.mcpServers as Record<string, unknown>),
            ...structuredClone(required.payload.mcpServers)
          }
        }
      });
    } else if (key === "octo.execution/envs") {
      const requiredPayload = required.payload;
      assertContextEnvs(requiredPayload);
      const suppliedPayload = supplied?.payload ?? { env_variables: [] };
      assertContextEnvs(suppliedPayload);
      const requested = new Map(
        suppliedPayload.env_variables.map((entry) => [entry.key, entry.value])
      );
      for (const entry of requiredPayload.env_variables) {
        if (requested.has(entry.key) && requested.get(entry.key) !== entry.value)
          conflict(`${key}.${entry.key}`);
      }
      items.set(key, {
        ...required,
        payload: {
          ...mergeContextEnvs(items.get(key)?.payload ?? { env_variables: [] }, requiredPayload)
        }
      });
    } else if (key === "octo.runtime/selection") {
      items.set(
        key,
        supplied
          ? { ...required, payload: constrainRuntime(required.payload, supplied.payload) }
          : structuredClone(required)
      );
    } else {
      if (supplied && !equal(required.payload, supplied.payload)) conflict(key);
      items.set(key, structuredClone(required));
    }
  }
  return JSON.parse(
    canonicalContext({ schema: CONTEXT_SCHEMA, items: [...items.values()] })
  ) as ContextEnvelope;
}

function constrainRuntime(
  required: Record<string, unknown>,
  supplied: Record<string, unknown>
): Record<string, unknown> {
  for (const field of ["offline_behavior", "failover"])
    if (
      required[field] !== undefined &&
      supplied[field] !== undefined &&
      required[field] !== supplied[field]
    )
      conflict(`runtime.${field}`);
  const allowed =
    required.mode === "explicit" ? [required.runtime_id] : (required.runtime_ids as string[]);
  const selected =
    supplied.mode === "explicit" ? [supplied.runtime_id] : (supplied.runtime_ids as string[]);
  if (!selected.length || selected.some((id) => !allowed.includes(id))) conflict("runtime");
  const result = structuredClone(supplied);
  for (const field of ["offline_behavior", "failover"])
    if (required[field] !== undefined) result[field] = required[field];
  if (result.mode === "candidates")
    result.runtime_ids = allowed.filter((id) => selected.includes(id));
  return result;
}
function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(sort(left)) === JSON.stringify(sort(right));
}
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sort(item)])
    );
  return value;
}
function conflict(key: string): never {
  throw new TypeError(`CONTEXT_MANDATORY_CONFLICT: ${key}`);
}

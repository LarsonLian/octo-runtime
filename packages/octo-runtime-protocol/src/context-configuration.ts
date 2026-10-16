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
      if (item.namespace === "octo.control" && layer === 0)
        throw new TypeError("CONTEXT_CONFIGURATION_TYPE_FORBIDDEN");
    }
  }
}

/** Agent mandatory values are authoritative; request differences are overwritten. */
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
    const selected = items.get(key);
    let payload = structuredClone(required.payload);
    if (key === "octo.execution/model" || key === "octo.execution/limits") {
      payload = { ...structuredClone(selected?.payload ?? {}), ...payload };
    } else if (key === "octo.execution/mcp") {
      assertContextMcp(required.payload);
      payload = {
        mcpServers: {
          ...(selected?.payload.mcpServers as Record<string, unknown>),
          ...structuredClone(required.payload.mcpServers)
        }
      };
    } else if (key === "octo.execution/envs") {
      assertContextEnvs(required.payload);
      payload = {
        ...mergeContextEnvs(selected?.payload ?? { env_variables: [] }, required.payload)
      };
    }
    items.set(key, { ...structuredClone(required), payload });
  }
  const result = { schema: CONTEXT_SCHEMA, items: [...items.values()] };
  assertContextEnvelope(result);
  return JSON.parse(canonicalContext(result)) as ContextEnvelope;
}

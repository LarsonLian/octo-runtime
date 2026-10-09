import type { ContextEnvelope } from "./generated/protocol-types.js";
import { assertContextEnvelope } from "./context.js";

export const CONTEXT_CATALOG_VERSION = "octo.context-catalog/v2" as const;
export type ContextStage = "validate" | "merge" | "resolve" | "dispatch" | "prepare" | "compile" | "apply";
export type ContextOutput = "execution" | "routing" | "policy" | "materials" | "instructions" | "resources";
export interface ContextTypeDefinition {
  readonly namespace: string;
  readonly name: string;
  readonly schemaRef: string;
  readonly persistent: boolean;
  readonly trustedOnly: boolean;
  readonly merge: "replace" | "capability_set" | "execution_fields" | "append";
  readonly mandatory: "equal" | "runtime_subset" | "capability_union" | "required_resources";
  readonly stages: readonly ContextStage[];
  readonly outputs: readonly ContextOutput[];
}

function entry(namespace: string, name: string, schema: string, persistent: boolean,
  stages: ContextStage[], outputs: ContextOutput[], mandatory: ContextTypeDefinition["mandatory"] = "equal",
  merge: ContextTypeDefinition["merge"] = "replace", trustedOnly = false): ContextTypeDefinition {
  return Object.freeze({ namespace, name, schemaRef: `#/definitions/${schema}`, persistent, trustedOnly,
    merge, mandatory, stages: Object.freeze(["validate", "merge", ...stages] as ContextStage[]), outputs: Object.freeze(outputs) });
}

/**
 * 定义 Context 类型的持久化、合并、强制约束和消费阶段。
 * 目录只描述数据语义；宿主负责检查处理器是否可用，并验证调用身份与资源权限。
 */
export const CONTEXT_TYPE_CATALOG: readonly ContextTypeDefinition[] = Object.freeze([
  entry("octo.execution", "config", "ContextExecutionPayload", true, ["resolve", "dispatch", "prepare", "compile", "apply"], ["execution", "routing", "policy"], "equal", "execution_fields"),
  entry("octo.resources", "selection", "ContextCapabilitySelectionPayload", true, ["resolve", "prepare", "compile", "apply"], ["resources"], "required_resources", "capability_set"),
  entry("octo.content", "materials", "ContextMaterialsPayload", true, ["resolve", "prepare", "compile"], ["materials"], "equal", "append"),
  entry("octo.control", "instructions", "ContextInstructionsPayload", false, ["compile", "apply"], ["instructions"], "equal", "replace", true)
]);

export function contextTypeDefinition(namespace: string, name: string): ContextTypeDefinition {
  const definition = CONTEXT_TYPE_CATALOG.find(item => item.namespace === namespace && item.name === name);
  if (!definition) throw new TypeError(`CONTEXT_TYPE_UNSUPPORTED: ${namespace}/${name}`);
  return definition;
}

export function assertContextProcessorCoverage(context: ContextEnvelope, stage: ContextStage, supportedKeys: ReadonlySet<string>): void {
  assertContextEnvelope(context);
  for (const item of context.items) {
    const definition = contextTypeDefinition(item.namespace, item.name);
    const key = `${item.namespace}/${item.name}`;
    if (definition.stages.includes(stage) && !supportedKeys.has(key)) {
      throw new TypeError(`CONTEXT_PROCESSOR_UNAVAILABLE: ${stage}: ${key}`);
    }
  }
}

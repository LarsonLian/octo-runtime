import { createHash } from "node:crypto";
import {
  CONTEXT_CATALOG_VERSION, assertContextProcessorCoverage, contextHash, contextItem, contextTypeDefinition,
  type ContextEnvelope, type ResolvedExecutionPlan, type ContextPreparationReceipt
} from "@mininglamp-oss/octo-harness-protocol";
import type { PreparedChannelContextSnapshot } from "./channel-context-store.js";
import type { PreparedRunContext } from "./context-preparation.js";
import { assertFrozenContextPlan, compileRunContext, type CompiledRunContext, type TrustedContextInstruction } from "./run-context.js";
import type { PreparedTaskMaterials } from "./task-materials.js";

export const CONTEXT_COMPILER_VERSION = "octo.context-compiler/v1" as const;
const preparationKeys = new Set([
  "octo.execution/workspace", "octo.plugins/selection", "octo.skills/selection",
  "octo.connectors/selection", "octo.content/resources", "octo.content/continuity"
]);
const compilationKeys = new Set([
  "octo.plugins/selection", "octo.skills/selection", "octo.connectors/selection",
  "octo.content/selections", "octo.content/resources", "octo.content/continuity",
  "octo.content/delivery_policy", "octo.control/instructions"
]);

export type ContextPipelineReceipt = ContextPreparationReceipt;
export type ContextPreparationStage = "input" | "capabilities" | "materials" | "continuity";
export interface ContextStageDefinition {
  id: ContextPreparationStage;
  dependsOn: readonly ContextPreparationStage[];
}
const stages: readonly ContextStageDefinition[] = [
  { id: "input", dependsOn: [] },
  { id: "capabilities", dependsOn: ["input"] },
  { id: "materials", dependsOn: ["capabilities"] },
  { id: "continuity", dependsOn: ["materials"] }
];
const preparationOwners: Readonly<Record<string, ContextPreparationStage>> = {
  "octo.execution/workspace": "capabilities", "octo.plugins/selection": "capabilities",
  "octo.skills/selection": "capabilities", "octo.connectors/selection": "capabilities",
  "octo.content/resources": "materials", "octo.content/continuity": "continuity"
};
export interface ContextConsumption { key: string; stage: "prepare" | "compile"; processor: string }
export interface ContextPipelineOptions {
  stages?: readonly ContextStageDefinition[];
  timeoutMs?: Partial<Record<ContextPreparationStage | "seal", number>>;
}

export function orderContextPreparationStages(definitions: readonly ContextStageDefinition[]): ContextPreparationStage[] {
  const pending = new Map(definitions.map(value => [value.id, value.dependsOn]));
  if (pending.size !== definitions.length || stages.some(value => !pending.has(value.id))
    || [...pending].some(([id, dependencies]) => !stages.some(value => value.id === id)
      || dependencies.some(dependency => !pending.has(dependency)) || new Set(dependencies).size !== dependencies.length)) {
    throw new TypeError("CONTEXT_STAGE_GRAPH_INVALID");
  }
  const result: ContextPreparationStage[] = [];
  while (pending.size) {
    const next = stages.find(value => pending.has(value.id) && pending.get(value.id)!.every(dependency => result.includes(dependency)));
    if (!next) throw new TypeError("CONTEXT_STAGE_DEPENDENCY_CYCLE");
    result.push(next.id);
    pending.delete(next.id);
  }
  return result;
}

async function boundedStage<T>(id: ContextPreparationStage | "seal", timeoutMs: number, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`CONTEXT_STAGE_TIMEOUT: ${id}`)), timeoutMs);
  let rejectAbort: () => void = () => undefined;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => {
        const reason: unknown = controller.signal.reason;
        reject(reason instanceof Error ? reason : new Error(`CONTEXT_STAGE_CANCELLED: ${id}`, { cause: reason }));
      };
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const result = await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return work(controller.signal);
    }), cancelled]);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectAbort);
  }
}

export interface ContextPipelinePorts<Input> {
  trustedInstructions?: readonly TrustedContextInstruction[];
  prepareInput(signal: AbortSignal): Promise<Input>;
  prepareCapabilities(signal: AbortSignal): Promise<PreparedRunContext>;
  prepareMaterials(signal: AbortSignal): Promise<PreparedTaskMaterials | undefined>;
  prepareContinuity(signal: AbortSignal): Promise<PreparedChannelContextSnapshot | undefined>;
  seal(receipt: ContextPipelineReceipt, signal: AbortSignal): Promise<void>;
}

/** Pure compilation has no network, filesystem, credentials or provider side effects. */
export class ContextCompiler {
  compile(context: ContextEnvelope, materials?: PreparedTaskMaterials, instructions: readonly TrustedContextInstruction[] = []): CompiledRunContext {
    assertContextProcessorCoverage(context, "compile", compilationKeys);
    return compileRunContext(context, materials?.selections, instructions);
  }
}

/** One admission boundary for every preparation path before Adapter invocation. */
export class ContextPipeline<Input> {
  constructor(private readonly ports: ContextPipelinePorts<Input>, private readonly options: ContextPipelineOptions = {}) {}

  async prepare(context: ContextEnvelope, plan: ResolvedExecutionPlan, identity: {
    runId: string; leaseId: string; fencingToken: number;
  }, signal: AbortSignal): Promise<{
    input: Input; capabilities: PreparedRunContext; materials?: PreparedTaskMaterials;
    continuity?: PreparedChannelContextSnapshot; compiled: CompiledRunContext;
    receipt: ContextPipelineReceipt; consumption: ContextConsumption[];
  }> {
    signal.throwIfAborted();
    assertFrozenContextPlan(context, plan);
    assertContextProcessorCoverage(context, "prepare", preparationKeys);
    assertContextProcessorCoverage(context, "compile", compilationKeys);
    const order = orderContextPreparationStages(this.options.stages ?? stages);
    const budgets = { input: 30_000, capabilities: 30_000, materials: 30_000, continuity: 30_000, seal: 30_000, ...this.options.timeoutMs };
    if (Object.values(budgets).some(value => !Number.isSafeInteger(value) || value <= 0)) throw new TypeError("CONTEXT_STAGE_BUDGET_INVALID");
    // Freeze the admitted inputs so asynchronous host work cannot change the compilation basis.
    const frozen = structuredClone(context);
    const instructions = structuredClone(this.ports.trustedInstructions ?? []);
    const outputs: { input?: Input; capabilities?: PreparedRunContext; materials?: PreparedTaskMaterials; continuity?: PreparedChannelContextSnapshot } = {};
    const consumption: ContextConsumption[] = [];
    for (const id of order) {
      await boundedStage(id, budgets[id], signal, async stageSignal => {
        switch (id) {
          case "input": outputs.input = await this.ports.prepareInput(stageSignal); break;
          case "capabilities": outputs.capabilities = await this.ports.prepareCapabilities(stageSignal); break;
          case "materials": outputs.materials = await this.ports.prepareMaterials(stageSignal); break;
          case "continuity": outputs.continuity = await this.ports.prepareContinuity(stageSignal); break;
        }
      });
      for (const item of frozen.items) {
        const key = `${item.namespace}/${item.name}`;
        if (preparationOwners[key] === id) consumption.push({ key, stage: "prepare", processor: id });
      }
    }
    const { input, capabilities, materials, continuity } = outputs;
    if (!capabilities) throw new TypeError("CONTEXT_CAPABILITIES_UNAVAILABLE");
    if (contextItem(frozen, "octo.content", "continuity") && !continuity) {
      throw new TypeError("CONTEXT_CONTINUITY_UNAVAILABLE");
    }
    const compiled = new ContextCompiler().compile(frozen, materials, instructions);
    for (const item of frozen.items) {
      if (contextTypeDefinition(item.namespace, item.name).stages.includes("compile")) {
        consumption.push({ key: `${item.namespace}/${item.name}`, stage: "compile", processor: "compiler" });
      }
    }
    for (const item of frozen.items) {
      const definition = contextTypeDefinition(item.namespace, item.name);
      for (const stage of ["prepare", "compile"] as const) {
        if (definition.stages.includes(stage) && consumption.filter(value => value.stage === stage && value.key === `${item.namespace}/${item.name}`).length !== 1) {
          throw new TypeError(`CONTEXT_CONSUMPTION_INVALID: ${stage}: ${item.namespace}/${item.name}`);
        }
      }
    }
    const receipt: ContextPipelineReceipt = {
      ...structuredClone(capabilities.receipt), compiler_version: CONTEXT_COMPILER_VERSION,
      catalog_version: CONTEXT_CATALOG_VERSION, context_hash: contextHash(frozen),
      compiled_hash: `sha256:${createHash("sha256").update(JSON.stringify({
        compiler: CONTEXT_COMPILER_VERSION, catalog: CONTEXT_CATALOG_VERSION, context: contextHash(frozen),
        compiled, trustedSources: instructions.map(value => value.source), workspace: capabilities.workdir,
        resources: capabilities.receipt.resources, materials: materials?.refs ?? [], continuity: continuity?.ref
      })).digest("hex")}`,
      run_id: identity.runId, lease_id: identity.leaseId, fencing_token: identity.fencingToken,
      materials: structuredClone(materials?.refs ?? []),
      ...(continuity ? { continuity: structuredClone(continuity.ref) } : {})
    };
    await boundedStage("seal", budgets.seal, signal, stageSignal => this.ports.seal(structuredClone(receipt), stageSignal));
    consumption.sort((left, right) => `${left.stage}/${left.key}`.localeCompare(`${right.stage}/${right.key}`));
    return { input: input as Input, capabilities, materials, continuity, compiled, receipt, consumption };
  }
}

import {
  CONTEXT_CATALOG_VERSION, assertContextProcessorCoverage, contextHash, contextItem,
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
  constructor(private readonly ports: ContextPipelinePorts<Input>) {}

  async prepare(context: ContextEnvelope, plan: ResolvedExecutionPlan, identity: {
    runId: string; leaseId: string; fencingToken: number;
  }, signal: AbortSignal): Promise<{
    input: Input; capabilities: PreparedRunContext; materials?: PreparedTaskMaterials;
    continuity?: PreparedChannelContextSnapshot; compiled: CompiledRunContext;
    receipt: ContextPipelineReceipt;
  }> {
    signal.throwIfAborted();
    assertFrozenContextPlan(context, plan);
    assertContextProcessorCoverage(context, "prepare", preparationKeys);
    // Freeze the admitted inputs so asynchronous host work cannot change the compilation basis.
    const frozen = structuredClone(context);
    const step = async <T>(work: () => Promise<T>): Promise<T> => {
      signal.throwIfAborted();
      const result = await work();
      signal.throwIfAborted();
      return result;
    };
    const input = await step(() => this.ports.prepareInput(signal));
    const capabilities = await step(() => this.ports.prepareCapabilities(signal));
    const materials = await step(() => this.ports.prepareMaterials(signal));
    const continuity = await step(() => this.ports.prepareContinuity(signal));
    if (contextItem(frozen, "octo.content", "continuity") && !continuity) {
      throw new TypeError("CONTEXT_CONTINUITY_UNAVAILABLE");
    }
    const compiled = new ContextCompiler().compile(frozen, materials, this.ports.trustedInstructions);
    const receipt: ContextPipelineReceipt = {
      ...structuredClone(capabilities.receipt), compiler_version: CONTEXT_COMPILER_VERSION,
      catalog_version: CONTEXT_CATALOG_VERSION, context_hash: contextHash(frozen),
      run_id: identity.runId, lease_id: identity.leaseId, fencing_token: identity.fencingToken,
      materials: structuredClone(materials?.refs ?? []),
      ...(continuity ? { continuity: structuredClone(continuity.ref) } : {})
    };
    await step(() => this.ports.seal(structuredClone(receipt), signal));
    return { input, capabilities, materials, continuity, compiled, receipt };
  }
}

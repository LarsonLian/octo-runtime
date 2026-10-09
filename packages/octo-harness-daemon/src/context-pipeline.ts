import { createHash } from "node:crypto";
import {
  CONTEXT_CATALOG_VERSION, assertContextProcessorCoverage, contextHash, contextTypeDefinition,
  type ContextEnvelope, type ResolvedExecutionPlan, type ContextPreparationReceipt
} from "@mininglamp-oss/octo-harness-protocol";
import type { PreparedChannelContextSnapshot } from "./channel-context-store.js";
import type { PreparedRunContext } from "./context-preparation.js";
import { assertFrozenContextPlan, compileRunContext, type CompiledRunContext, type TrustedContextInstruction } from "./run-context.js";
import type { PreparedTaskMaterials } from "./task-materials.js";

export const CONTEXT_COMPILER_VERSION = "octo.context-compiler/v2" as const;
const preparationKeys = new Set(["octo.execution/config", "octo.resources/selection", "octo.content/materials"]);
const compilationKeys = new Set([...preparationKeys, "octo.control/instructions"]);

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
  "octo.execution/config": "capabilities", "octo.resources/selection": "capabilities", "octo.content/materials": "materials"
};
export interface ContextConsumption { key: string; stage: "prepare" | "compile"; processor: string }
export interface ContextPipelineOptions {
  stages?: readonly ContextStageDefinition[];
  timeoutMs?: Partial<Record<ContextPreparationStage | "seal", number>>;
}

/** 校验完整阶段图并按固定阶段顺序稳定排序；缺失、重复、未知依赖或依赖环均在准备前拒绝。 */
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

/**
 * 为单个阶段设置毫秒预算，并将上层取消传给 Port。
 * 超时或取消后拒绝晚到结果；不承诺已经发出的远端请求或文件操作已回滚。
 */
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

/** 宿主注入有副作用的准备与封存能力；可信指令的来源身份须由宿主先行验证。 */
export interface ContextPipelinePorts<Input> {
  trustedInstructions?: readonly TrustedContextInstruction[];
  prepareInput(signal: AbortSignal): Promise<Input>;
  prepareCapabilities(signal: AbortSignal): Promise<PreparedRunContext>;
  prepareMaterials(signal: AbortSignal): Promise<PreparedTaskMaterials | undefined>;
  prepareContinuity(signal: AbortSignal): Promise<PreparedChannelContextSnapshot | undefined>;
  prepareCompiled?(compiled: CompiledRunContext, signal: AbortSignal): Promise<CompiledRunContext>;
  seal(receipt: ContextPipelineReceipt, signal: AbortSignal): Promise<void>;
}

/** 将准备好的材料与可信指令分通道编译；不访问网络、文件、凭据或 Provider。 */
export class ContextCompiler {
  compile(context: ContextEnvelope, materials?: PreparedTaskMaterials, instructions: readonly TrustedContextInstruction[] = [], prepared?: { plan: ResolvedExecutionPlan; capabilities: PreparedRunContext }): CompiledRunContext {
    assertContextProcessorCoverage(context, "compile", compilationKeys);
    const compiled = compileRunContext(context, materials?.selections, instructions);
    if (prepared) {
      const { resources: _files, ...executionPlan } = prepared.plan;
      const { skills, skillRoots, mcpServers, workdir, providerStateDir } = prepared.capabilities;
      compiled.executionPlan = structuredClone(executionPlan);
      compiled.preparedResources = structuredClone({ skills, skillRoots, mcpServers, workdir, providerStateDir });
    }
    return compiled;
  }
}

/**
 * Adapter 调用前的统一准备入口：校验冻结计划、准备资源、编译产物、封存回执。
 * 只有封存获得 Worker 确认才返回可调用产物；任一必需阶段失败都会拒绝整次准备。
 */
export class ContextPipeline<Input> {
  constructor(private readonly ports: ContextPipelinePorts<Input>, private readonly options: ContextPipelineOptions = {}) {}

  /** 每阶段及 seal 默认预算为 30 秒；消费记录要求每个类型在声明阶段恰好处理一次。 */
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
    // 复制本次 Context 与可信贡献，避免异步准备期间原对象被修改而改变编译依据。
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
    let compiled = new ContextCompiler().compile(frozen, materials, instructions, { plan, capabilities });
    if (this.ports.prepareCompiled) compiled = await boundedStage("materials", budgets.materials, signal, stageSignal => this.ports.prepareCompiled!(compiled, stageSignal));
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
    // compiled_hash 标识本轮实际编译与准备结果，包含实际目录，不是跨机器归一化的正文摘要。
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

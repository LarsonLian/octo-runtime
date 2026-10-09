import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  assertAgentSource,
  assertContextEnvelope,
  assertResolvedExecutionPlan,
  assertRuntimeLimits,
  contextHash,
  contextItem,
  mergeContext,
  type AgentConfig,
  type ContextEnvelope,
  type ResolvedExecutionPlan,
  type RuntimeLimits
} from "@mininglamp-oss/octo-harness-protocol";
import type { AgentRun } from "./store.js";

export type LocalAgentConfig = Pick<AgentConfig, "providerAgentId" | "providerOptions">;

const LIMIT_NAMES = {
  first_frame_timeout_ms: "firstFrameTimeoutMs",
  model_idle_timeout_ms: "modelIdleTimeoutMs",
  model_idle_warning_ms: "modelIdleWarningMs",
  model_idle_policy: "modelIdlePolicy",
  tool_timeout_ms: "toolTimeoutMs",
  tool_wall_timeout_ms: "toolWallTimeoutMs",
  run_timeout_ms: "runTimeoutMs",
  cancel_grace_ms: "cancelGraceMs",
  enforcement: "enforcement"
} as const;

export function assertLocalContext(context: unknown): asserts context is ContextEnvelope {
  assertContextEnvelope(context);
  for (const item of context.items) {
    if (item.namespace === "octo.execution" || (item.namespace === "octo.security" && item.name === "approval_policy")) continue;
    throw new TypeError(`LOCAL_CONTEXT_TYPE_UNSUPPORTED: ${item.namespace}/${item.name}`);
  }
}

export function resolveLocalContext(defaults: ContextEnvelope, submitted: ContextEnvelope, agentSource: "preset" | "provisioned"): {
  effectiveContext: ContextEnvelope;
  resolvedExecutionPlan: ResolvedExecutionPlan;
} {
  assertAgentSource(agentSource);
  assertLocalContext(defaults);
  assertLocalContext(submitted);
  let effectiveContext = mergeContext(defaults, submitted);
  if (!contextItem(effectiveContext, "octo.security", "approval_policy")) {
    effectiveContext = mergeContext(effectiveContext, { schema: effectiveContext.schema, items: [
      { namespace: "octo.security", name: "approval_policy", payload: { mode: "ask" } }
    ] });
  }
  const adapterPayload = contextItem(effectiveContext, "octo.execution", "adapter")?.payload;
  const adapter = adapterPayload?.type;
  const workspace = contextItem(effectiveContext, "octo.execution", "workspace")?.payload;
  const workdir = workspace?.path ?? "";
  if (typeof adapter !== "string" || !adapter) throw new TypeError("LOCAL_ADAPTER_CONTEXT_REQUIRED");
  if ((agentSource !== "preset" || workdir) && (typeof workdir !== "string" || !isAbsolute(workdir))) throw new TypeError("LOCAL_ABSOLUTE_WORKSPACE_REQUIRED");
  const choices = contextItem(effectiveContext, "octo.execution", "model")?.payload;
  const model = (choices?.selection as Record<string, unknown> | undefined)?.id;
  const effort = (choices?.reasoning as Record<string, unknown> | undefined)?.effort;
  const limits = contextItem(effectiveContext, "octo.execution", "limits")?.payload;
  const plan = {
    agent_source: agentSource,
    adapter_type: adapter,
    ...(workspace ? { workspace } : {}),
    ...(adapter === "openclaw" ? { provider_agent_id: adapterPayload?.provider_agent_id } : {}),
    workdir,
    approval_mode: contextItem(effectiveContext, "octo.security", "approval_policy")!.payload.mode,
    ...(typeof model === "string" ? { model } : {}),
    ...(typeof effort === "string" ? { effort } : {}),
    ...(limits ? { runtime_limits: structuredClone(limits) } : {})
  };
  assertResolvedExecutionPlan(plan);
  localRuntimeLimits(plan);
  return { effectiveContext, resolvedExecutionPlan: plan };
}

export function localRuntimeLimits(plan: ResolvedExecutionPlan): RuntimeLimits | undefined {
  if (!plan.runtime_limits) return undefined;
  const limits: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(plan.runtime_limits)) {
    if (!Object.hasOwn(LIMIT_NAMES, name)) throw new TypeError("LOCAL_RUNTIME_LIMIT_UNSUPPORTED");
    limits[LIMIT_NAMES[name as keyof typeof LIMIT_NAMES]] = value;
  }
  assertRuntimeLimits(limits);
  return limits;
}

export function assertLocalAgentConfig(value: unknown): asserts value is LocalAgentConfig {
  if (!isObject(value)) throw new TypeError("LOCAL_AGENT_CONFIG_REQUIRED");
  if (["autoApprove", "dangerouslyBypassPermissions", "permissionMode", "sandbox"].some(name => name in value)) {
    throw new TypeError("LEGACY_PERMISSION_CONFIG_REJECTED");
  }
  if (Object.keys(value).some(name => !["providerAgentId", "providerOptions"].includes(name))) {
    throw new TypeError("LEGACY_AGENT_CONFIG_REJECTED");
  }
  if (value.providerAgentId !== undefined && (typeof value.providerAgentId !== "string" || !value.providerAgentId)) {
    throw new TypeError("LOCAL_AGENT_CONFIG_INVALID");
  }
  if (value.providerOptions !== undefined && (!isObject(value.providerOptions) || Object.values(value.providerOptions).some(setting => typeof setting !== "string"))) {
    throw new TypeError("LOCAL_AGENT_CONFIG_INVALID");
  }
}

export function hashLocalValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");
}

export function assertRunSnapshot(run: AgentRun, previous?: AgentRun): void {
  if (!run.context || !run.effectiveContext || !run.resolvedExecutionPlan || !run.materialization
    || !Number.isSafeInteger(run.contextDefaultsVersion) || run.contextDefaultsVersion < 1) {
    throw new TypeError("LEGACY_RUN_CONTRACT_REJECTED");
  }
  assertLocalContext(run.context);
  const resolved = resolveLocalContext(run.effectiveContext, { schema: run.effectiveContext.schema, items: [] }, run.resolvedExecutionPlan.agent_source);
  if (contextHash(resolved.effectiveContext) !== run.contextHash
    || hashLocalValue(resolved.resolvedExecutionPlan) !== hashLocalValue(run.resolvedExecutionPlan)) {
    throw new TypeError("LOCAL_RUN_SNAPSHOT_INVALID");
  }
  assertLocalAgentConfig(run.materialization.config);
  if (!run.materialization.id || !run.materialization.name || !run.materialization.adapterType) throw new TypeError("LOCAL_RUN_SNAPSHOT_INVALID");
  if (previous && hashLocalValue(immutableRun(previous)) !== hashLocalValue(immutableRun(run))) {
    throw new TypeError("LOCAL_RUN_SNAPSHOT_IMMUTABLE");
  }
}

function immutableRun(run: AgentRun): unknown {
  return {
    id: run.id,
    agentSessionId: run.agentSessionId,
    runNo: run.runNo,
    trigger: run.trigger,
    input: run.input,
    requestHash: run.requestHash,
    context: run.context,
    effectiveContext: run.effectiveContext,
    contextDefaultsVersion: run.contextDefaultsVersion,
    contextHash: run.contextHash,
    resolvedExecutionPlan: run.resolvedExecutionPlan,
    materialization: run.materialization
  };
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map(name => [name, sorted(value[name])]));
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

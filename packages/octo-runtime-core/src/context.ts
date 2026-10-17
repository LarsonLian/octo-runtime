import { isAbsolute } from "node:path";
import {
  assertAgentSource,
  assertContextEnvelope,
  assertResolvedExecutionPlan,
  assertRuntimeLimits,
  contextItem,
  findContextTypeDefinition,
  mergeContext,
  type ContextEnvelope,
  type ResolvedExecutionPlan,
  type RuntimeLimits
} from "@mininglamp-oss/octo-runtime-protocol";

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
    if (!findContextTypeDefinition(item.namespace, item.name)) continue;
    if (
      item.namespace === "octo.execution" ||
      item.namespace === "octo.content" ||
      (item.namespace === "octo.security" && item.name === "approval_policy")
    )
      continue;
    throw new TypeError(`LOCAL_CONTEXT_TYPE_UNSUPPORTED: ${item.namespace}/${item.name}`);
  }
}

export function resolveLocalContext(
  defaults: ContextEnvelope,
  submitted: ContextEnvelope,
  agentSource: "preset" | "provisioned"
): {
  effectiveContext: ContextEnvelope;
  resolvedExecutionPlan: ResolvedExecutionPlan;
} {
  assertAgentSource(agentSource);
  assertLocalContext(defaults);
  assertLocalContext(submitted);
  if (
    defaults.items.some(
      (item) => item.namespace !== "octo.execution" && item.namespace !== "octo.security"
    )
  )
    throw new TypeError("CONTEXT_CONFIGURATION_TYPE_FORBIDDEN");
  let effectiveContext = mergeContext(defaults, submitted);
  if (!contextItem(effectiveContext, "octo.security", "approval_policy")) {
    effectiveContext = mergeContext(effectiveContext, {
      schema: effectiveContext.schema,
      items: [{ namespace: "octo.security", name: "approval_policy", payload: { mode: "ask" } }]
    });
  }
  const adapterPayload = contextItem(effectiveContext, "octo.execution", "adapter")?.payload;
  const adapter = adapterPayload?.type;
  const workspace = contextItem(effectiveContext, "octo.execution", "workspace")?.payload;
  const workdir = workspace?.path ?? "";
  if (typeof adapter !== "string" || !adapter)
    throw new TypeError("LOCAL_ADAPTER_CONTEXT_REQUIRED");
  if (
    (agentSource !== "preset" || workdir) &&
    (typeof workdir !== "string" || !isAbsolute(workdir))
  )
    throw new TypeError("LOCAL_ABSOLUTE_WORKSPACE_REQUIRED");
  const choices = contextItem(effectiveContext, "octo.execution", "model")?.payload;
  const model = (choices?.selection as Record<string, unknown> | undefined)?.id;
  const effort = (choices?.reasoning as Record<string, unknown> | undefined)?.effort;
  const actmode = contextItem(effectiveContext, "octo.execution", "actmode")?.payload.mode;
  const limits = contextItem(effectiveContext, "octo.execution", "limits")?.payload;
  const envs = contextItem(effectiveContext, "octo.execution", "envs")?.payload;
  const mcp = contextItem(effectiveContext, "octo.execution", "mcp")?.payload;
  const plan = {
    agent_source: agentSource,
    adapter_type: adapter,
    ...(workspace ? { workspace } : {}),
    ...(adapter === "openclaw" ? { provider_agent_id: adapterPayload?.provider_agent_id } : {}),
    workdir,
    approval_mode: contextItem(effectiveContext, "octo.security", "approval_policy")!.payload.mode,
    ...(typeof model === "string" ? { model } : {}),
    ...(typeof effort === "string" ? { effort } : {}),
    ...(actmode !== undefined ? { actmode } : {}),
    ...(limits ? { runtime_limits: structuredClone(limits) } : {}),
    ...(envs ? { envs: structuredClone(envs) } : {}),
    ...(mcp ? { mcp: structuredClone(mcp) } : {})
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

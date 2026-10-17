import type { ContextEnvelope, ResolvedExecutionPlan } from "./generated/protocol-types.js";
import {
  assertContextEnvelope,
  assertContextEnvs,
  assertResolvedExecutionPlan
} from "./context.js";

function executionValues(context: ContextEnvelope): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const item of [...context.items].sort((a, b) =>
    `${a.namespace}/${a.name}` < `${b.namespace}/${b.name}`
      ? -1
      : `${a.namespace}/${a.name}` > `${b.namespace}/${b.name}`
        ? 1
        : 0
  )) {
    if (
      item.namespace === "octo.execution" &&
      ["adapter", "workspace", "limits", "envs", "mcp", "actmode"].includes(item.name)
    )
      result[item.name] = item.payload;
    if (item.namespace === "octo.security" && item.name === "approval_policy")
      result.approval_policy = item.payload;
    if (item.namespace === "octo.runtime" && item.name === "selection")
      result.runtime = item.payload;
    if (item.namespace === "octo.execution" && item.name === "model") {
      if (isObject(item.payload.selection)) result.model = item.payload.selection;
      if (isObject(item.payload.reasoning)) result.reasoning = item.payload.reasoning;
    }
  }
  return result;
}

/** 验证有效 Context 与冻结执行计划逐项一致；不匹配时禁止进入资源准备。 */
export function assertFrozenContextPlan(
  context: ContextEnvelope,
  plan: ResolvedExecutionPlan
): void {
  assertContextEnvelope(context);
  assertResolvedExecutionPlan(plan);
  const execution = executionValues(context);
  const match = (field: string, property: string, actual: unknown): void => {
    if (execution[field]?.[property] !== actual) throw new TypeError("CONTEXT_PLAN_MISMATCH");
  };
  match("adapter", "type", plan.adapter_type);
  match("adapter", "provider_agent_id", plan.provider_agent_id);
  const workspace = execution.workspace;
  if (!workspace) throw new TypeError("CONTEXT_PLAN_MISMATCH");
  if (workspace.mode === "fixed") {
    match("workspace", "path", plan.workdir);
    if (
      plan.workspace &&
      (plan.workspace.mode !== "fixed" || plan.workspace.path !== workspace.path)
    )
      throw new TypeError("CONTEXT_PLAN_MISMATCH");
  }
  if (workspace.mode === "random" && (plan.workdir !== "" || plan.workspace?.mode !== "random"))
    throw new TypeError("CONTEXT_PLAN_MISMATCH");
  if (
    workspace.mode === "none" &&
    (plan.agent_source !== "preset" || plan.workdir || plan.workspace?.mode !== "none")
  )
    throw new TypeError("CONTEXT_PLAN_MISMATCH");
  match("approval_policy", "mode", plan.approval_mode);
  match("model", "id", plan.model);
  match("reasoning", "effort", plan.effort);
  match("actmode", "mode", plan.actmode);
  const canonical = (value: unknown): string =>
    JSON.stringify(value, function (_key, child: unknown) {
      return isObject(child)
        ? Object.fromEntries(
            Object.keys(child)
              .sort()
              .map((key) => [key, child[key]])
          )
        : child;
    });
  if (canonical(execution.mcp ?? { mcpServers: {} }) !== canonical(plan.mcp ?? { mcpServers: {} }))
    throw new TypeError("CONTEXT_PLAN_MISMATCH");
  const envs = execution.envs ?? { env_variables: [] };
  assertContextEnvs(envs);
  const plannedEnvs = new Map(
    (plan.envs?.env_variables ?? []).map((entry) => [entry.key, entry.value])
  );
  if (
    envs.env_variables.length !== plannedEnvs.size ||
    envs.env_variables.some((entry) => plannedEnvs.get(entry.key) !== entry.value)
  )
    throw new TypeError("CONTEXT_PLAN_MISMATCH");
  const limits = execution.limits ?? {};
  for (const property of new Set([
    ...Object.keys(limits),
    ...Object.keys(plan.runtime_limits ?? {})
  ])) {
    if (
      limits[property] !== (plan.runtime_limits as Record<string, unknown> | undefined)?.[property]
    )
      throw new TypeError("CONTEXT_PLAN_MISMATCH");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

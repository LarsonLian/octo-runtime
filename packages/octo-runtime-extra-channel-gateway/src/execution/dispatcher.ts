/**
 * 执行请求构造：把本轮 Context、可信发送者和执行配置封装为 InvokeRequest。
 * IM 默认值属于此发起入口；Context 的统一渲染与 prompt 封装交给共享执行层。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertContextEnvelope,
  assertInvokeRequest,
  contextControlInstructions,
  type ContextEnvelope,
  type InvokeRequest
} from "@mininglamp-oss/octo-runtime-protocol";
import type { ImBotConfig, ImInboundMessage, ImSession } from "../contracts.js";
import { resolveLocalContext, localRuntimeLimits } from "@mininglamp-oss/octo-runtime-core";
import { validateImConfig } from "../lifecycle/configuration.js";

export function createImInvocation(
  config: ImBotConfig,
  message: ImInboundMessage,
  context: ContextEnvelope,
  sessionKey: string,
  session: ImSession,
  signal: AbortSignal,
  occurrenceId = message.messageId
): { request: InvokeRequest; adapterType: string } {
  validateImConfig(config);
  assertContextEnvelope(context);
  if (!session.id) throw new Error("IM_SESSION_NOT_ALLOCATED");
  const selectedAdapter =
    context.items.find((item) => item.namespace === "octo.execution" && item.name === "adapter")
      ?.payload.type ??
    config.adapter.adapter_type ??
    "codex";
  const agentSource = selectedAdapter === "openclaw" ? "preset" : "provisioned";
  const defaultWorkdir = join(homedir(), "octo-runtime", "channels", config.bot_id);
  const workdir =
    config.adapter.workdir ?? (agentSource === "provisioned" ? defaultWorkdir : undefined);
  const submittedWorkspace = context.items.find(
    (item) => item.namespace === "octo.execution" && item.name === "workspace"
  );
  if (submittedWorkspace && submittedWorkspace.payload.path !== workdir)
    throw new Error("IM_AGENT_WORKDIR_FIXED");
  const defaults: ContextEnvelope = {
    schema: context.schema,
    items: [
      {
        namespace: "octo.execution",
        name: "adapter",
        payload: {
          type: config.adapter.adapter_type ?? "codex",
          ...(config.adapter.adapter_type === "openclaw"
            ? { provider_agent_id: config.adapter.provider_agent_id ?? "main" }
            : {})
        }
      },
      {
        namespace: "octo.security",
        name: "approval_policy",
        payload: { mode: config.approval_mode ?? "full_access" }
      },
      {
        namespace: "octo.execution",
        name: "limits",
        payload: {
          run_timeout_ms: config.run_timeout_ms ?? 86_400_000,
          // IM 的长工具可能长时间无输出；业务可通过本轮 limits 显式收紧。
          tool_timeout_ms: 86_400_000
        }
      },
      ...(workdir
        ? [
            {
              namespace: "octo.execution",
              name: "workspace",
              payload: { mode: "fixed", path: workdir }
            }
          ]
        : []),
      ...(config.adapter.model || config.adapter.effort
        ? [
            {
              namespace: "octo.execution",
              name: "model",
              payload: {
                ...(config.adapter.model ? { selection: { id: config.adapter.model } } : {}),
                ...(config.adapter.effort ? { reasoning: { effort: config.adapter.effort } } : {})
              }
            }
          ]
        : [])
    ]
  };
  // 执行默认值经现有 resolver 解析；本轮业务材料仍保持原顺序，不按会话补齐或去重。
  let resolved;
  try {
    resolved = resolveLocalContext(defaults, context, agentSource);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "CONTEXT_BUDGET_EXCEEDED" ||
      !context.items.some(
        (item) =>
          item.namespace === "extra.im" &&
          item.name === "history" &&
          item.payload.automatic === true
      )
    )
      throw error;
    resolved = resolveLocalContext(
      defaults,
      {
        ...context,
        items: context.items.filter(
          (item) =>
            !(
              item.namespace === "extra.im" &&
              item.name === "history" &&
              item.payload.automatic === true
            )
        )
      },
      agentSource
    );
  }
  const { effectiveContext: snapshot, resolvedExecutionPlan: plan } = resolved;
  const eventId = `evt_${randomUUID()}`,
    runId = `run_${randomUUID()}`;
  const prompt = message.text.trim();
  const request: InvokeRequest = {
    protocolVersion: 2,
    invocationId: `invoke_${randomUUID()}`,
    runId,
    agentSessionId: session.id,
    sessionGeneration: session.generation,
    providerEpoch: session.generation,
    agentSource,
    prompt,
    modelInput: prompt,
    context: snapshot,
    controlInstructions: contextControlInstructions(snapshot),
    workdir: plan.workdir,
    approvalMode: plan.approval_mode,
    agentConfig: {
      workdir: plan.workdir,
      ...(plan.model ? { model: plan.model } : {}),
      ...(plan.effort ? { effort: plan.effort } : {}),
      ...(plan.provider_agent_id ? { providerAgentId: plan.provider_agent_id } : {})
    },
    ...(session.providerSession ? { providerSession: session.providerSession } : {}),
    runMetadata: {
      ...message.runMetadata,
      // 可信身份覆盖可选 metadata，正文或自定义字段不能冒充当前发起人和会话。
      namespace: "im",
      platform: "octo",
      eventId,
      sessionKey,
      actorId: message.senderId,
      channelId: message.conversationId,
      triggerOccurrenceId: occurrenceId
    },
    runtimeLimits: localRuntimeLimits(plan),
    signal
  };
  assertInvokeRequest(request);
  if (
    config.adapter.workdir === undefined &&
    agentSource === "provisioned" &&
    plan.workdir === defaultWorkdir
  )
    mkdirSync(defaultWorkdir, { recursive: true, mode: 0o700 });
  session.lastEventId = eventId;
  session.lastRunId = runId;
  return { request, adapterType: plan.adapter_type };
}

/**
 * 执行请求构造：把本轮 Context、可信发送者和执行配置封装为 InvokeRequest。
 * IM 默认值属于此发起入口；Context 的统一渲染与 prompt 封装交给共享执行层。
 */
import { randomUUID } from "node:crypto";
import {
  assertContextEnvelope,
  assertInvokeRequest,
  contextControlInstructions,
  type ContextEnvelope,
  type InvokeRequest
} from "@mininglamp-oss/octo-harness-protocol";
import type { ImBotConfig, ImInboundMessage, ImSession } from "../contracts.js";
import { resolveLocalContext, localRuntimeLimits } from "@mininglamp-oss/octo-harness-core";

export function createImInvocation(
  config: ImBotConfig,
  message: ImInboundMessage,
  context: ContextEnvelope,
  sessionKey: string,
  session: ImSession,
  signal: AbortSignal,
  occurrenceId = message.messageId
): { request: InvokeRequest; adapterType: string } {
  assertContextEnvelope(context);
  const defaults: ContextEnvelope = {
    schema: context.schema,
    items: [
      {
        namespace: "octo.execution",
        name: "adapter",
        payload: { type: config.adapterType ?? "codex" }
      },
      {
        namespace: "octo.security",
        name: "approval_policy",
        payload: { mode: config.approvalMode ?? "full_access" }
      },
      {
        namespace: "octo.execution",
        name: "limits",
        payload: { run_timeout_ms: config.runTimeoutMs ?? 120_000 }
      },
      ...(config.workdir
        ? [
            {
              namespace: "octo.execution",
              name: "workspace",
              payload: { mode: "fixed", path: config.workdir }
            }
          ]
        : []),
      ...(config.model
        ? [
            {
              namespace: "octo.execution",
              name: "model",
              payload: { selection: { id: config.model } }
            }
          ]
        : [])
    ]
  };
  // 执行默认值经现有 resolver 解析；本轮业务材料仍保持原顺序，不按会话补齐或去重。
  const { effectiveContext: snapshot, resolvedExecutionPlan: plan } = resolveLocalContext(
    defaults,
    context,
    "provisioned"
  );
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
    agentSource: "provisioned",
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
      platform: config.type,
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
  session.lastEventId = eventId;
  session.lastRunId = runId;
  return { request, adapterType: plan.adapter_type };
}

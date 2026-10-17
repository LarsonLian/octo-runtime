/**
 * 执行请求构造：把本轮 Context、可信发送者和执行配置封装为 InvokeRequest。
 * IM 默认值属于此发起入口；Context 的统一渲染与 prompt 封装交给共享执行层。
 */
import { randomUUID } from "node:crypto";
import {
  assertContextEnvelope,
  mergeContext,
  type ApprovalMode,
  type ContextEnvelope,
  type InvokeInput
} from "@mininglamp-oss/octo-runtime-protocol";
import type { ImBotConfig, ImInboundMessage, ImSession } from "../contracts.js";

export type ImInvocationInput = InvokeInput & {
  runId: string;
  invocationId: string;
  sessionId: string;
  protocol_mode: "canonical";
};
export function createImInvocation(
  config: ImBotConfig,
  message: ImInboundMessage,
  context: ContextEnvelope,
  sessionKey: string,
  session: ImSession,
  _signal: AbortSignal,
  occurrenceId = message.messageId
): { request: ImInvocationInput; adapterType: string } {
  assertContextEnvelope(context);
  if (!session.id) throw new Error("IM_SESSION_NOT_ALLOCATED");
  const selectedAdapter =
    context.items.find((item) => item.namespace === "octo.execution" && item.name === "adapter")
      ?.payload.type ??
    config.adapter.adapter_type ??
    "codex";
  if (typeof selectedAdapter !== "string") throw new Error("IM_EXECUTION_CONFIG_INVALID");
  const agentSource = selectedAdapter === "openclaw" ? "preset" : "provisioned";
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
        payload: { run_timeout_ms: config.run_timeout_ms ?? 120_000 }
      },
      ...(config.adapter.workdir
        ? [
            {
              namespace: "octo.execution",
              name: "workspace",
              payload: { mode: "fixed", path: config.adapter.workdir }
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
  // 这里只组合本轮公开输入；Host 负责解析执行配置和渲染指令，不能在渠道重复运行 resolver。
  const snapshot = mergeContext(defaults, context);
  const eventId = `evt_${randomUUID()}`,
    runId = `run_${randomUUID()}`;
  const prompt = message.text.trim();
  const request: ImInvocationInput = {
    protocol_mode: "canonical",
    invocationId: `invoke_${randomUUID()}`,
    runId,
    sessionId: session.id,
    sessionGeneration: session.generation,
    providerEpoch: session.generation,
    agentSource,
    inputs: [{ type: "text", text: prompt }],
    contexts: snapshot,
    approvalMode: snapshot.items.find(
      (item) => item.namespace === "octo.security" && item.name === "approval_policy"
    )?.payload.mode as ApprovalMode,
    ...(session.providerSession ? { providerSession: session.providerSession } : {}),
    runMetadata: {
      ...message.runMetadata,
      // 可信身份覆盖可选 metadata，正文或自定义字段不能冒充当前发起人和会话。
      namespace: "im",
      platform: "wecom",
      eventId,
      sessionKey,
      actorId: message.senderId,
      channelId: message.conversationId,
      triggerOccurrenceId: occurrenceId
    }
  };
  session.lastEventId = eventId;
  session.lastRunId = runId;
  return { request, adapterType: selectedAdapter };
}

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
  mergeContext,
  type ApprovalMode,
  type ContextEnvelope,
  type InvokeInput
} from "@mininglamp-oss/octo-runtime-protocol";
import type { ImBotConfig, ImInboundMessage, ImSession } from "../contracts.js";
import { validateImConfig } from "../lifecycle/configuration.js";
import { compactHistoryGap, historyGapContext } from "../application/context-gap.js";

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
  validateImConfig(config);
  assertContextEnvelope(context);
  if (!session.id) throw new Error("IM_SESSION_NOT_ALLOCATED");
  const selectedAdapter =
    context.items.find((item) => item.namespace === "octo.execution" && item.name === "adapter")
      ?.payload.type ??
    config.adapter.adapter_type ??
    "codex";
  if (typeof selectedAdapter !== "string") throw new Error("IM_EXECUTION_CONFIG_INVALID");
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
  // Channel 只组装公开 InvokeInput；执行解析和指令渲染统一交给 Host，避免再次拒绝业务 Context。
  let submitted = context;
  let snapshot: ContextEnvelope | undefined;
  // 执行默认项也占协议预算；只降级本渠道自动追加的辅助材料，不丢弃显式业务项。
  for (const optional of [
    "history",
    "history-gap-compact",
    "mention-instructions",
    "history-gap",
    undefined
  ]) {
    try {
      snapshot = mergeContext(defaults, submitted);
      break;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "CONTEXT_BUDGET_EXCEEDED" || !optional)
        throw error;
      submitted = {
        ...submitted,
        items:
          optional === "history-gap-compact"
            ? submitted.items.flatMap((item) => {
                if (
                  item.namespace !== "extra.im" ||
                  item.name !== "history-gap" ||
                  item.payload.automatic !== true
                )
                  return [item];
                const compact = compactHistoryGap(item);
                return compact ? [compact] : [];
              })
            : submitted.items.filter(
                (item) =>
                  !(
                    item.namespace === "extra.im" &&
                    item.name === optional &&
                    item.payload.automatic === true
                  )
              )
      };
      if (optional === "history") {
        const history = context.items.find(
          (item) =>
            item.namespace === "extra.im" &&
            item.name === "history" &&
            item.payload.automatic === true
        );
        const source = history?.payload.source as Record<string, unknown> | undefined;
        if (
          source &&
          [2, 5].includes(Number(source.channelType)) &&
          !submitted.items.some(
            (item) =>
              item.namespace === "extra.im" &&
              item.name === "history-gap" &&
              item.payload.automatic !== true
          )
        ) {
          const existing = submitted.items.find(
            (item) => item.namespace === "extra.im" && item.name === "history-gap"
          );
          const replacement = existing
            ? {
                ...existing,
                payload: {
                  ...existing.payload,
                  status: "omitted",
                  materialProvided: false,
                  reason: "context-budget"
                }
              }
            : historyGapContext(source, message.messageId, {
                mode: "unavailable",
                beforeSeq: Number(history!.payload.upperMessageSeq),
                retrieval: "omitted",
                reason: "context-budget"
              });
          submitted.items = submitted.items.filter(
            (item) =>
              !(
                item.namespace === "extra.im" &&
                item.name === "history-gap" &&
                item.payload.automatic === true
              )
          );
          if (replacement) submitted.items.push(replacement);
        }
      }
    }
  }
  if (!snapshot) throw new Error("IM_EXECUTION_CONFIG_INVALID");
  const eventId = `evt_${randomUUID()}`,
    runId = `run_${randomUUID()}`;
  const prompt = message.buildInputs ? "[Image]" : message.text.trim();
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
      platform: "octo",
      eventId,
      sessionKey,
      actorId: message.senderId,
      channelId: message.conversationId,
      triggerOccurrenceId: occurrenceId
    }
  };
  if (
    config.adapter.workdir === undefined &&
    agentSource === "provisioned" &&
    workdir === defaultWorkdir
  )
    mkdirSync(defaultWorkdir, { recursive: true, mode: 0o700 });
  session.lastEventId = eventId;
  session.lastRunId = runId;
  return { request, adapterType: selectedAdapter };
}

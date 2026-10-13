/**
 * IM Context 构造：每轮按原消息地址获取群规则、话题规则和历史，形成标准 item 列表。
 * 通道选择并标注材料来源，不拼提示词、不按 session 缓存材料；AgentRun 统一封装。
 */
import {
  assertContextEnvelope,
  CONTEXT_SCHEMA,
  type ContextEnvelope,
  type ContextItem
} from "@mininglamp-oss/octo-harness-protocol";
import type { OctoBotConfig } from "../../contracts.js";
import type { ImMessage } from "./wukong.js";
import { groupScope } from "./normalize.js";
import { getGroupMd, getThreadMd, type RuleDocument } from "./api/rules.js";
import { getChannelMessages } from "./api/conversations.js";
import { OctoApiError } from "./api/errors.js";

export async function build_im_contexts(
  config: OctoBotConfig,
  message: ImMessage,
  botToken: string,
  signal: AbortSignal
): Promise<ContextItem[]> {
  const items: ContextItem[] = structuredClone(config.context?.items ?? []);
  const source = {
    service: config.apiUrl,
    spaceId: config.spaceId,
    botId: config.botId,
    channelId: message.channelId,
    channelType: message.channelType
  };
  const add = (name: string, payload: Record<string, unknown>): void => {
    if (items.some((item) => item.namespace === "extra.im" && item.name === name))
      throw new Error("IM_CONTEXT_KEY_CONFLICT");
    items.push({ namespace: "extra.im", name, payload: { source, ...payload } });
  };
  if (config.groupRules && [2, 5].includes(message.channelType)) {
    const scope = groupScope(message.channelId);
    const rule = async (name: string, read: () => Promise<RuleDocument>): Promise<void> => {
      try {
        const doc = await read();
        if (typeof doc.content !== "string" || !Number.isSafeInteger(doc.version))
          throw new Error("IM_RULE_PROTOCOL_INVALID");
        add(name, {
          ...scope,
          text: doc.content,
          version: doc.version,
          ...(doc.updated_at !== undefined ? { updatedAt: doc.updated_at } : {}),
          status: doc.content ? "present" : "empty"
        });
      } catch (error) {
        // 404 是材料缺失，可作为标准 item 记录；403/网络错误不能伪装为空规则继续执行。
        if (error instanceof OctoApiError && error.status === 404)
          add(name, { ...scope, status: "not_found" });
        else throw error;
      }
    };
    await rule("group-rules", () =>
      getGroupMd({ apiUrl: config.apiUrl, botToken, groupNo: scope.groupNo, signal })
    );
    if (scope.shortId)
      await rule("topic-rules", () =>
        getThreadMd({
          apiUrl: config.apiUrl,
          botToken,
          groupNo: scope.groupNo,
          shortId: scope.shortId!,
          signal
        })
      );
  }
  if (config.historyLimit) {
    const entries = await getChannelMessages({
      apiUrl: config.apiUrl,
      botToken,
      channelId: message.channelId,
      channelType: message.channelType,
      limit: config.historyLimit,
      endMessageSeq: message.messageSeq,
      signal
    });
    add("history", {
      upperMessageSeq: message.messageSeq,
      // 触发消息已经在 modelInput 中；只取它之前的历史，避免重复输入和读入未来消息。
      entries: entries
        .filter(
          (entry) =>
            entry.message_id !== message.messageId &&
            typeof entry.message_seq === "number" &&
            entry.message_seq < message.messageSeq
        )
        .sort((a, b) => a.message_seq! - b.message_seq!)
        .map((entry) =>
          Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined))
        )
    });
  }
  const envelope: ContextEnvelope = { schema: CONTEXT_SCHEMA, items };
  assertContextEnvelope(envelope);
  return items;
}

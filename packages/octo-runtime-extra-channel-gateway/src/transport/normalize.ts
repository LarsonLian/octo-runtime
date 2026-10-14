/**
 * 入站准入：从真实报文识别发送者、空间、群/话题和 @ 触发条件。
 * 正文自报身份不参与授权；话题关联父群只用于范围校验，回复仍使用原始地址。
 */
import type { ScopedOctoBotConfig } from "../contracts.js";
import type { ImMessage } from "./wukong.js";

export function groupScope(channelId: string): { groupNo: string; shortId?: string } {
  const separator = channelId.indexOf("____");
  return separator < 0
    ? { groupNo: channelId }
    : { groupNo: channelId.slice(0, separator), shortId: channelId.slice(separator + 4) };
}

export function acceptsImMessage(
  config: ScopedOctoBotConfig,
  owner: string,
  message: ImMessage
): boolean {
  if (
    message.fromUid === config.bot_id ||
    !message.messageId ||
    !message.channelId ||
    message.payload.type !== 1 ||
    typeof message.payload.content !== "string" ||
    (message.payload.space_id && message.payload.space_id !== config.spaceId)
  )
    return false;
  if (!(config.allowed_sender_ids ?? [owner]).includes(message.fromUid)) return false;
  if (message.channelType === 1) return true;
  if (
    ![2, 5].includes(message.channelType) ||
    !config.group_ids?.includes(groupScope(message.channelId).groupNo)
  )
    return false;
  const mention = message.payload.mention as { uids?: unknown } | undefined;
  return Array.isArray(mention?.uids) && mention.uids.includes(config.bot_id);
}

export function imSessionKey(config: ScopedOctoBotConfig, message: ImMessage): string {
  return [
    new URL(config.api_url).href,
    config.spaceId,
    config.bot_id,
    config.adapter.adapter_type ?? "codex",
    String(message.channelType),
    message.channelId
  ]
    .map(encodeURIComponent)
    .join("/");
}

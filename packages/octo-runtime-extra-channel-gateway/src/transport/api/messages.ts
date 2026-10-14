/**
 * 消息 API：封装文本、媒体、typing、已读与心跳等平台请求。
 * 调用方传入明确地址和凭据，幂等编号支持安全重试；此层不发起 AgentRun。
 */
// Adapted from Mininglamp-OSS/openclaw-channel-octo/src/api-fetch.ts.
import type { ChannelType } from "./types.js";
import {
  MessageType,
  type MentionEntity,
  type RichTextBlock,
  type SendMessageResult
} from "./types.js";
import { postJson, generateClientMsgNo } from "./client.js";

/**
 * Send a media message (image or file) to a channel.
 */
export async function sendMediaMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  type: MessageType;
  url: string;
  name?: string;
  size?: number;
  width?: number;
  height?: number;
  mentionUids?: string[];
  mentionEntities?: MentionEntity[];
  onBehalfOf?: string;
  clientMsgNo?: string;
  signal?: AbortSignal;
}): Promise<SendMessageResult | undefined> {
  // Last-line guard: never POST an empty channel_id — the server answers an
  // opaque 500. Upstream resolvers should already reject this, but any future
  // caller that bypasses them is stopped here. (#138)
  if (!params.channelId || !params.channelId.trim()) {
    throw new Error("octo: channelId is required to send a message");
  }
  const payload: Record<string, unknown> = {
    type: params.type,
    url: params.url
  };

  // Image (type=2) needs width/height/name/size; File (type=8) needs name/size
  if (params.type === MessageType.Image) {
    if (params.width) payload.width = params.width;
    if (params.height) payload.height = params.height;
    if (params.name) payload.name = params.name;
    if (params.size != null) payload.size = params.size;
  } else {
    if (params.name) payload.name = params.name;
    if (params.size != null) payload.size = params.size;
  }

  if (
    (params.mentionUids && params.mentionUids.length > 0) ||
    (params.mentionEntities && params.mentionEntities.length > 0)
  ) {
    const mention: Record<string, unknown> = {};
    if (params.mentionUids && params.mentionUids.length > 0) {
      mention.uids = params.mentionUids;
    }
    if (params.mentionEntities && params.mentionEntities.length > 0) {
      mention.entities = params.mentionEntities;
    }
    payload.mention = mention;
  }
  return await postJson<SendMessageResult>(
    params.apiUrl,
    params.botToken,
    "/v1/bot/sendMessage",
    {
      channel_id: params.channelId,
      channel_type: params.channelType,
      payload,
      client_msg_no: params.clientMsgNo ?? generateClientMsgNo(),
      ...(params.onBehalfOf ? { on_behalf_of: params.onBehalfOf } : {})
    },
    params.signal
  );
}

// SendMessageResult: use the canonical definition from types.ts
// (message_id is string due to int64 protection in postJson)

export async function sendMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  content: string;
  mentionUids?: string[];
  mentionEntities?: MentionEntity[];
  mentionAll?: boolean;
  replyMsgId?: string;
  onBehalfOf?: string;
  clientMsgNo?: string;
  signal?: AbortSignal;
}): Promise<SendMessageResult | undefined> {
  // Last-line guard: never POST an empty channel_id — the server answers an
  // opaque 500. Upstream resolvers should already reject this, but any future
  // caller that bypasses them is stopped here. (#138)
  if (!params.channelId || !params.channelId.trim()) {
    throw new Error("octo: channelId is required to send a message");
  }
  const payload: Record<string, unknown> = {
    type: MessageType.Text,
    content: params.content
  };
  // Add mention field if any UIDs specified, entities present, or mentionAll
  if (
    (params.mentionUids && params.mentionUids.length > 0) ||
    (params.mentionEntities && params.mentionEntities.length > 0) ||
    params.mentionAll
  ) {
    const mention: Record<string, unknown> = {};
    if (params.mentionUids && params.mentionUids.length > 0) {
      mention.uids = params.mentionUids;
    }
    if (params.mentionEntities && params.mentionEntities.length > 0) {
      mention.entities = params.mentionEntities;
    }
    if (params.mentionAll) {
      mention.all = 1;
    }
    payload.mention = mention;
  }
  // Add reply field if replyMsgId is provided
  if (params.replyMsgId) {
    payload.reply = { message_id: params.replyMsgId };
  }
  return await postJson<SendMessageResult>(
    params.apiUrl,
    params.botToken,
    "/v1/bot/sendMessage",
    {
      channel_id: params.channelId,
      channel_type: params.channelType,
      payload,
      client_msg_no: params.clientMsgNo ?? generateClientMsgNo(),
      ...(params.onBehalfOf ? { on_behalf_of: params.onBehalfOf } : {})
    },
    params.signal
  );
}

/**
 * 发送一条 RichText(=14) 图文混排消息。
 *
 * 替代「sendMessage 文本 + 循环 uploadMedia」的多次 HTTP：调用方先批量上传图片
 * 拿到 url（含 width/height），再把文本与图片按顺序组成一条 `content` block 数组
 * 提交。一条 payload = 一次 HTTP，server 端图文不再拆条。
 *
 * 契约（见 octo-lib richtext.go）：
 *   - `content` 必填且非空；text block 的 text 非空、image block 的 url 为
 *     http/https 且 width/height >0 —— 校验由调用方/ server 负责，本函数只组装。
 *   - `plain` 出站可附带（供老客户端/降级），server 会用 content 权威重算覆盖。
 *   - `client_msg_no` 默认自动生成（幂等去重），调用方可显式传入复用。
 */
export async function sendRichTextMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  blocks: RichTextBlock[];
  plain?: string;
  mentionUids?: string[];
  mentionEntities?: MentionEntity[];
  mentionAll?: boolean;
  replyMsgId?: string;
  onBehalfOf?: string;
  clientMsgNo?: string;
  signal?: AbortSignal;
}): Promise<SendMessageResult | undefined> {
  // Last-line guard: never POST an empty channel_id — the server answers an
  // opaque 500. Upstream resolvers should already reject this, but any future
  // caller that bypasses them is stopped here. (#138)
  if (!params.channelId || !params.channelId.trim()) {
    throw new Error("octo: channelId is required to send a message");
  }
  const payload: Record<string, unknown> = {
    type: MessageType.RichText,
    content: params.blocks
  };
  if (typeof params.plain === "string") {
    payload.plain = params.plain;
  }
  if (
    (params.mentionUids && params.mentionUids.length > 0) ||
    (params.mentionEntities && params.mentionEntities.length > 0) ||
    params.mentionAll
  ) {
    const mention: Record<string, unknown> = {};
    if (params.mentionUids && params.mentionUids.length > 0) {
      mention.uids = params.mentionUids;
    }
    if (params.mentionEntities && params.mentionEntities.length > 0) {
      mention.entities = params.mentionEntities;
    }
    if (params.mentionAll) {
      mention.all = 1;
    }
    payload.mention = mention;
  }
  if (params.replyMsgId) {
    payload.reply = { message_id: params.replyMsgId };
  }
  return await postJson<SendMessageResult>(
    params.apiUrl,
    params.botToken,
    "/v1/bot/sendMessage",
    {
      channel_id: params.channelId,
      channel_type: params.channelType,
      payload,
      client_msg_no: params.clientMsgNo ?? generateClientMsgNo(),
      ...(params.onBehalfOf ? { on_behalf_of: params.onBehalfOf } : {})
    },
    params.signal
  );
}

export async function sendTyping(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  onBehalfOf?: string;
  signal?: AbortSignal;
}): Promise<void> {
  await postJson(
    params.apiUrl,
    params.botToken,
    "/v1/bot/typing",
    {
      channel_id: params.channelId,
      channel_type: params.channelType,
      ...(params.onBehalfOf ? { on_behalf_of: params.onBehalfOf } : {})
      // A discardable hint, re-sent every few seconds while the model works. Retrying it
      // only adds pressure to a bucket that is already empty.
    },
    params.signal,
    { retryOn429: false }
  );
}

export async function sendReadReceipt(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  messageIds?: string[];
  signal?: AbortSignal;
}): Promise<void> {
  await postJson(
    params.apiUrl,
    params.botToken,
    "/v1/bot/readReceipt",
    {
      channel_id: params.channelId,
      channel_type: params.channelType,
      ...(params.messageIds && params.messageIds.length > 0
        ? { message_ids: params.messageIds }
        : {})
      // Same reasoning as typing: nothing downstream depends on this landing.
    },
    params.signal,
    { retryOn429: false }
  );
}

export async function sendHeartbeat(params: {
  apiUrl: string;
  botToken: string;
  signal?: AbortSignal;
}): Promise<void> {
  await postJson(params.apiUrl, params.botToken, "/v1/bot/heartbeat", {}, params.signal, {
    // A missed beat costs nothing: the next one is one interval away, and no server-side
    // reader consumes the heartbeat key. Sleeping inside the call would only add pressure
    // to a bucket that is already empty, and would hold the beat's single-flight slot.
    retryOn429: false
  });
}

/**
 * 会话读取 API：获取群、成员、用户与消息历史，保留平台身份和消息顺序信息。
 * 读取权限由 IM Server 决定，调用方负责选择本轮材料，接口层不组装 prompt。
 */
// Adapted from Mininglamp-OSS/openclaw-channel-octo/src/api-fetch.ts.
import type { ChannelType } from "./types.js";
import { DEFAULT_TIMEOUT_MS, postJson, getJson } from "./client.js";

// Fetch the groups the bot belongs to
export async function fetchBotGroups(params: {
  apiUrl: string;
  botToken: string;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<Array<{ group_no: string; name: string }>> {
  const url = `${params.apiUrl}/v1/bot/groups`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${params.botToken}`
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  });
  if (!resp.ok) {
    params.log?.error?.(`octo: fetchBotGroups failed: ${resp.status}`);
    return [];
  }
  const data = (await resp.json()) as Array<{ group_no: string; name: string }>;
  return Array.isArray(data) ? data : [];
}

/**
 * 获取群成员列表
 */
export interface GroupMember {
  uid: string;
  name: string;
  role?: string; // admin/member
  // 是否是机器人。后端把该 flag 序列化成数字（1/0），但历史上也出现过 boolean，
  // 故类型放宽为 boolean | number；消费端须同时认 `=== true` 和 `=== 1`。
  robot?: boolean | number;
}

export async function getGroupMembers(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string; // 群 ID (channel_id)
  signal?: AbortSignal;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<GroupMember[]> {
  const data = await getJson<{ members?: GroupMember[] } | GroupMember[]>(
    params.apiUrl,
    params.botToken,
    `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/members`,
    AbortSignal.any([AbortSignal.timeout(5000), ...(params.signal ? [params.signal] : [])]),
    { maxResponseBytes: 1 << 20, logRateLimit: false }
  );
  // Normalize to strict array to prevent silent failures
  const members =
    !Array.isArray(data) && Array.isArray(data?.members)
      ? data.members
      : Array.isArray(data)
        ? data
        : [];
  return members;
}

/** Decoded payload from base64 message content */
interface SyncMessagePayload {
  type?: number;
  content?: string;
  url?: string;
  name?: string;
  mention?: {
    all?: boolean;
    uids?: string[];
  };
}

/**
 * 获取频道历史消息（用于注入上下文）
 * @param params.log - Optional logger for consistent logging with OpenClaw log system
 */
export async function getChannelMessages(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  limit?: number;
  startMessageSeq?: number;
  endMessageSeq?: number;
  pullMode?: 0 | 1;
  retryOn429?: boolean;
  signal?: AbortSignal;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<
  Array<{
    from_uid: string;
    content: string;
    timestamp: number;
    message_id?: string;
    message_seq?: number;
    type?: number;
    url?: string;
    name?: string;
    payload?: SyncMessagePayload;
  }>
> {
  return (await getChannelMessagePage(params)).messages;
}

export async function getChannelMessagePage(
  params: Parameters<typeof getChannelMessages>[0]
): Promise<{ messages: Awaited<ReturnType<typeof getChannelMessages>>; more?: boolean }> {
  const limit = params.limit ?? 20;
  const data = await postJson<{
    more?: boolean | number;
    messages?: Array<{
      from_uid?: string;
      message_id?: string;
      message_seq?: number;
      timestamp?: number;
      payload?: string | SyncMessagePayload;
    }>;
  }>(
    params.apiUrl,
    params.botToken,
    "/v1/bot/messages/sync",
    {
      channel_id: params.channelId,
      channel_type: params.channelType,
      limit,
      start_message_seq: params.startMessageSeq ?? 0,
      end_message_seq: params.endMessageSeq ?? 0,
      pull_mode: params.pullMode ?? 1
    },
    AbortSignal.any([
      AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      ...(params.signal ? [params.signal] : [])
    ]),
    { maxResponseBytes: 1 << 20, logRateLimit: false, retryOn429: params.retryOn429 }
  );
  if (!Array.isArray(data?.messages)) throw new Error("IM_HISTORY_PROTOCOL_INVALID");
  if (data.more !== undefined && ![true, false, 0, 1].includes(data.more))
    throw new Error("IM_HISTORY_PROTOCOL_INVALID");
  const messages = data.messages;
  const decoded = messages.map((m) => {
    // payload is base64-encoded JSON string
    let payload: SyncMessagePayload = {};
    if (m.payload) {
      try {
        if (typeof m.payload !== "string") throw new Error("IM_HISTORY_OBJECT_PAYLOAD");
        const decoded = Buffer.from(m.payload, "base64").toString("utf-8");
        payload = JSON.parse(decoded) as SyncMessagePayload;
      } catch (decodeErr) {
        if (typeof m.payload !== "object" || Array.isArray(m.payload))
          throw new Error("IM_HISTORY_PROTOCOL_INVALID", { cause: decodeErr });
        payload = m.payload;
      }
    }
    return {
      from_uid: m.from_uid ?? "unknown",
      message_id: m.message_id ?? undefined,
      message_seq: m.message_seq ?? undefined,
      type: payload.type ?? undefined,
      url: payload.url ?? undefined,
      name: payload.name ?? undefined,
      content: payload.content ?? "",
      payload, // preserve full payload for types that need nested data (e.g. MultipleForward)
      // Convert seconds to milliseconds (API returns seconds, internal standard is ms)
      timestamp: (m.timestamp ?? Math.floor(Date.now() / 1000)) * 1000
    };
  });
  return { messages: decoded, ...(data.more !== undefined ? { more: Boolean(data.more) } : {}) };
}

/**
 * Fetch user info by UID. Requires backend `/v1/bot/user/info` endpoint.
 * Returns null if the endpoint is unavailable (404) or returns an error,
 * so callers can gracefully degrade.
 */
export async function fetchUserInfo(params: {
  apiUrl: string;
  botToken: string;
  uid: string;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<{ uid: string; name: string; avatar?: string } | null> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/user/info?uid=${encodeURIComponent(params.uid)}`;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${params.botToken}` },
      signal: AbortSignal.timeout(5000)
    });
    if (resp.status === 404) {
      // Endpoint not implemented yet — silent degrade
      return null;
    }
    if (!resp.ok) {
      params.log?.error?.(`octo: fetchUserInfo(${params.uid}) failed: ${resp.status}`);
      return null;
    }
    const data = (await resp.json()) as { uid?: string; name?: string; avatar?: string };
    if (data?.name) {
      return { uid: data.uid ?? params.uid, name: data.name, avatar: data.avatar };
    }
    return null;
  } catch (err) {
    params.log?.error?.(`octo: fetchUserInfo(${params.uid}) error: ${String(err)}`);
    return null;
  }
}

// ========== Space Members API ==========

export async function searchSpaceMembers(params: {
  apiUrl: string;
  botToken: string;
  keyword?: string;
  spaceId?: string;
  limit?: number;
}): Promise<Array<{ uid: string; name: string; robot: number }>> {
  const query = new URLSearchParams();
  if (params.keyword) query.set("keyword", params.keyword);
  if (params.spaceId) query.set("space_id", params.spaceId);
  if (params.limit) query.set("limit", String(params.limit));
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/space/members?${query.toString()}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`searchSpaceMembers failed (${resp.status}): ${text || resp.statusText}`);
  }
  return (await resp.json()) as Array<{ uid: string; name: string; robot: number }>;
}

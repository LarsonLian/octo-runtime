/**
 * 按钮报文解析：提取服务端确认的操作者与原卡片地址，供上层校验 Run 归属。
 * 表单 data 只是输入，不能覆盖可信身份；按钮不会被合成为新的普通聊天消息。
 */
// Adapted from openclaw-channel-octo/src/card-action.ts; parsing only, no synthesized message.
import { ChannelType, type BotEvent } from "./api/types.js";
export interface CardAction {
  eventId: number;
  messageId: string;
  channelId: string;
  channelType: ChannelType;
  actionId: string;
  inputs: Record<string, string>;
  operatorUid: string;
  data?: Record<string, unknown>;
  spaceId?: string;
  clientToken?: string;
  actedAt?: number;
}
function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function channelTypeValue(value: unknown): ChannelType | null {
  const numeric = typeof value === "number" ? value : Number(value);
  if (
    numeric !== Number(ChannelType.DM) &&
    numeric !== Number(ChannelType.Group) &&
    numeric !== Number(ChannelType.CommunityTopic)
  ) {
    return null;
  }
  return numeric;
}
/** Parse the server-authoritative card_action envelope without trusting form input values. */
export function parseCardAction(event: BotEvent): CardAction | null {
  if (
    !Number.isSafeInteger(event.event_id) ||
    event.event_id < 0 ||
    event.event_type !== "card_action" ||
    !event.event_data ||
    typeof event.event_data !== "object"
  ) {
    return null;
  }

  const data = event.event_data;
  const messageId = stringValue(data.message_id);
  const channelId = stringValue(data.channel_id);
  const channelType = channelTypeValue(data.channel_type);
  const actionId = stringValue(data.action_id);
  const operatorUid = stringValue(data.operator_uid);
  if (!messageId || !channelId || channelType === null || !actionId || !operatorUid) return null;

  const inputs: Record<string, string> = {};
  if (data.inputs && typeof data.inputs === "object" && !Array.isArray(data.inputs)) {
    for (const [key, value] of Object.entries(data.inputs as Record<string, unknown>)) {
      // The server contract serializes every submitted value as a string, but normalize a raw
      // JSON number/boolean (e.g. an Input.Number / Input.Toggle value) to its string form rather
      // than dropping it: a dropped field still passes validation (missing keys are allowed) and
      // would reach the agent as silently incomplete input. `false` / `0` must normalize too, so
      // this tests the type, not truthiness. Objects / arrays / null / non-finite numbers stay
      // dropped as malformed or unsupported envelope shapes.
      if (typeof value === "string") inputs[key] = value;
      else if (typeof value === "boolean") inputs[key] = String(value);
      else if (typeof value === "number" && Number.isFinite(value)) inputs[key] = String(value);
    }
  }

  const action: CardAction = {
    eventId: event.event_id,
    messageId,
    channelId,
    channelType,
    actionId,
    inputs,
    operatorUid
  };
  if (data.data && typeof data.data === "object" && !Array.isArray(data.data)) {
    action.data = data.data as Record<string, unknown>;
  }
  const spaceId = stringValue(data.space_id);
  if (spaceId) action.spaceId = spaceId;
  const clientToken = stringValue(data.client_token);
  if (clientToken) action.clientToken = clientToken;
  if (typeof data.acted_at === "number" && Number.isFinite(data.acted_at)) {
    action.actedAt = data.acted_at;
  }
  return action;
}

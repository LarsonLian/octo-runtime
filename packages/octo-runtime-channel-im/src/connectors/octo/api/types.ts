/**
 * Octo 线协议类型：保留平台消息、卡片、事件与媒体字段的原始含义。
 * 与 Provider/AgentRun 协议分离，跨层转换由 connector 完成，避免身份和状态混用。
 */
// Octo wire types copied from openclaw-channel-octo; independent of Provider events.

/**
 * 单个 mention 的精确位置描述。
 * offset/length 的单位为 UTF-16 code units（与 JS string.length 一致）。
 */
export interface MentionEntity {
  /** 被 @ 用户的唯一标识符 */
  uid: string;
  /** @name 在 content 中的起始位置（包括 @ 符号） */
  offset: number;
  /** @name 的完整长度（包括 @ 符号） */
  length: number;
}

export interface SendMessageResult {
  message_id: string; // string due to int64 protection in postJson
  client_msg_no: string;
  message_seq: number;
}

/** Channel types */
export enum ChannelType {
  DM = 1,
  Group = 2,
  CommunityTopic = 5 // Thread/子区
}

/** Message content types */
export enum MessageType {
  Text = 1,
  Image = 2,
  GIF = 3,
  Voice = 4,
  Video = 5,
  Location = 6,
  Card = 7,
  File = 8,
  MultipleForward = 11,
  /**
   * 图文混排（rich text）。复用 octo-lib Phase 0 已定的 ContentType=14（见
   * octo-lib common/richtext.go）。正文以有序 `content` block 数组承载，数组
   * 顺序即图文穿插顺序；顶层 `plain` 为冗余纯文本，契约上由 server 权威生成。
   */
  RichText = 14,
  /**
   * 交互卡片（Adaptive Cards 1.5 子集，"octo/v1" profile）。对应 octo-server
   * PR #525 P1 `card-message-protocol`，ContentType=17。
   *
   * ⚠️ 与 `Card=7`（名片/contact card）语义无关 —— octo-server Decision 1 明确
   * InteractiveCard(17) ≠ common.Card(7)，不要把新逻辑接到 7 上。
   *
   * payload 信封：`{ type:17, card:{标准 AC1.5 JSON}, plain:"(server 权威重算)" }`
   * + 顶层 `profile`/`card_version`。adapter 入站仅消费服务端权威 `plain`。
   */
  InteractiveCard = 17
}

/** RichText(=14) 单个 block 类型常量（与 octo-lib RichTextBlockText/Image 对齐）。 */
export const RICH_TEXT_BLOCK_TEXT = "text";

export const RICH_TEXT_BLOCK_IMAGE = "image";

/**
 * RichText(=14) `content` 数组中的单个 block。
 *   - type=text  使用 `text`（纯文本，MVP 不渲染 markdown）；
 *   - type=image 使用 `url`/`width`/`height`（`size`、`name` 可选）。
 *
 * ⚠️ 命名锁定（见 octo-lib richtext.go）：禁止使用 entities + offset/length。
 */
export interface RichTextBlock {
  type: string;
  /** text block 文本内容（type=text 必填且非空）。 */
  text?: string;
  /** image block 图片地址（type=image 必填，scheme 仅 http/https）。 */
  url?: string;
  /** image block 宽度（像素，契约必填且 >0，供端上占位排版避免抖动）。 */
  width?: number;
  /** image block 高度（像素，契约必填且 >0）。 */
  height?: number;
  /** image block 字节大小（可选）。 */
  size?: number;
  /** image block 原始文件名（可选）。 */
  name?: string;
}

export interface BotEvent {
  event_id: number;
  event_type?: string;
  event_data?: Record<string, unknown>;
  message?: Record<string, unknown>;
}

/**
 * 卡片 API：读取 Bot 的有效能力配置，按模板引用发送/编辑卡片。
 * 展示数据需符合服务端合同；模板选择与 Run 状态转换由卡片层负责。
 */
// Adapted from Mininglamp-OSS/openclaw-channel-octo/src/api-fetch.ts.
import type { ChannelType } from "./types.js";
import { MessageType, type SendMessageResult } from "./types.js";
import { postJson, generateClientMsgNo, DEFAULT_TIMEOUT_MS } from "./client.js";
import { OctoApiError } from "./errors.js";

export interface CardTemplateRef {
  id: string;
  version: string;
}

/** Effective per-bot card policy returned by GET /v1/bot/card/profile. */
export interface BotCardConfig {
  card_enabled: boolean;
  display_enabled: boolean;
  interaction_enabled: boolean;
  reasoning_enabled: boolean;
  reasoning_template_ref: CardTemplateRef | null;
}

export interface CardTemplateViewCapability {
  name: string;
  states: string[];
  wire_profile: string;
  submit_actions: string[];
}

export interface CardTemplateCapability {
  id: string;
  version: string;
  available?: boolean;
  views: CardTemplateViewCapability[];
}

export interface CardTemplatingCapability {
  supported: boolean;
  wire: string;
  templates: CardTemplateCapability[];
}

function validateTemplateFrame(params: {
  templateRef: CardTemplateRef;
  state: string;
  data: object;
}): void {
  const templateRef = params.templateRef as unknown;
  if (templateRef === null || typeof templateRef !== "object" || Array.isArray(templateRef)) {
    throw new Error("octo: templateRef must contain exactly id and version");
  }
  const templateRefKeys = Object.keys(templateRef);
  if (
    templateRefKeys.length !== 2 ||
    !templateRefKeys.includes("id") ||
    !templateRefKeys.includes("version")
  ) {
    throw new Error("octo: templateRef must contain exactly id and version");
  }
  const { id, version } = templateRef as Record<string, unknown>;
  if (typeof id !== "string" || typeof version !== "string" || !id.trim() || !version.trim()) {
    throw new Error("octo: templateRef id/version are required");
  }
  if (typeof params.state !== "string" || !params.state.trim()) {
    throw new Error("octo: template state is required");
  }
  const data = params.data as unknown;
  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    (Object.getPrototypeOf(data) !== Object.prototype && Object.getPrototypeOf(data) !== null) ||
    !Object.hasOwn(data, "state")
  ) {
    throw new Error("octo: data must be a plain object with own state");
  }
  if ((data as { state: unknown }).state !== params.state) {
    throw new Error("octo: data.state must match state");
  }
}

/**
 * Send one Registry-authored type-17 card without any Model B render-owned fields.
 *
 * `onBehalfOf` is intentionally absent (unlike {@link sendCardMessage}): Registry template cards
 * are bot-authored by design, and OBO + type-17 is rejected by P1 Decision 2b — persona-clone
 * turns skip progress cards entirely in `card-progress.ts`.
 */
export async function sendTemplateCardMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  templateRef: CardTemplateRef;
  state: string;
  data: object;
  clientMsgNo?: string;
  signal?: AbortSignal;
  /**
   * Forwarded to postJson. A transient progress frame passes false: it is discardable,
   * and holding the flush while we back off would block the frames behind it. A finalize
   * frame leaves it unset, because that state has to land.
   */
  retryOn429?: boolean;
}): Promise<SendMessageResult | undefined> {
  if (!params.channelId.trim()) {
    throw new Error("octo: channelId is required to send a message");
  }
  validateTemplateFrame(params);
  return await postJson<SendMessageResult>(
    params.apiUrl,
    params.botToken,
    "/v1/bot/sendMessage",
    {
      channel_id: params.channelId,
      channel_type: params.channelType,
      payload: {
        type: MessageType.InteractiveCard,
        template_ref: params.templateRef,
        state: params.state,
        data: params.data
      },
      client_msg_no: params.clientMsgNo ?? generateClientMsgNo()
    },
    params.signal,
    { retryOn429: params.retryOn429 ?? true }
  );
}

/** Replace one Registry-authored card frame; raw content_edit is intentionally unavailable. */
export async function editTemplateCardMessage(params: {
  apiUrl: string;
  botToken: string;
  messageId: string;
  channelId: string;
  channelType: ChannelType;
  templateRef: CardTemplateRef;
  state: string;
  data: object;
  cardSeq: number;
  transient?: boolean;
  signal?: AbortSignal;
  /**
   * Forwarded to postJson. A transient progress frame passes false: it is discardable,
   * and holding the flush while we back off would block the frames behind it. A finalize
   * frame leaves it unset, because that state has to land.
   */
  retryOn429?: boolean;
}): Promise<void> {
  if (!params.messageId) throw new Error("octo: messageId is required to edit a card");
  if (!params.channelId.trim()) throw new Error("octo: channelId is required to edit a card");
  if (!Number.isSafeInteger(params.cardSeq) || params.cardSeq <= 0) {
    throw new Error("octo: cardSeq must be a positive safe integer");
  }
  validateTemplateFrame(params);
  await postJson(
    params.apiUrl,
    params.botToken,
    "/v1/bot/message/edit",
    {
      message_id: params.messageId,
      channel_id: params.channelId,
      channel_type: params.channelType,
      template_ref: params.templateRef,
      state: params.state,
      data: params.data,
      card_seq: params.cardSeq,
      ...(params.transient ? { transient: true } : {})
    },
    params.signal,
    { retryOn429: params.retryOn429 ?? true }
  );
}

/**
 * D12 生产者能力发现 manifest（octo-server PR #525 P2 D12，additive-only）。
 */
export interface CardProfileManifest {
  /**
   * D12 manifest 端点是否**已部署并响应**（非 404）。`false` 时所有卡片能力 fail
   * closed；插件不再使用本地开关或本地推理卡模板兜底。
   */
  available: boolean;
  /** 兼容保留的 manifest 总闸；实际发送使用 `config` 中服务端已 AND 的有效值。 */
  enabled: boolean;
  /** 支持的 profile 列表，如 `["octo/v1"]`（P2 增 `"octo/v2"`）。 */
  profiles?: string[];
  card_version?: string;
  /**
   * 服务端 advertise 的元素/输入白名单（源自 pkg/cardmsg 权威，additive）。producer 据此按
   * 元素/输入粒度协商 —— 即便 card_version 停在 1.5，也能探测该部署到底吃不吃某元素/输入。
   * 旧部署不返这两字段（undefined）→ 消费方回退保守基线。
   */
  elements?: string[];
  inputs?: string[];
  /**
   * 本地/导航动作白名单(pkg/cardmsg 权威):`Action.ToggleVisibility`/
   * `Action.CopyToClipboard`/`Action.OpenUrl`。回流 `Action.Submit` 不在此数组中；它由
   * `profiles` 包含 `octo/v2` 表示，也不得放进展示卡 selectAction。
   * 旧部署不返该字段(undefined) → 消费方保守视为不支持任何 action。
   */
  actions?: string[];
  /** 尺寸/结构上限（node/depth/body caps 等）。 */
  limits?: Record<string, unknown>;
  /** Optional Registry template-ref/v1 capability and explicit Bot catalog. */
  templating?: CardTemplatingCapability;
  /** Effective per-bot policy. Each feature flag already includes the server's global gate. */
  config?: BotCardConfig;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseTemplatingCapability(value: unknown): CardTemplatingCapability | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  const templates: CardTemplateCapability[] = [];
  for (const candidate of Array.isArray(root.templates) ? root.templates : []) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const template = candidate as Record<string, unknown>;
    if (typeof template.id !== "string" || typeof template.version !== "string") continue;
    const views: CardTemplateViewCapability[] = [];
    for (const candidateView of Array.isArray(template.views) ? template.views : []) {
      if (!candidateView || typeof candidateView !== "object" || Array.isArray(candidateView))
        continue;
      const view = candidateView as Record<string, unknown>;
      if (typeof view.name !== "string" || typeof view.wire_profile !== "string") continue;
      views.push({
        name: view.name,
        wire_profile: view.wire_profile,
        states: stringArray(view.states),
        submit_actions: stringArray(view.submit_actions)
      });
    }
    templates.push({
      id: template.id,
      version: template.version,
      views,
      ...(typeof template.available === "boolean" ? { available: template.available } : {})
    });
  }
  return {
    supported: root.supported === true,
    wire: typeof root.wire === "string" ? root.wire : "",
    templates
  };
}

function parseCardTemplateRef(value: unknown): CardTemplateRef | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const ref = value as Record<string, unknown>;
  if (
    Object.keys(ref).length !== 2 ||
    typeof ref.id !== "string" ||
    !ref.id ||
    ref.id.trim() !== ref.id ||
    typeof ref.version !== "string" ||
    !ref.version ||
    ref.version.trim() !== ref.version
  ) {
    return undefined;
  }
  return { id: ref.id, version: ref.version };
}

function parseBotCardConfig(value: unknown): BotCardConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const config = value as Record<string, unknown>;
  if (
    typeof config.card_enabled !== "boolean" ||
    typeof config.display_enabled !== "boolean" ||
    typeof config.interaction_enabled !== "boolean" ||
    typeof config.reasoning_enabled !== "boolean"
  ) {
    return undefined;
  }
  if (
    !config.card_enabled &&
    (config.display_enabled || config.interaction_enabled || config.reasoning_enabled)
  ) {
    return undefined;
  }
  const reasoningRef = parseCardTemplateRef(config.reasoning_template_ref);
  // The server guarantees this invariant. Reject a malformed response rather than guessing a
  // policy locally: a permissive normalization could re-enable a card the Bot owner disabled.
  if (
    reasoningRef === undefined ||
    (config.reasoning_enabled && reasoningRef === null) ||
    (!config.reasoning_enabled && reasoningRef !== null)
  ) {
    return undefined;
  }
  return {
    card_enabled: config.card_enabled,
    display_enabled: config.display_enabled,
    interaction_enabled: config.interaction_enabled,
    reasoning_enabled: config.reasoning_enabled,
    reasoning_template_ref: reasoningRef
  };
}

/**
 * GET /v1/bot/card/profile — D12 能力发现。发卡前 feature-detect，避免用发送试探
 * （一个 400 无法区分「disabled」与「invalid」）。
 *
 * 返回 `available` 区分端点未部署与已部署；两者都由调用方 fail closed：
 *   - 端点未部署（404）→ `{ available:false }`。
 *   - 端点已部署但缺失/非法 `config` → `{ available:true }` 且无 `config`。
 * 传输 / 5xx 抛错，交由调用方重试节奏处理。
 */
export async function getCardProfile(params: {
  apiUrl: string;
  botToken: string;
  signal?: AbortSignal;
}): Promise<CardProfileManifest> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/card/profile`;
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  });
  // 端点尚未部署时 fail closed；不使用本地开关猜测服务端 Bot 策略。
  if (resp.status === 404) return { available: false, enabled: false };
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    // Structured, so a caller can tell a rate limit from any other failure and honour the
    // wait the server asked for. This is the one hot path that does not go through postJson,
    // and flattening a 429 into a generic Error here threw away the Retry-After that the
    // progress-card cooldown needs.
    throw OctoApiError.from(resp, "GET /v1/bot/card/profile", text);
  }
  // 端点已部署（available:true）；manifest 内容异常时保守视作 enabled:false。
  const raw = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return { available: true, enabled: false };
  const templating = parseTemplatingCapability(raw.templating);
  const config = parseBotCardConfig(raw.config);
  return {
    available: raw.available !== false,
    // 兼容布尔与 1/0 序列化(与本仓 GroupMember.robot / getMentionPref 的 flag 惯例一致)。
    enabled: raw.enabled === true || raw.enabled === 1,
    ...(Array.isArray(raw.profiles)
      ? { profiles: (raw.profiles as unknown[]).filter((e): e is string => typeof e === "string") }
      : {}),
    ...(typeof raw.card_version === "string" ? { card_version: raw.card_version } : {}),
    ...(Array.isArray(raw.elements)
      ? { elements: (raw.elements as unknown[]).filter((e): e is string => typeof e === "string") }
      : {}),
    ...(Array.isArray(raw.inputs)
      ? { inputs: (raw.inputs as unknown[]).filter((e): e is string => typeof e === "string") }
      : {}),
    ...(Array.isArray(raw.actions)
      ? { actions: (raw.actions as unknown[]).filter((e): e is string => typeof e === "string") }
      : {}),
    ...(raw.limits && typeof raw.limits === "object"
      ? { limits: raw.limits as Record<string, unknown> }
      : {}),
    ...(templating ? { templating } : {}),
    ...(config ? { config } : {})
  };
}

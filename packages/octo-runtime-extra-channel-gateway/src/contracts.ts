/**
 * Octo gateway 配置、入站消息、执行端口和投递回执。
 */
import type {
  ApprovalMode,
  ContextEnvelope,
  ContextItem,
  CanonicalEvent,
  InteractionResponse,
  InteractionRequestedPayload,
  InvokeInput,
  InvokeEnvironment,
  ModelInputPart,
  ProviderSession
} from "@mininglamp-oss/octo-runtime-protocol";
import type { RunPresentation } from "./presentation/run-projector.js";
import type { ImGapPlan, ImGapTurnToken } from "./application/context-gap.js";

export interface ImPositionObservation {
  conversationId: string;
  conversationKind: "group" | "thread";
  messageSeq: number;
  own?: boolean;
  turn?: ImGapTurnToken;
}

export interface ImAdapterConfig {
  adapter_type?: string;
  workdir?: string;
  model?: string;
  effort?: string;
  provider_agent_id?: string;
}

export interface ImCommonConfig {
  bot_id: string;
  bot_name?: string;
  enabled?: boolean;
  adapter: ImAdapterConfig;
  context?: ContextEnvelope;
  approval_mode?: ApprovalMode;
  run_timeout_ms?: number;
  /** Codex 专用的故障恢复预算；不会让其他 Adapter 自动重跑。 */
  codex_retry?: {
    enabled?: boolean;
    max_consecutive_retries?: number;
    max_total_retries?: number;
    recovery_timeout_ms?: number;
    initial_delay_ms?: number;
    max_delay_ms?: number;
  };
  allowed_sender_ids?: string[];
}

export interface OctoBotConfig extends ImCommonConfig {
  api_url: string;
  bf_token?: string;
  /** .octospec/tasks/channel-group-admission/plan.md：群/话题入口开关，省略为 true，不影响私聊。 */
  groups_enabled?: boolean;
  /** 仅约束群范围；省略、null、[] 均不增加限制，关闭入口使用 groups_enabled=false。 */
  group_ids?: string[] | null;
  cards?: boolean;
  typing?: boolean;
}

export type ImBotConfig = OctoBotConfig;
/** Authenticated scope, resolved from octo-auth rather than caller configuration. */
export type ScopedOctoBotConfig = OctoBotConfig & { spaceId: string };

/** 平台归一化后的单条消息。平台回调身份与正文保留在 connector 的闭包内。 */
export interface ImInboundMessage {
  position?: { messageSeq: number };
  historyRetry?: boolean;
  bindHistoryTurn?(token: ImGapTurnToken): void;
  markRead?(signal: AbortSignal): Promise<void>;
  messageId: string;
  senderId: string;
  conversationId: string;
  conversationKind: "direct" | "group" | "thread";
  text: string;
  buildInputs?(signal: AbortSignal): Promise<ModelInputPart[]>;
  reply(text: string, effectKey?: string): Promise<void>;
  replyFinal?(text: string, effectKey: string): Promise<void>;
  replyFailure?(event: CanonicalEvent, effectKey: string): Promise<void>;
  replyDeliveryUnknown?(
    event: CanonicalEvent,
    effectKey: string,
    replyEffectKey: string,
    signal: AbortSignal
  ): Promise<void>;
  isReplyDelivered?(effectKey: string): boolean;
  buildContext(
    signal: AbortSignal,
    options?: {
      initialSession: boolean;
      mentionGuidance?: boolean;
      configuredItems?: readonly ContextItem[];
      historyGap?: ImGapPlan;
      onHistoryGapPrepared?(plan: ImGapPlan): void;
    }
  ): Promise<ContextEnvelope>;
  executionEnvironment?(): InvokeEnvironment;
  runMetadata?: Record<string, unknown>;
  beginPresentation?(
    runId: string,
    onDiagnostic: (code: string) => void,
    controls: ImRunControls
  ): ImPresentation;
}

export interface ImPresentation {
  interaction?(request: InteractionRequestedPayload): Promise<boolean>;
  resolveInteraction?(id: string, status: string): Promise<void>;
  update(snapshot: RunPresentation): void;
  finish(): Promise<void>;
}
/** 控制原执行；平台连接器先验证真实操作者和原卡片身份。 */
export interface ImRunControls {
  respond?(response: InteractionResponse): Promise<void>;
  cancel(): Promise<boolean>;
  retry(senderId: string, occurrenceId: string): boolean;
}

export interface ImTaskAttempt {
  runId: string;
  invocationId: string;
  outcome: string;
  failureCode?: string;
  diagnosticId?: string;
}

export interface ChannelCallbacks {
  onPosition?(position: ImPositionObservation): void;
  authorizeSpace?: (spaceId: string) => void;
  onMessage(message: ImInboundMessage): void;
  onDisconnect(code: string, retryable?: boolean): void;
  onDiagnostic?(code: string): void;
}

export interface ImAddress {
  channelId: string;
  channelType: number;
}
export type ImConnectionState = "stopped" | "connecting" | "online" | "retrying" | "failed";

export interface ImExecutionPort {
  invoke(
    input: InvokeInput & { protocol_mode: "canonical" },
    environment?: InvokeEnvironment
  ): AsyncIterable<CanonicalEvent>;
  cancel(invocationId: string, reason?: string): Promise<{ cancelled: boolean }>;
  respondInteraction(invocationId: string, response: InteractionResponse): Promise<void>;
}

export interface ImSession {
  id?: string;
  generation: number;
  providerSession?: ProviderSession;
  lastEventId?: string;
  lastRunId?: string;
  activeInvocationId?: string;
  pending: number;
  tail: Promise<void>;
  /** 同代次排队快照共享资格对象；reset 替换对象，不修改旧请求。 */
  initialization?: { attempted: boolean };
}

export type DeliveryState = "pending" | "delivered" | "failed" | "unknown";
export interface ImDeliveryReceipt {
  effectKey: string;
  state: DeliveryState;
  messageId?: string;
  code?: string;
}

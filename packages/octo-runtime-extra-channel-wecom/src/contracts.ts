/**
 * 企业微信 channel 配置、入站消息、执行端口和投递回执。
 */
import type {
  ApprovalMode,
  ContextEnvelope,
  ContextItem,
  CanonicalEvent,
  InteractionResponse,
  InvokeInput,
  ProviderSession
} from "@mininglamp-oss/octo-runtime-protocol";
import type { RunPresentation } from "./presentation/run-projector.js";

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
  allowed_sender_ids?: string[];
}

export interface WecomBotConfig extends ImCommonConfig {
  app_secret?: string;
  ws_url?: string;
}

export type ImBotConfig = WecomBotConfig;

/** 平台归一化后的单条消息。平台回调身份与正文保留在 connector 的闭包内。 */
export interface ImInboundMessage {
  messageId: string;
  senderId: string;
  conversationId: string;
  conversationKind: "direct" | "group" | "thread";
  text: string;
  reply(text: string, effectKey?: string): Promise<void>;
  buildContext(
    signal: AbortSignal,
    options?: { configuredItems?: readonly ContextItem[] }
  ): Promise<ContextEnvelope>;
  runMetadata?: Record<string, unknown>;
  beginPresentation?(
    runId: string,
    onDiagnostic: (code: string) => void,
    controls: ImRunControls
  ): ImPresentation;
}

export interface ImPresentation {
  update(snapshot: RunPresentation): void;
  finish(): Promise<void>;
}
/** 控制原执行；平台连接器先验证真实操作者和原卡片身份。 */
export interface ImRunControls {
  cancel(): Promise<boolean>;
  retry(senderId: string, occurrenceId: string): boolean;
}

export interface ChannelCallbacks {
  authorizeSpace?: (spaceId: string) => void;
  onMessage(message: ImInboundMessage): void;
  onDisconnect(code: string, retryable?: boolean): void;
  onDiagnostic?(code: string): void;
}

export interface ImAddress {
  channelId: string;
  channelType: number;
}
export type ImConnectionState =
  | "stopped"
  | "waiting_credentials"
  | "connecting"
  | "online"
  | "retrying"
  | "authentication_failed";

export interface ImExecutionPort {
  invoke(
    input: InvokeInput & { protocol_mode: "canonical" },
    environment?: { signal?: AbortSignal }
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
}

export type DeliveryState = "pending" | "delivered" | "failed" | "unknown";
export interface ImDeliveryReceipt {
  effectKey: string;
  state: DeliveryState;
  messageId?: string;
  code?: string;
}

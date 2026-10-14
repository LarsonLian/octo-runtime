/**
 * 跨平台合同：统一配置、入站消息、执行端口和投递回执。
 * 平台字段留在各自配置分支，业务材料通过标准 Context 传递，避免上层依赖平台报文。
 */
import type {
  ApprovalMode,
  ContextEnvelope,
  CanonicalEvent,
  InteractionResponse,
  InvokeRequest,
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
  enabled?: boolean;
  adapter: ImAdapterConfig;
  context?: ContextEnvelope;
  approval_mode?: ApprovalMode;
  run_timeout_ms?: number;
  allowed_sender_ids?: string[];
}

export interface OctoBotConfig extends ImCommonConfig {
  type: "octo";
  api_url: string;
  bf_token?: string;
  bf_token_file?: string;
  group_ids?: string[];
  group_rules?: boolean;
  history_limit?: number;
  cards?: boolean;
  typing?: boolean;
}

export interface WecomBotConfig extends ImCommonConfig {
  type: "wecom";
  app_secret?: string;
  app_secret_file?: string;
  ws_url?: string;
}

export type ImBotConfig = OctoBotConfig | WecomBotConfig;
/** Authenticated scope, resolved from octo-auth rather than caller configuration. */
export type ScopedOctoBotConfig = OctoBotConfig & { spaceId: string };

/** 平台归一化后的单条消息。平台回调身份与正文保留在 connector 的闭包内。 */
export interface ImInboundMessage {
  messageId: string;
  senderId: string;
  conversationId: string;
  conversationKind: "direct" | "group" | "thread";
  text: string;
  reply(text: string, effectKey?: string): Promise<void>;
  buildContext(signal: AbortSignal): Promise<ContextEnvelope>;
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

/** IM 平台连接器公共合同；不是 MCP 连接器，不负责 MCP 工具或 Server 管理。 */
export interface ImConnector {
  readonly identity: string;
  readonly botId: string;
  readonly status: { connected: boolean; error?: string; [key: string]: unknown };
  start(signal: AbortSignal): Promise<void>;
  close(): void;
}

export interface ImConnectorCallbacks {
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
    adapterType: string,
    request: InvokeRequest,
    options: { protocolMode: "canonical" }
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

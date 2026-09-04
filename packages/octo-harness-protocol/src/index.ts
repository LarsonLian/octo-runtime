import { randomUUID } from "node:crypto";
import type {
  CanonicalEventPayload,
  ChannelContextAppend,
  ChannelContextDescriptor,
  ChannelMessageFact,
  ChannelScope,
  ContextSyncResult,
  InvokeRequestWire,
  MessageExposure,
  ToolCallCreatePayload,
  ToolCallDeltaPayload,
  ToolCallUpdatePayload
} from "./generated/protocol-types.js";

// 数据形状类型由 schema/protocol.schema.json 生成，见 ./generated/protocol-types.ts。
// 这里从生成文件重新导出，保持 `@mininglamp-oss/octo-harness-protocol` 的公共导出面不变。
export type {
  MessageChannel,
  MessageExposure,
  MessageProvenance,
  ProviderSession,
  AgentConfig,
  CanonicalEventPayload,
  ToolCallCreatePayload,
  ToolCallDeltaPayload,
  ToolCallUpdatePayload,
  ChannelScope,
  ChannelMessagePart,
  ChannelMessageSender,
  ChannelMessageFlags,
  ChannelMessageFact,
  ChannelContextAppend,
  ContextSyncRequest,
  ContextSyncResult,
  ChannelContextDescriptor,
  ChannelContextSnapshotRef,
  ContextCommitResult,
  RunIdentity,
  InvokeRequestWire
} from "./generated/protocol-types.js";
import type { RunIdentity } from "./generated/protocol-types.js";

/**
 * 一次 Run 允许出现的三个终态。
 *
 * `finished` 表示正常完成，`error` 表示执行失败，`stopped` 表示主动取消或流被中止。
 * Adapter Host 负责保证每个 invocation 最终只向上游交付其中一个终态。
 */
export const TERMINAL_EVENT_TYPES = ["run.finished", "run.error", "run.stopped"] as const;
export type TerminalEventType = (typeof TERMINAL_EVENT_TYPES)[number];

/**
 * Core 能持久化和上层 UI 能消费的稳定事件集合。
 *
 * 生命周期大致为：Run 排队/运行 -> 消息、工具、Surface、用量更新 -> Run 终态。
 * Provider 原生事件名必须在 adapter 内转换，不应直接穿透到这里。
 */
export const CANONICAL_EVENT_TYPES = [
  "session.update", "usage.update",
  "message.create", "message.delta", "message.update",
  "tool_call.create", "tool_call.delta", "tool_call.update",
  "surface.create", "surface.delta", "surface.update",
  "run.queued", "run.running",
  ...TERMINAL_EVENT_TYPES
] as const;

/** 所有 provider 的原生事件最终只允许落到这组类型，Core 因此不感知底层 CLI。 */
export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];

export type CanonicalPayloadFor<TType extends CanonicalEventType> =
  TType extends "tool_call.create" ? CanonicalEventPayload & ToolCallCreatePayload
    : TType extends "tool_call.delta" ? CanonicalEventPayload & ToolCallDeltaPayload
      : TType extends "tool_call.update" ? CanonicalEventPayload & ToolCallUpdatePayload
        : CanonicalEventPayload;

/** Adapter 向 Host 输出的最小事件单元；tool lifecycle 的 payload 会按 type 收窄。 */
export type CanonicalEvent<TType extends CanonicalEventType = CanonicalEventType> =
  TType extends CanonicalEventType
    ? { type: TType; payload: CanonicalPayloadFor<TType> }
    : never;

/**
 * Core 发给 Adapter Host 的一次执行请求。
 *
 * 可序列化字段来自生成的 {@link InvokeRequestWire}；`signal` 是不可跨进程序列化的运行时对象，
 * 只在进程内调用时存在，因此在此处交叉进来而不进入 schema。
 */
export interface InvokeRequest extends InvokeRequestWire {
  /** Host 取消 invocation 时触发；adapter 应传播到子进程或协议 cancel。 */
  signal?: AbortSignal;
}

/** Provider adapters must use this accessor so hidden context is sent exactly once when present. */
export function providerInputText(request: InvokeRequest): string {
  return request.modelInput ?? request.prompt;
}

/** Exact alternate input for a provider that could not resume its session. */
export function freshFallbackInputText(request: InvokeRequest): string {
  return request.freshFallbackModelInput ?? providerInputText(request);
}

/** Runtime validation at the Agent Work plugin boundary; JSON schema remains the wire source of truth. */
export function assertChannelScope(value: unknown): asserts value is ChannelScope {
  if (!isRecord(value)) throw new TypeError("channel context scope must be an object");
  for (const key of ["tenant_id", "endpoint_id", "channel", "bot_id", "conversation_id"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new TypeError(`channel context scope.${key} must be a non-empty string`);
    }
  }
  if (!(typeof value.account_id === "string" || value.account_id === null)) {
    throw new TypeError("channel context scope.account_id must be a string or null");
  }
  if (value.thread_id !== undefined && value.thread_id !== null && typeof value.thread_id !== "string") {
    throw new TypeError("channel context scope.thread_id must be a string, null, or omitted");
  }
}

export function assertChannelMessageFact(value: unknown): asserts value is ChannelMessageFact {
  if (!isRecord(value)) throw new TypeError("channel context fact must be an object");
  if (typeof value.message_id !== "string" || value.message_id.length === 0) {
    throw new TypeError("channel context fact.message_id must be a non-empty string");
  }
  if (value.message_seq !== undefined && (!Number.isSafeInteger(value.message_seq) || Number(value.message_seq) < 0)) {
    throw new TypeError("channel context fact.message_seq must be a non-negative safe integer when present");
  }
  const sender = value.sender;
  if (!isRecord(sender) || typeof sender.id !== "string" || sender.id.length === 0) {
    throw new TypeError("channel context fact.sender.id must be a non-empty string");
  }
  if (typeof sender.kind !== "string" || sender.kind.length === 0) {
    throw new TypeError("channel context fact.sender.kind must be a non-empty string");
  }
  if (sender.label !== undefined && typeof sender.label !== "string") {
    throw new TypeError("channel context fact.sender.label must be a string when present");
  }
  if (!Number.isSafeInteger(value.occurred_at_ms) || Number(value.occurred_at_ms) <= 0) {
    throw new TypeError("channel context fact.occurred_at_ms must be a positive safe integer");
  }
  if (!Array.isArray(value.parts) || value.parts.length === 0
    || value.parts.some(part => !isRecord(part) || typeof part.type !== "string" || part.type.length === 0
      || (part.text !== undefined && typeof part.text !== "string"))) {
    throw new TypeError("channel context fact.parts must contain at least one typed object");
  }
  if (value.flags !== undefined && (!isRecord(value.flags)
    || (value.flags.self !== undefined && typeof value.flags.self !== "boolean")
    || (value.flags.control !== undefined && typeof value.flags.control !== "boolean"))) {
    throw new TypeError("channel context fact.flags must contain optional boolean self/control values");
  }
}

export function assertChannelContextAppend(value: unknown): asserts value is ChannelContextAppend {
  if (!isRecord(value)) throw new TypeError("channel context append must be an object");
  assertChannelScope(value.scope);
  if (!Array.isArray(value.facts) || value.facts.length < 1 || value.facts.length > 100) {
    throw new TypeError("channel context append.facts must contain 1..100 facts");
  }
  for (const fact of value.facts) assertChannelMessageFact(fact);
  if (value.gap_after_seq !== undefined
    && (!Number.isSafeInteger(value.gap_after_seq) || Number(value.gap_after_seq) < 0)) {
    throw new TypeError("channel context append.gap_after_seq must be a non-negative safe integer when present");
  }
}

export function assertContextSyncResult(value: unknown): asserts value is ContextSyncResult {
  if (!isRecord(value)) throw new TypeError("context sync result must be an object");
  assertChannelScope(value.scope);
  if (!Array.isArray(value.facts) || value.facts.length > 100) {
    throw new TypeError("context sync result.facts must contain at most 100 facts");
  }
  for (const fact of value.facts) assertChannelMessageFact(fact);
  const result = value as unknown as ContextSyncResult;
  if (typeof result.request_id !== "string" || result.request_id.length === 0) {
    throw new TypeError("context sync result.request_id must be a non-empty string");
  }
  if (!["complete", "partial", "unavailable"].includes(result.completeness)) {
    throw new TypeError("context sync result.completeness is invalid");
  }
  if (result.completeness === "unavailable" && result.facts.length !== 0) {
    throw new TypeError("unavailable context sync result must not contain facts");
  }
  if (result.through_seq !== undefined
    && (!Number.isSafeInteger(result.through_seq) || Number(result.through_seq) < 0)) {
    throw new TypeError("context sync result.through_seq must be a non-negative safe integer when present");
  }
}

export function assertChannelContextDescriptor(value: unknown): asserts value is ChannelContextDescriptor {
  if (!isRecord(value)) throw new TypeError("channel context descriptor must be an object");
  assertChannelScope(value.scope);
  if (typeof value.consumer_key !== "string" || value.consumer_key.length === 0) {
    throw new TypeError("channel context descriptor.consumer_key must be a non-empty string");
  }
  if (!Number.isSafeInteger(value.session_generation) || Number(value.session_generation) < 1) {
    throw new TypeError("channel context descriptor.session_generation must be a positive safe integer");
  }
  if (typeof value.trigger_message_id !== "string" || value.trigger_message_id.length === 0) {
    throw new TypeError("channel context descriptor.trigger_message_id must be a non-empty string");
  }
  assertChannelMessageFact(value.trigger_fact);
  if (value.trigger_fact.message_id !== value.trigger_message_id) {
    throw new TypeError("channel context descriptor trigger_fact.message_id must match trigger_message_id");
  }
  if (value.trigger_seq !== undefined
    && (!Number.isSafeInteger(value.trigger_seq) || Number(value.trigger_seq) < 0)) {
    throw new TypeError("channel context descriptor.trigger_seq must be a non-negative safe integer when present");
  }
  const hasTriggerSeq = value.trigger_seq !== undefined;
  const factHasTriggerSeq = value.trigger_fact.message_seq !== undefined;
  if (hasTriggerSeq !== factHasTriggerSeq || value.trigger_fact.message_seq !== value.trigger_seq) {
    throw new TypeError("channel context descriptor trigger_fact.message_seq must match trigger_seq");
  }
}

/**
 * 写入 Store 的事件记录。
 * `seq` 只在单个 run 内单调递增；消费者应使用 `(runId, seq)` 做排序和去重。
 */
export type EventEnvelope<TType extends CanonicalEventType = CanonicalEventType> = CanonicalEvent<TType> & {
  /** 每条持久化事件的全局随机 ID。 */
  id: string;
  seq: number;
  tsMs: number;
  sessionId: string;
  runId: string;
};

export const TERMINAL_EVENTS: ReadonlySet<CanonicalEventType> = new Set(TERMINAL_EVENT_TYPES);
export const EVENT_TYPES: ReadonlySet<CanonicalEventType> = new Set(CANONICAL_EVENT_TYPES);
export const MESSAGE_EXPOSURES: ReadonlySet<MessageExposure> = new Set([
  "public_summary",
  "public_plan",
  "private_reasoning",
  "unknown"
]);

/**
 * Adapter 可声明的能力名。能力描述真实的端到端能力，不应只因为底层 CLI 支持就提前声明。
 */
export const capabilities = Object.freeze({
  SESSION_SERIALIZE: "session.serialize",
  SESSION_FORK: "session.fork",
  MESSAGE_APPEND: "message.append",
  TOOL_CANONICAL: "tool.canonical",
  REATTACH: "run.reattach"
} as const);

/**
 * 校验 adapter event，并补齐持久化需要的 ID、序号、时间和 Run 归属。
 * 返回冻结对象，避免 append 后被调用方继续修改。
 */
export function envelope<TType extends CanonicalEventType>(
  run: RunIdentity,
  seq: number,
  event: CanonicalEvent<TType>
): Readonly<EventEnvelope<TType>> {
  assertCanonicalEvent(event);
  // TypeScript loses the indexed type/payload relationship when a generic union is spread.
  const value = {
    id: randomUUID(),
    seq,
    tsMs: Date.now(),
    sessionId: run.sessionId,
    runId: run.id,
    type: event.type,
    payload: event.payload ?? {}
  } as unknown as EventEnvelope<TType>;
  return Object.freeze(value);
}

/** 在动态 adapter 边界验证 canonical event 的最小运行时形状。 */
export function assertCanonicalEvent(event: unknown): asserts event is CanonicalEvent {
  // adapter 是插件边界，运行时校验不能只依赖 TypeScript 的编译期类型。
  if (!isRecord(event) || typeof event.type !== "string" || !EVENT_TYPES.has(event.type as CanonicalEventType)) {
    throw new TypeError(`unsupported canonical event: ${isRecord(event) ? String(event.type) : "undefined"}`);
  }
  if (event.payload !== undefined && !isRecord(event.payload)) {
    throw new TypeError("event.payload must be an object");
  }
  const payload = isRecord(event.payload) ? event.payload : {};
  if (event.type.startsWith("message.") && payload.channel === "analysis") {
    assertAnalysisExposure(payload);
  }
  if (event.type === "tool_call.create") {
    requireToolString(payload, "id", event.type);
    requireToolString(payload, "name", event.type);
    if (!isRecord(payload.args)) throw new TypeError("tool_call.create payload.args must be an object");
  }
  if (event.type === "tool_call.delta") {
    requireToolString(payload, "id", event.type);
    const hasArgs = typeof payload.argsDelta === "string";
    const hasOutput = typeof payload.outputDelta === "string";
    if (!hasArgs && !hasOutput) {
      throw new TypeError("tool_call.delta requires argsDelta or outputDelta");
    }
  }
  if (event.type === "tool_call.update") {
    requireToolString(payload, "id", event.type);
    requireToolString(payload, "status", event.type);
  }
}

/** 在 Host 调用 adapter 前验证不可缺少的执行标识和路径字段。 */
export function assertInvokeRequest(request: unknown): asserts request is InvokeRequest {
  if (!isRecord(request)) throw new TypeError("InvokeRequest must be an object");
  for (const key of ["invocationId", "sessionId", "runId", "prompt", "workdir"] as const) {
    if (typeof request[key] !== "string" || request[key].length === 0) {
      throw new TypeError(`InvokeRequest.${key} must be a non-empty string`);
    }
  }
  if (request.modelInput !== undefined
    && (typeof request.modelInput !== "string" || request.modelInput.length === 0)) {
    throw new TypeError("InvokeRequest.modelInput must be a non-empty string when present");
  }
  if (request.freshFallbackModelInput !== undefined
    && (typeof request.freshFallbackModelInput !== "string" || request.freshFallbackModelInput.length === 0)) {
    throw new TypeError("InvokeRequest.freshFallbackModelInput must be a non-empty string when present");
  }
}

/** 类型守卫：判断事件是否会结束当前 Run。 */
export function isTerminal(event: CanonicalEvent): event is CanonicalEvent<TerminalEventType> {
  return TERMINAL_EVENTS.has(event.type);
}

/** Missing or malformed analysis metadata is never treated as public. */
export function messageExposure(event: CanonicalEvent): MessageExposure {
  if (!event.type.startsWith("message.") || event.payload.channel !== "analysis") return "unknown";
  const exposure = event.payload.exposure;
  return typeof exposure === "string" && MESSAGE_EXPOSURES.has(exposure)
    ? exposure
    : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireToolString(payload: Record<string, unknown>, key: string, eventType: string): void {
  if (typeof payload[key] !== "string" || payload[key].length === 0) {
    throw new TypeError(`${eventType} payload.${key} must be a non-empty string`);
  }
}

function assertAnalysisExposure(payload: Record<string, unknown>): void {
  if (payload.exposure !== undefined
    && (typeof payload.exposure !== "string" || !MESSAGE_EXPOSURES.has(payload.exposure as MessageExposure))) {
    throw new TypeError("analysis message payload.exposure is invalid");
  }
  if (payload.exposure !== undefined && !isRecord(payload.provenance)) {
    throw new TypeError("analysis message with explicit exposure requires payload.provenance");
  }
  if (payload.provenance === undefined) return;
  if (!isRecord(payload.provenance)) {
    throw new TypeError("analysis message payload.provenance must be an object");
  }
  for (const key of ["provider", "nativeEvent"] as const) {
    if (typeof payload.provenance[key] !== "string" || payload.provenance[key].length === 0) {
      throw new TypeError(`analysis message payload.provenance.${key} must be a non-empty string`);
    }
  }
}

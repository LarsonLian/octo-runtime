import { randomUUID } from "node:crypto";
import type {
  CanonicalEventPayload,
  InvokeRequestWire,
  ToolCallCreatePayload,
  ToolCallDeltaPayload,
  ToolCallUpdatePayload
} from "./generated/protocol-types.js";

// 数据形状类型由 schema/protocol.schema.json 生成，见 ./generated/protocol-types.ts。
// 这里从生成文件重新导出，保持 `@orbtex-ai/orbtex-protocol` 的公共导出面不变。
export type {
  MessageChannel,
  ProviderSession,
  AgentConfig,
  CanonicalEventPayload,
  ToolCallCreatePayload,
  ToolCallDeltaPayload,
  ToolCallUpdatePayload,
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
}

/** 类型守卫：判断事件是否会结束当前 Run。 */
export function isTerminal(event: CanonicalEvent): event is CanonicalEvent<TerminalEventType> {
  return TERMINAL_EVENTS.has(event.type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireToolString(payload: Record<string, unknown>, key: string, eventType: string): void {
  if (typeof payload[key] !== "string" || payload[key].length === 0) {
    throw new TypeError(`${eventType} payload.${key} must be a non-empty string`);
  }
}

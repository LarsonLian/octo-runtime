import { randomUUID } from "node:crypto";

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

/**
 * assistant 输出频道。
 * `analysis` 用于 provider 明确允许展示的思考/进度内容，`final` 用于面向用户的回答。
 */
export type MessageChannel = "analysis" | "final";

/**
 * Provider 自己拥有的会话恢复信息。
 *
 * `sessionId` 对 Core 完全 opaque；额外字段可由 adapter 写入并在下一次调用时原样取回。
 */
export interface ProviderSession extends Record<string, unknown> {
  sessionId: string;
  /** 当前 provider 是否声明该 session 可在后续 invocation 中恢复。 */
  resumable?: boolean;
}

/**
 * Agent 的持久配置。公共字段供现有 adapters 使用，扩展字段必须由对应 adapter 自行解释。
 * Core 只负责保存和传递，不根据 provider 类型分支处理。
 */
export interface AgentConfig extends Record<string, unknown> {
  /** Provider CLI 的默认工作目录；它是 cwd，不是文件系统安全边界。 */
  workdir?: string;
  model?: string;
  sandbox?: string;
  permissionMode?: string;
  dangerouslyBypassPermissions?: boolean;
  autoApprove?: boolean;
  providerAgentId?: string;
  thinking?: string;
  timeoutSeconds?: number;
  openclawConfigPath?: string;
  openclawStateDir?: string;
  providerOptions?: Record<string, unknown>;
}

/**
 * Canonical event 的公共 payload。
 *
 * 接口继承开放字典是为了容纳 tool/surface/usage 的结构化字段；常用生命周期字段在此显式列出，
 * 让 adapter 作者获得类型提示，同时避免把 provider-native 对象塞进顶层协议。
 */
export interface CanonicalEventPayload extends Record<string, unknown> {
  providerSession?: ProviderSession;
  channel?: MessageChannel;
  messageId?: string;
  role?: string;
  status?: string;
  text?: string;
  reason?: string;
  message?: string;
}

/** Adapter 向 Host 输出的最小事件单元；持久化前还没有 seq、runId 和时间戳。 */
export interface CanonicalEvent<TType extends CanonicalEventType = CanonicalEventType> {
  type: TType;
  payload: CanonicalEventPayload;
}

/**
 * Core 发给 Adapter Host 的一次执行请求。
 *
 * harness session、run 和 invocation 是三个不同层次的标识：session 跨多轮复用，run 表示一次业务执行，
 * invocation 表示这次与 provider adapter 的活动调用，用于取消和事件路由。
 */
export interface InvokeRequest {
  /** Adapter Host 活动调用 ID，也是 cancel 的目标。 */
  invocationId: string;
  /** Chat 或 Task 的长期 Harness Session ID。 */
  sessionId: string;
  /** 本次业务执行的 Run ID。 */
  runId: string;
  /** 用户请求或 Task description；不得混入 provider 私有控制参数。 */
  prompt: string;
  /** Provider 进程 cwd；真正的访问控制由 sandbox/容器/宿主权限提供。 */
  workdir: string;
  /** Harness 生成的控制指令，由 adapter 放入 provider 支持的私有 carrier。 */
  appendInstructions: string;
  /** 供 prompt、审计和未来 transport 使用的结构化 Harness 上下文。 */
  context: Record<string, unknown>;
  /** 上一次 `session.update` 保存的 provider 恢复信息。 */
  providerSession?: ProviderSession;
  agentConfig: AgentConfig;
  /** Host 取消 invocation 时触发；adapter 应传播到子进程或协议 cancel。 */
  signal?: AbortSignal;
}

/** `envelope` 只需要 Run 的稳定标识，不要求传入完整领域对象。 */
export interface RunIdentity {
  id: string;
  sessionId: string;
}

/**
 * 写入 Store 的事件记录。
 * `seq` 只在单个 run 内单调递增；消费者应使用 `(runId, seq)` 做排序和去重。
 */
export interface EventEnvelope extends CanonicalEvent {
  /** 每条持久化事件的全局随机 ID。 */
  id: string;
  seq: number;
  tsMs: number;
  sessionId: string;
  runId: string;
}

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
export function envelope(run: RunIdentity, seq: number, event: CanonicalEvent): Readonly<EventEnvelope> {
  assertCanonicalEvent(event);
  return Object.freeze({
    id: randomUUID(),
    seq,
    tsMs: Date.now(),
    sessionId: run.sessionId,
    runId: run.id,
    type: event.type,
    payload: event.payload ?? {}
  });
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

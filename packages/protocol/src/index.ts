import { randomUUID } from "node:crypto";

export const TERMINAL_EVENT_TYPES = ["run.finished", "run.error", "run.stopped"] as const;
export type TerminalEventType = (typeof TERMINAL_EVENT_TYPES)[number];

export const CANONICAL_EVENT_TYPES = [
  "session.update", "usage.update",
  "message.create", "message.delta", "message.update",
  "tool_call.create", "tool_call.delta", "tool_call.update",
  "surface.create", "surface.delta", "surface.update",
  "run.queued", "run.running",
  ...TERMINAL_EVENT_TYPES
] as const;

// 所有 provider 的原生事件最终只允许落到这组稳定事件，Core 因此不感知底层 CLI。
export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];
export type MessageChannel = "analysis" | "final";

export interface ProviderSession extends Record<string, unknown> {
  sessionId: string;
  resumable?: boolean;
}

export interface AgentConfig extends Record<string, unknown> {
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

export interface CanonicalEvent<TType extends CanonicalEventType = CanonicalEventType> {
  type: TType;
  payload: CanonicalEventPayload;
}

export interface InvokeRequest {
  invocationId: string;
  sessionId: string;
  runId: string;
  prompt: string;
  workdir: string;
  appendInstructions: string;
  context: Record<string, unknown>;
  providerSession?: ProviderSession;
  agentConfig: AgentConfig;
  signal?: AbortSignal;
}

export interface RunIdentity {
  id: string;
  sessionId: string;
}

export interface EventEnvelope extends CanonicalEvent {
  id: string;
  seq: number;
  tsMs: number;
  sessionId: string;
  runId: string;
}

export const TERMINAL_EVENTS: ReadonlySet<CanonicalEventType> = new Set(TERMINAL_EVENT_TYPES);
export const EVENT_TYPES: ReadonlySet<CanonicalEventType> = new Set(CANONICAL_EVENT_TYPES);

export const capabilities = Object.freeze({
  SESSION_SERIALIZE: "session.serialize",
  SESSION_FORK: "session.fork",
  MESSAGE_APPEND: "message.append",
  TOOL_CANONICAL: "tool.canonical",
  REATTACH: "run.reattach"
} as const);

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

export function assertCanonicalEvent(event: unknown): asserts event is CanonicalEvent {
  // adapter 是插件边界，运行时校验不能只依赖 TypeScript 的编译期类型。
  if (!isRecord(event) || typeof event.type !== "string" || !EVENT_TYPES.has(event.type as CanonicalEventType)) {
    throw new TypeError(`unsupported canonical event: ${isRecord(event) ? String(event.type) : "undefined"}`);
  }
  if (event.payload !== undefined && !isRecord(event.payload)) {
    throw new TypeError("event.payload must be an object");
  }
}

export function assertInvokeRequest(request: unknown): asserts request is InvokeRequest {
  if (!isRecord(request)) throw new TypeError("InvokeRequest must be an object");
  for (const key of ["invocationId", "sessionId", "runId", "prompt", "workdir"] as const) {
    if (typeof request[key] !== "string" || request[key].length === 0) {
      throw new TypeError(`InvokeRequest.${key} must be a non-empty string`);
    }
  }
}

export function isTerminal(event: CanonicalEvent): event is CanonicalEvent<TerminalEventType> {
  return TERMINAL_EVENTS.has(event.type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

import { randomUUID } from "node:crypto";
import type {
  CanonicalEventPayload,
  ChannelContextAppend,
  ChannelContextDescriptor,
  ChannelMessageFact,
  ChannelScope,
  ContextSyncResult,
  InvokeRequestWire,
  MessageChannel,
  MessageExposure,
  ModelStepFinishedPayload,
  ModelStepStartedPayload,
  ToolCallCreatePayload,
  ToolCallDeltaPayload,
  ToolCallUpdatePayload
} from "./generated/protocol-types.js";

// The data-shape types are generated from schema/protocol.schema.json (see
// ./generated/protocol-types.ts). We re-export them here so the public surface
// of `@mininglamp-oss/octo-harness-protocol` stays stable regardless of how the
// generator lays out its output.
export type {
  MessageChannel,
  MessageExposure,
  MessageProvenance,
  ProviderSession,
  AgentConfig,
  CanonicalEventPayload,
  ModelStepStartedPayload,
  ModelStepFinishedPayload,
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
 * The three terminal states a Run may reach.
 *
 * `finished` means normal completion, `error` means execution failed, and
 * `stopped` means an explicit cancellation or an aborted stream. The Adapter
 * Host guarantees every invocation delivers exactly one of these upstream.
 */
export const TERMINAL_EVENT_TYPES = ["run.finished", "run.error", "run.stopped"] as const;
export type TerminalEventType = (typeof TERMINAL_EVENT_TYPES)[number];

/**
 * The stable event set the Core can persist and upper-layer UIs can consume.
 *
 * Rough lifecycle: Run queued/running -> message, tool, surface and usage
 * updates -> a Run terminal. Provider-native event names must be translated
 * inside the adapter and must never leak through to this level.
 */
export const CANONICAL_EVENT_TYPES = [
  "session.update", "usage.update",
  "model_step.started", "model_step.finished",
  "message.create", "message.delta", "message.update",
  "tool_call.create", "tool_call.delta", "tool_call.update",
  "surface.create", "surface.delta", "surface.update",
  "run.queued", "run.running",
  ...TERMINAL_EVENT_TYPES
] as const;

/** Every provider's native events must collapse into this set, so the Core stays agnostic of the underlying CLI. */
export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];

export type CanonicalPayloadFor<TType extends CanonicalEventType> =
  TType extends "model_step.started" ? CanonicalEventPayload & ModelStepStartedPayload
    : TType extends "model_step.finished" ? CanonicalEventPayload & ModelStepFinishedPayload
      : TType extends "tool_call.create" ? CanonicalEventPayload & ToolCallCreatePayload
    : TType extends "tool_call.delta" ? CanonicalEventPayload & ToolCallDeltaPayload
      : TType extends "tool_call.update" ? CanonicalEventPayload & ToolCallUpdatePayload
        : CanonicalEventPayload;

/** The smallest event unit an adapter emits to the Host; the payload narrows by type for the tool lifecycle. */
export type CanonicalEvent<TType extends CanonicalEventType = CanonicalEventType> =
  TType extends CanonicalEventType
    ? { type: TType; payload: CanonicalPayloadFor<TType> }
    : never;

/**
 * A single execution request the Core sends to the Adapter Host.
 *
 * The serializable fields come from the generated {@link InvokeRequestWire};
 * `signal` is a runtime object that cannot cross a process boundary, so it is
 * mixed in here (for in-process calls only) rather than added to the schema.
 */
export interface InvokeRequest extends InvokeRequestWire {
  /** Fired when the Host cancels the invocation; the adapter should propagate it to the subprocess or a protocol cancel. */
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
	if (typeof value.agent_id !== "string" || value.agent_id.length < 1 || value.agent_id.length > 96) {
		throw new TypeError("channel context append.agent_id must contain 1..96 characters");
	}
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
 * The event record written to the Store.
 * `seq` is monotonic only within a single run; consumers should order and
 * dedupe on `(runId, seq)`.
 */
export type EventEnvelope<TType extends CanonicalEventType = CanonicalEventType> = CanonicalEvent<TType> & {
  /** A globally random ID for each persisted event. */
  id: string;
  seq: number;
  tsMs: number;
  agentSessionId: string;
  runId: string;
};

export const TERMINAL_EVENTS: ReadonlySet<CanonicalEventType> = new Set(TERMINAL_EVENT_TYPES);
export const EVENT_TYPES: ReadonlySet<CanonicalEventType> = new Set(CANONICAL_EVENT_TYPES);
export const MESSAGE_EXPOSURES: ReadonlySet<MessageExposure> = new Set([
  "public_reasoning",
  "public_summary",
  "public_plan",
  "private_reasoning",
  "unknown"
]);
export const MESSAGE_CHANNELS: ReadonlySet<MessageChannel> = new Set([
  "analysis",
  "commentary",
  "final"
]);

/**
 * Capability names an adapter may declare. A capability describes a real
 * end-to-end ability and should not be claimed just because the underlying CLI
 * happens to support it.
 */
export const capabilities = Object.freeze({
  SESSION_SERIALIZE: "session.serialize",
  SESSION_RESUME_RECOVERY: "session.resume_recovery",
  SESSION_FORK: "session.fork",
  MESSAGE_APPEND: "message.append",
  TOOL_CANONICAL: "tool.canonical",
  REATTACH: "run.reattach"
} as const);

/**
 * Validate an adapter event and stamp it with the ID, sequence, timestamp and
 * Run ownership that persistence requires. Returns a frozen object so callers
 * cannot mutate it after append.
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
    agentSessionId: run.agentSessionId,
    runId: run.id,
    type: event.type,
    payload: event.payload ?? {}
  } as unknown as EventEnvelope<TType>;
  return Object.freeze(value);
}

/** Assert the minimal runtime shape of a canonical event at the dynamic adapter boundary. */
export function assertCanonicalEvent(event: unknown): asserts event is CanonicalEvent {
  // Adapters are a plugin boundary, so runtime validation cannot rely on TypeScript's compile-time types alone.
  if (!isRecord(event) || typeof event.type !== "string" || !EVENT_TYPES.has(event.type as CanonicalEventType)) {
    throw new TypeError(`unsupported canonical event: ${isRecord(event) ? String(event.type) : "undefined"}`);
  }
  if (event.payload !== undefined && !isRecord(event.payload)) {
    throw new TypeError("event.payload must be an object");
  }
  const payload = isRecord(event.payload) ? event.payload : {};
  if (event.type.startsWith("message.")) {
    if (payload.channel !== undefined
      && (typeof payload.channel !== "string" || !MESSAGE_CHANNELS.has(payload.channel as MessageChannel))) {
      throw new TypeError("message event payload.channel must be analysis, commentary, or final when present");
    }
    if (payload.channel === "analysis") assertAnalysisExposure(payload);
  }
  if (event.type === "model_step.started" || event.type === "model_step.finished") {
    requireEventString(payload, "stepId", event.type);
    const timestampKey = event.type === "model_step.started" ? "startedAtMs" : "endedAtMs";
    if (payload[timestampKey] !== undefined
      && (!Number.isSafeInteger(payload[timestampKey]) || Number(payload[timestampKey]) <= 0)) {
      throw new TypeError(`${event.type} payload.${timestampKey} must be a positive safe integer when present`);
    }
  }
  if (event.type === "model_step.finished") {
    requireEventString(payload, "status", event.type);
    if (payload.finishReason !== undefined && typeof payload.finishReason !== "string") {
      throw new TypeError("model_step.finished payload.finishReason must be a string when present");
    }
    if (payload.publicText !== undefined
      && (typeof payload.publicText !== "string" || Array.from(payload.publicText).length > 1_000)) {
      throw new TypeError("model_step.finished payload.publicText must be a string of at most 1000 characters when present");
    }
  }
  if (event.type === "tool_call.create") {
    requireEventString(payload, "id", event.type);
    requireEventString(payload, "name", event.type);
    if (!isRecord(payload.args)) throw new TypeError("tool_call.create payload.args must be an object");
  }
  if (event.type === "tool_call.delta") {
    requireEventString(payload, "id", event.type);
    const hasArgs = typeof payload.argsDelta === "string";
    const hasOutput = typeof payload.outputDelta === "string";
    if (!hasArgs && !hasOutput) {
      throw new TypeError("tool_call.delta requires argsDelta or outputDelta");
    }
  }
  if (event.type === "tool_call.update") {
    requireEventString(payload, "id", event.type);
    requireEventString(payload, "status", event.type);
  }
}

/** Assert the execution identifiers and path fields that must be present before the Host calls an adapter. */
export function assertInvokeRequest(request: unknown): asserts request is InvokeRequest {
  if (!isRecord(request)) throw new TypeError("InvokeRequest must be an object");
  for (const key of ["invocationId", "agentSessionId", "runId", "prompt", "workdir"] as const) {
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

/** Type guard: whether an event ends the current Run. */
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

function requireEventString(payload: Record<string, unknown>, key: string, eventType: string): void {
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

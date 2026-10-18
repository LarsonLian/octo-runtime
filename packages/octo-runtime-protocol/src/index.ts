import { randomUUID } from "node:crypto";
export { assertJsonByteLimit } from "./json-size.js";
export { INVOKE_REQUEST_MAX_BYTES, assertInvokeRequestSize } from "./invoke-size.js";
export * from "./stream-limits.js";
export * from "./run-protocol.js";
export * from "./invoke-input.js";
export * from "./model-context.js";
export * from "./execution-plan.js";
export { contextHash } from "./context-hash.js";
export type { ToolAuthorization, IssuedToolAuthorization } from "./generated/protocol-types.js";
import { assertExperiencePayload } from "./experience.js";
export { PROVIDER_DIAGNOSTIC_MAX_BYTES } from "./experience.js";
import { assertModelInputParts, assertImageRecoveryParts, hasImageInput } from "./multimodal.js";
export {
  IMAGE_INPUT_LIMITS,
  IMAGE_INPUT_MIME_TYPES,
  assertModelInputParts,
  providerInputParts,
  hasImageInput,
  modelPartsFromInput
} from "./multimodal.js";
import {
  assertAgentSource,
  assertApprovalMode,
  assertContextEnvelope,
  assertContextEnvs,
  assertJsonValue,
  contextItem
} from "./context.js";
export {
  APPROVAL_MODES,
  CONTEXT_SCHEMA,
  CONTEXT_MAX_BYTES,
  CONTEXT_MAX_ITEMS,
  RUNTIME_RUN_CONTRACT,
  assertAgentSource,
  assertApprovalMode,
  assertContextEnvelope,
  assertContextEnvs,
  assertMcpServers,
  assertContextMcp,
  assertResolvedExecutionPlan,
  canonicalContext,
  contextItem,
  mergeContext
} from "./context.js";
export { RUNTIME_SELECTION_SCHEMA, assertResolvedRuntimeSelection } from "./runtime-selection.js";
export {
  CONTEXT_TYPE_CATALOG,
  contextTypeDefinition,
  findContextTypeDefinition
} from "./context-catalog.js";
export type { ContextTypeDefinition } from "./context-catalog.js";
export {
  assertContextConfiguration,
  resolveContextConfiguration
} from "./context-configuration.js";
export { assertNotificationMessage } from "./notification.js";
import type {
  ActivityStartedPayload,
  ActivityUpdatedPayload,
  ActivityFinishedPayload,
  PlanUpdatedPayload,
  ToolProgressPayload,
  RunNoticePayload,
  CanonicalEventPayload,
  ChannelContextAppend,
  ChannelContextDescriptor,
  ChannelMessageFact,
  ChannelScope,
  ContextSyncResult,
  InvokeRequestWire,
  RuntimeLimits,
  MessageChannel,
  MessageExposure,
  InteractionRequestedPayload,
  InteractionResolvedPayload,
  ModelStepFinishedPayload,
  ModelStepStartedPayload,
  ToolCallCreatePayload,
  ToolCallDeltaPayload,
  ToolCallUpdatePayload,
  FailureEnvelope
} from "./generated/protocol-types.js";

// The data-shape types are generated from schema/protocol.schema.json (see
// ./generated/protocol-types.ts). We re-export them here so the public surface
// of `@mininglamp-oss/octo-runtime-protocol` stays stable regardless of how the
// generator lays out its output.
export type {
  AgentSource,
  NotificationMessage,
  ModelInputPart,
  ApprovalMode,
  ApprovalRequest,
  ApprovalOperation,
  ApprovalDisplayDetails,
  ContextItem,
  ContextInlinePayload,
  ContextReferencesPayload,
  ContextInlineEntry,
  ContextReferenceEntry,
  ContextEnvelope,
  ContextConfiguration,
  ContextPreparationReceipt,
  RunContextProjection,
  ContextAdapterPayload,
  ContextModelPayload,
  ContextActmodePayload,
  ExecutionEvidence,
  ContextReasoningPayload,
  ContextWorkspacePayload,
  ContextLimitsPayload,
  ContextEnvsPayload,
  ContextRuntimeSelectionPayload,
  ContextApprovalPolicyPayload,
  ContextSelectionEntry,
  ContextResourceEntry,
  ContextInstructionEntry,
  ContextInstructionsPayload,
  ContextContinuityPayload,
  ResolvedExecutionPlan,
  ResolvedRuntimeSelection,
  MessageChannel,
  MessageExposure,
  MessageProvenance,
  ProviderSession,
  AgentConfig,
  RuntimeLimits,
  ActivityInfo,
  ActivitySubject,
  ActivityStartedPayload,
  ActivityUpdatedPayload,
  ActivityFinishedPayload,
  PlanUpdatedPayload,
  ToolProgressPayload,
  RunNoticePayload,
  CanonicalEventPayload,
  InteractionRequestedPayload,
  InteractionResolvedPayload,
  ModelStepStartedPayload,
  ModelStepFinishedPayload,
  ToolCallCreatePayload,
  ToolCallDeltaPayload,
  ToolCallUpdatePayload,
  FailureAction,
  FailureSource,
  FailureCause,
  FailureEnvelope,
  ChannelScope,
  ChannelMessagePart,
  ChannelMessageSender,
  ChannelMessageFlags,
  ChannelMessageFact,
  ChannelContextAppend,
  ContextSyncRequest,
  ContextSyncResult,
  ChannelContextDescriptor,
  ContextCommitResult,
  McpStdioServer,
  McpStreamableHttpServer,
  McpServer,
  McpServers,
  RunIdentity,
  InvokeRequestWire
} from "./generated/protocol-types.js";
export {
  FAILURE_CATALOG,
  classifyFailure,
  failureMessage,
  failurePayload,
  isFailureEnvelope,
  type FailureClassificationContext,
  type FailureDomain,
  type PublicFailureCode
} from "./failure.js";
import type { RunIdentity } from "./generated/protocol-types.js";

/**
 * The three terminal states a Run may reach.
 *
 * `finished` means normal completion, `error` means execution failed, and
 * `stopped` means an explicit cancellation or an aborted stream. The Adapter
 * Host guarantees every invocation delivers exactly one of these upstream.
 */
export const PROTOCOL_VERSION = 2 as const;

export function canonicalTerminalStatus(value: unknown): "completed" | "failed" | "cancelled" {
  if (
    value === "completed" ||
    value === "success" ||
    value === "succeeded" ||
    value === undefined ||
    value === ""
  )
    return "completed";
  if (
    value === "cancelled" ||
    value === "stopped" ||
    value === "interrupted" ||
    value === "canceled"
  )
    return "cancelled";
  return "failed";
}

export const TERMINAL_EVENT_TYPES = ["run.completed", "run.failed", "run.cancelled"] as const;
export type TerminalEventType = (typeof TERMINAL_EVENT_TYPES)[number];

/**
 * The stable event set the Core can persist and upper-layer UIs can consume.
 *
 * Rough lifecycle: Run queued/running -> message, tool, surface and usage
 * updates -> a Run terminal. Provider-native event names must be translated
 * inside the adapter and must never leak through to this level.
 */
export { contextActmode, assertExecutionEvidence } from "./actmode.js";
import { assertExecutionEvidence } from "./actmode.js";

export const CANONICAL_EVENT_TYPES = [
  "session.update",
  "execution.update",
  "usage.update",
  "model_step.started",
  "model_step.finished",
  "message.create",
  "message.delta",
  "message.update",
  "tool_call.create",
  "tool_call.delta",
  "tool_call.update",
  "activity.started",
  "activity.updated",
  "activity.finished",
  "plan.updated",
  "tool_call.progress",
  "run.notice",
  "interaction.requested",
  "interaction.resolved",
  "run.queued",
  "run.started",
  ...TERMINAL_EVENT_TYPES
] as const;

/** Every provider's native events must collapse into this set, so the Core stays agnostic of the underlying CLI. */
export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];

export type CanonicalPayloadFor<TType extends CanonicalEventType> = TType extends "activity.started"
  ? CanonicalEventPayload & ActivityStartedPayload
  : TType extends "activity.updated"
    ? CanonicalEventPayload & ActivityUpdatedPayload
    : TType extends "activity.finished"
      ? CanonicalEventPayload & ActivityFinishedPayload
      : TType extends "plan.updated"
        ? CanonicalEventPayload & PlanUpdatedPayload
        : TType extends "tool_call.progress"
          ? CanonicalEventPayload & ToolProgressPayload
          : TType extends "run.notice"
            ? CanonicalEventPayload & RunNoticePayload
            : TType extends "model_step.started"
              ? CanonicalEventPayload & ModelStepStartedPayload
              : TType extends "model_step.finished"
                ? CanonicalEventPayload & ModelStepFinishedPayload
                : TType extends "interaction.requested"
                  ? CanonicalEventPayload & InteractionRequestedPayload
                  : TType extends "interaction.resolved"
                    ? CanonicalEventPayload & InteractionResolvedPayload
                    : TType extends "tool_call.create"
                      ? CanonicalEventPayload & ToolCallCreatePayload
                      : TType extends "tool_call.delta"
                        ? CanonicalEventPayload & ToolCallDeltaPayload
                        : TType extends "tool_call.update"
                          ? CanonicalEventPayload & ToolCallUpdatePayload
                          : CanonicalEventPayload;

/** The smallest event unit an adapter emits to the Host; the payload narrows by type for the tool lifecycle. */
export type CanonicalEvent<TType extends CanonicalEventType = CanonicalEventType> =
  TType extends CanonicalEventType
    ? { protocolVersion: 2; type: TType; payload: CanonicalPayloadFor<TType> }
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

export const INTERACTION_RESPONSE_OUTCOMES = [
  "accepted",
  "declined",
  "answered",
  "cancelled"
] as const;
export type InteractionResponseOutcome = (typeof INTERACTION_RESPONSE_OUTCOMES)[number];

/** Opaque answer carrier routed back to the provider request that emitted an interaction. */
export interface InteractionResponse {
  interactionId: string;
  outcome: InteractionResponseOutcome;
  value?: unknown;
}

/** Provider adapters must use this accessor so hidden context is sent exactly once when present. */
export function providerInputText(request: InvokeRequest): string {
  return request.modelInput;
}

/** Inject trusted instructions only when starting a provider session, including a fresh restart. */
export function initialControlInstructions(
  request: InvokeRequest,
  freshSession = !request.providerSession?.sessionId
): string {
  return freshSession ? request.controlInstructions : "";
}

/** Exact alternate input for a provider that could not resume its session. */
export function freshFallbackInputText(request: InvokeRequest): string {
  if (request.freshFallbackImagesUnavailable)
    throw new TypeError("ARTIFACT_UNAVAILABLE: historical images cannot be restored");
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
  if (
    value.thread_id !== undefined &&
    value.thread_id !== null &&
    typeof value.thread_id !== "string"
  ) {
    throw new TypeError("channel context scope.thread_id must be a string, null, or omitted");
  }
}

export function assertChannelMessageFact(value: unknown): asserts value is ChannelMessageFact {
  if (!isRecord(value)) throw new TypeError("channel context fact must be an object");
  if (typeof value.message_id !== "string" || value.message_id.length === 0) {
    throw new TypeError("channel context fact.message_id must be a non-empty string");
  }
  if (
    value.message_seq !== undefined &&
    (!Number.isSafeInteger(value.message_seq) || Number(value.message_seq) < 0)
  ) {
    throw new TypeError(
      "channel context fact.message_seq must be a non-negative safe integer when present"
    );
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
  if (
    !Array.isArray(value.parts) ||
    value.parts.length === 0 ||
    value.parts.some(
      (part) =>
        !isRecord(part) ||
        typeof part.type !== "string" ||
        part.type.length === 0 ||
        (part.text !== undefined && typeof part.text !== "string")
    )
  ) {
    throw new TypeError("channel context fact.parts must contain at least one typed object");
  }
  if (
    value.flags !== undefined &&
    (!isRecord(value.flags) ||
      (value.flags.self !== undefined && typeof value.flags.self !== "boolean") ||
      (value.flags.control !== undefined && typeof value.flags.control !== "boolean"))
  ) {
    throw new TypeError(
      "channel context fact.flags must contain optional boolean self/control values"
    );
  }
}

export function assertChannelContextAppend(value: unknown): asserts value is ChannelContextAppend {
  if (!isRecord(value)) throw new TypeError("channel context append must be an object");
  if (
    typeof value.agent_id !== "string" ||
    value.agent_id.length < 1 ||
    value.agent_id.length > 96
  ) {
    throw new TypeError("channel context append.agent_id must contain 1..96 characters");
  }
  assertChannelScope(value.scope);
  if (!Array.isArray(value.facts) || value.facts.length < 1 || value.facts.length > 100) {
    throw new TypeError("channel context append.facts must contain 1..100 facts");
  }
  for (const fact of value.facts) assertChannelMessageFact(fact);
  if (
    value.gap_after_seq !== undefined &&
    (!Number.isSafeInteger(value.gap_after_seq) || Number(value.gap_after_seq) < 0)
  ) {
    throw new TypeError(
      "channel context append.gap_after_seq must be a non-negative safe integer when present"
    );
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
  if (
    result.through_seq !== undefined &&
    (!Number.isSafeInteger(result.through_seq) || Number(result.through_seq) < 0)
  ) {
    throw new TypeError(
      "context sync result.through_seq must be a non-negative safe integer when present"
    );
  }
}

export function assertChannelContextDescriptor(
  value: unknown
): asserts value is ChannelContextDescriptor {
  if (!isRecord(value)) throw new TypeError("channel context descriptor must be an object");
  assertChannelScope(value.scope);
  if (typeof value.consumer_key !== "string" || value.consumer_key.length === 0) {
    throw new TypeError("channel context descriptor.consumer_key must be a non-empty string");
  }
  if (!Number.isSafeInteger(value.session_generation) || Number(value.session_generation) < 1) {
    throw new TypeError(
      "channel context descriptor.session_generation must be a positive safe integer"
    );
  }
  if (typeof value.trigger_message_id !== "string" || value.trigger_message_id.length === 0) {
    throw new TypeError("channel context descriptor.trigger_message_id must be a non-empty string");
  }
  assertChannelMessageFact(value.trigger_fact);
  if (value.trigger_fact.message_id !== value.trigger_message_id) {
    throw new TypeError(
      "channel context descriptor trigger_fact.message_id must match trigger_message_id"
    );
  }
  if (
    value.trigger_seq !== undefined &&
    (!Number.isSafeInteger(value.trigger_seq) || Number(value.trigger_seq) < 0)
  ) {
    throw new TypeError(
      "channel context descriptor.trigger_seq must be a non-negative safe integer when present"
    );
  }
  const hasTriggerSeq = value.trigger_seq !== undefined;
  const factHasTriggerSeq = value.trigger_fact.message_seq !== undefined;
  if (hasTriggerSeq !== factHasTriggerSeq || value.trigger_fact.message_seq !== value.trigger_seq) {
    throw new TypeError(
      "channel context descriptor trigger_fact.message_seq must match trigger_seq"
    );
  }
}

/**
 * The event record written to the Store.
 * `seq` is monotonic only within a single run; consumers should order and
 * dedupe on `(runId, seq)`.
 */
export type EventEnvelope<TType extends CanonicalEventType = CanonicalEventType> =
  CanonicalEvent<TType> & {
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
    protocolVersion: PROTOCOL_VERSION,
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
  if (
    !isRecord(event) ||
    typeof event.type !== "string" ||
    !EVENT_TYPES.has(event.type as CanonicalEventType)
  ) {
    throw new TypeError(
      `unsupported canonical event: ${isRecord(event) ? String(event.type) : "undefined"}`
    );
  }
  if (event.payload !== undefined && !isRecord(event.payload)) {
    throw new TypeError("event.payload must be an object");
  }
  if (event.protocolVersion !== PROTOCOL_VERSION)
    throw new TypeError("canonical protocolVersion must be 2");
  const payload = isRecord(event.payload) ? event.payload : {};
  if (event.type === "execution.update") assertExecutionEvidence(payload);
  assertExperiencePayload(event.type, payload);
  if (event.type === "run.failed" && payload.failure !== undefined) {
    assertFailureEnvelope(payload.failure);
  }
  if (event.type.startsWith("message.")) {
    if (
      payload.channel !== undefined &&
      (typeof payload.channel !== "string" ||
        !MESSAGE_CHANNELS.has(payload.channel as MessageChannel))
    ) {
      throw new TypeError(
        "message event payload.channel must be analysis, commentary, or final when present"
      );
    }
    if (payload.channel === "analysis") assertAnalysisExposure(payload);
  }
  if (event.type === "model_step.started" || event.type === "model_step.finished") {
    requireEventString(payload, "stepId", event.type);
    const timestampKey = event.type === "model_step.started" ? "startedAtMs" : "endedAtMs";
    if (
      payload[timestampKey] !== undefined &&
      (!Number.isSafeInteger(payload[timestampKey]) || Number(payload[timestampKey]) <= 0)
    ) {
      throw new TypeError(
        `${event.type} payload.${timestampKey} must be a positive safe integer when present`
      );
    }
  }
  if (event.type === "model_step.finished") {
    requireEventString(payload, "status", event.type);
    if (payload.finishReason !== undefined && typeof payload.finishReason !== "string") {
      throw new TypeError("model_step.finished payload.finishReason must be a string when present");
    }
    if (payload.publicText !== undefined)
      throw new TypeError("model_step.finished payload.publicText is forbidden");
    if (!["completed", "failed", "cancelled"].includes(String(payload.status)))
      throw new TypeError("model_step.finished payload.status is invalid");
  }
  if (event.type === "tool_call.create") {
    requireEventString(payload, "id", event.type);
    requireEventString(payload, "name", event.type);
    if (!isRecord(payload.args))
      throw new TypeError("tool_call.create payload.args must be an object");
    if (payload.status !== "running")
      throw new TypeError("tool_call.create payload.status must be running");
  }
  if (event.type === "tool_call.delta") {
    requireEventString(payload, "id", event.type);
    const hasArgs = typeof payload.argsDelta === "string";
    const hasOutput =
      typeof payload.outputDelta === "string" || typeof payload.outputSnapshot === "string";
    if (!hasArgs && !hasOutput) {
      throw new TypeError("tool_call.delta requires argsDelta, outputDelta or outputSnapshot");
    }
  }
  if (event.type === "tool_call.update") {
    requireEventString(payload, "id", event.type);
    requireEventString(payload, "status", event.type);
    if (!["completed", "failed", "cancelled"].includes(String(payload.status))) {
      throw new TypeError("tool_call.update payload.status must be terminal");
    }
  }
  if (event.type === "interaction.requested") {
    requireEventString(payload, "interactionId", event.type);
    requireEventString(payload, "executionInstanceId", event.type);
    requireEventString(payload, "expiresAt", event.type);
    if (
      Array.from(String(payload.interactionId)).length > 191 ||
      Array.from(String(payload.executionInstanceId)).length > 191 ||
      !isInteractionTimestamp(payload.expiresAt as string)
    )
      throw new TypeError("interaction.requested instance or expiry is invalid");
    if (
      payload.kind !== "approval" &&
      payload.kind !== "question" &&
      payload.kind !== "elicitation"
    ) {
      throw new TypeError("interaction.requested payload.kind is unsupported");
    }
    if (!isRecord(payload.request))
      throw new TypeError("interaction.requested payload.request must be an object");
    if (payload.kind === "approval") assertApprovalRequest(payload.request);
  }
  if (event.type === "interaction.resolved") {
    requireEventString(payload, "interactionId", event.type);
    requireEventString(payload, "executionInstanceId", event.type);
    if (
      Array.from(String(payload.interactionId)).length > 191 ||
      Array.from(String(payload.executionInstanceId)).length > 191
    )
      throw new TypeError("interaction.resolved instance is invalid");
    if (!["resolved", "expired", "invalidated"].includes(String(payload.status)))
      throw new TypeError("interaction.resolved payload.status is invalid");
    if (payload.status === "resolved") {
      if (!INTERACTION_RESPONSE_OUTCOMES.includes(payload.outcome as InteractionResponseOutcome))
        throw new TypeError("interaction.resolved payload.outcome is invalid");
    } else requireEventString(payload, "reasonCode", event.type);
  }
}

function isInteractionTimestamp(value: string): boolean {
  const matched =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!matched) return false;
  const [, year, month, day, hour, minute, second, offset] = matched;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  if (
    calendar.getUTCFullYear() !== Number(year) ||
    calendar.getUTCMonth() !== Number(month) - 1 ||
    calendar.getUTCDate() !== Number(day)
  )
    return false;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  if (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59))
    return false;
  return Number.isFinite(Date.parse(value));
}

export function assertApprovalRequest(value: unknown): asserts value is Record<string, unknown> {
  assertJsonValue(value);
  if (!isRecord(value) || value.schema !== "octo.approval-request/v1")
    throw new TypeError("INVALID_APPROVAL_REQUEST");
  const allowed = [
    "schema",
    "policy",
    "operation",
    "requestedPermissions",
    "reason",
    "allowedOutcomes",
    "grantScope",
    "providerDetails"
  ];
  if (Object.keys(value).some((property) => !allowed.includes(property)))
    throw new TypeError("INVALID_APPROVAL_REQUEST");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 65_536)
    throw new TypeError("INVALID_APPROVAL_REQUEST");
  if (
    !isRecord(value.policy) ||
    Object.keys(value.policy).some((property) => !["mode", "hash"].includes(property))
  )
    throw new TypeError("INVALID_APPROVAL_REQUEST");
  assertApprovalMode(value.policy.mode);
  if (typeof value.policy.hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.policy.hash))
    throw new TypeError("INVALID_APPROVAL_REQUEST");
  if (
    !isRecord(value.operation) ||
    ![
      "command_execution",
      "file_change",
      "tool_execution",
      "permission_grant",
      "context_access"
    ].includes(String(value.operation.kind))
  )
    throw new TypeError("INVALID_APPROVAL_REQUEST");
  if (
    Object.keys(value.operation).some(
      (property) => !["kind", "summary", "toolCallId", "details"].includes(property)
    ) ||
    typeof value.operation.summary !== "string" ||
    !value.operation.summary ||
    value.operation.summary.length > 8192
  )
    throw new TypeError("INVALID_APPROVAL_REQUEST");
  if (
    value.operation.toolCallId !== undefined &&
    (typeof value.operation.toolCallId !== "string" || !value.operation.toolCallId)
  )
    throw new TypeError("INVALID_APPROVAL_REQUEST");
  if (value.grantScope !== "request" && value.grantScope !== "provider")
    throw new TypeError("APPROVAL_GRANT_SCOPE_UNSUPPORTED");
  if (value.grantScope === "provider") {
    const details = value.providerDetails;
    if (
      !isRecord(details) ||
      details.provider !== "openclaw" ||
      details.method !== "exec.approval.resolve" ||
      !Array.isArray(details.options) ||
      !details.options.length ||
      !details.options.some(
        (option) =>
          isRecord(option) && option.optionId === "allow-always" && option.kind === "allow_always"
      ) ||
      details.options.some(
        (option) =>
          !isRecord(option) ||
          typeof option.optionId !== "string" ||
          typeof option.kind !== "string" ||
          !["allow-once:allow_once", "allow-always:allow_always", "deny:reject_once"].includes(
            `${option.optionId}:${option.kind}`
          )
      )
    )
      throw new TypeError("APPROVAL_GRANT_SCOPE_UNSUPPORTED");
  }
  if (!Array.isArray(value.requestedPermissions)) throw new TypeError("INVALID_APPROVAL_REQUEST");
  if (value.requestedPermissions.length) throw new TypeError("APPROVAL_PERMISSION_UNSUPPORTED");
  if (
    !Array.isArray(value.allowedOutcomes) ||
    !value.allowedOutcomes.length ||
    new Set(value.allowedOutcomes).size !== value.allowedOutcomes.length ||
    value.allowedOutcomes.some(
      (outcome) => !["accepted", "declined", "cancelled"].includes(String(outcome))
    )
  )
    throw new TypeError("INVALID_APPROVAL_REQUEST");
  if (value.reason !== undefined && typeof value.reason !== "string")
    throw new TypeError("INVALID_APPROVAL_REQUEST");
  for (const details of [value.providerDetails, value.operation.details]) {
    if (details === undefined) continue;
    const displayFields = [
      "provider",
      "method",
      "itemId",
      "approvalId",
      "reason",
      "command",
      "cwd",
      "grantRoot",
      "files",
      "toolCallId",
      "title",
      "description",
      "options"
    ];
    if (
      !isRecord(details) ||
      Object.keys(details).some((property) => !displayFields.includes(property))
    )
      throw new TypeError("APPROVAL_DISPLAY_FIELD_UNSUPPORTED");
  }
}

/** Validate a response before it crosses the process or provider boundary. */
export function assertInteractionResponse(value: unknown): asserts value is InteractionResponse {
  if (!isRecord(value)) throw new TypeError("interaction response must be an object");
  if (
    typeof value.interactionId !== "string" ||
    value.interactionId.length === 0 ||
    Array.from(value.interactionId).length > 191
  ) {
    throw new TypeError("interaction response interactionId must be 1-191 characters");
  }
  if (
    typeof value.outcome !== "string" ||
    !(INTERACTION_RESPONSE_OUTCOMES as readonly string[]).includes(value.outcome)
  ) {
    throw new TypeError("interaction response outcome is unsupported");
  }
}

/** Validate a structured failure at the dynamic adapter boundary. */
export function assertFailureEnvelope(value: unknown): asserts value is FailureEnvelope {
  if (!isRecord(value)) throw new TypeError("failure must be an object");
  if (value.schemaVersion !== 1) throw new TypeError("failure.schemaVersion must be 1");
  if (typeof value.code !== "string" || !/^OH-[A-Z]{3}-\d{4}$/.test(value.code)) {
    throw new TypeError("failure.code must be a global OH error code");
  }
  for (const key of [
    "reasonCode",
    "category",
    "stage",
    "messageKey",
    "diagnosticId",
    "occurredAt"
  ] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new TypeError(`failure.${key} must be a non-empty string`);
    }
  }
  if (!/^diag_[0-9a-f]{32}$/.test(value.diagnosticId as string)) {
    throw new TypeError("failure.diagnosticId must be a non-identifying diagnostic ID");
  }
  if (Number.isNaN(Date.parse(value.occurredAt as string)))
    throw new TypeError("failure.occurredAt must be an ISO timestamp");
  if (!isRecord(value.params)) throw new TypeError("failure.params must be an object");
  if (typeof value.retryable !== "boolean")
    throw new TypeError("failure.retryable must be a boolean");
  if (
    value.retryAfterMs !== undefined &&
    (!Number.isSafeInteger(value.retryAfterMs) || Number(value.retryAfterMs) < 0)
  ) {
    throw new TypeError("failure.retryAfterMs must be a non-negative safe integer");
  }
  if (
    !isRecord(value.action) ||
    typeof value.action.type !== "string" ||
    typeof value.action.labelKey !== "string"
  ) {
    throw new TypeError("failure.action must be a catalog action");
  }
  if (
    !isRecord(value.source) ||
    (value.source.component !== "octo-runtime" && value.source.component !== "octo-agent-worker")
  ) {
    throw new TypeError("failure.source.component must be an approved failure producer");
  }
  if (
    value.cause !== undefined &&
    (!isRecord(value.cause) || typeof value.cause.reasonCode !== "string")
  ) {
    throw new TypeError("failure.cause must contain reasonCode");
  }
}

/** Assert the execution identifiers and path fields that must be present before the Host calls an adapter. */
export function assertInvokeRequest(request: unknown): asserts request is InvokeRequest {
  if (!isRecord(request)) throw new TypeError("InvokeRequest must be an object");
  if (request.protocolVersion !== PROTOCOL_VERSION)
    throw new TypeError("InvokeRequest.protocolVersion must be 2");
  if ("appendInstructions" in request) throw new TypeError("LEGACY_RUN_CONTRACT_REJECTED");
  assertAgentSource(request.agentSource);
  assertContextEnvelope(request.context);
  if (request.executionEnvOverrides !== undefined) {
    assertContextEnvs(request.executionEnvOverrides);
    if (Buffer.byteLength(JSON.stringify(request.executionEnvOverrides)) > 65_536)
      throw new TypeError("EXECUTION_ENV_TOO_LARGE");
  }
  assertApprovalMode(request.approvalMode);
  const modelChoices = contextItem(request.context, "octo.execution", "model")?.payload;
  const approvalPolicy = contextItem(request.context, "octo.security", "approval_policy")?.payload;
  if (approvalPolicy && approvalPolicy.mode !== request.approvalMode)
    throw new TypeError("CONTEXT_PLAN_MISMATCH");
  const agentConfig = request.agentConfig;
  if (
    isRecord(agentConfig) &&
    ["autoApprove", "dangerouslyBypassPermissions", "permissionMode"].some(
      (key) => key in agentConfig
    )
  ) {
    throw new TypeError("LEGACY_PERMISSION_CONFIG_REJECTED");
  }
  if (isRecord(agentConfig) && "thinking" in agentConfig)
    throw new TypeError("LEGACY_REASONING_CONFIG_REJECTED");
  for (const selection of [
    { name: "selection", property: "id", config: "model" },
    { name: "reasoning", property: "effort", config: "effort" }
  ]) {
    const selected = modelChoices?.[selection.name] as Record<string, unknown> | undefined;
    if (
      selected &&
      selected[selection.property] !==
        (isRecord(agentConfig) ? agentConfig[selection.config] : undefined)
    )
      throw new TypeError("CONTEXT_PLAN_MISMATCH");
  }
  const workspace = contextItem(request.context, "octo.execution", "workspace")?.payload;
  if (workspace?.mode === "fixed" && workspace.path !== request.workdir)
    throw new TypeError("CONTEXT_PLAN_MISMATCH");
  if (
    ["skills", "skillRoots", "providerStateDir", "mcpServers"].some((key) =>
      Object.hasOwn(request, key)
    )
  )
    throw new TypeError("LOCAL_PLUGIN_CONFIGURATION_REQUIRED");
  if (typeof request.controlInstructions !== "string")
    throw new TypeError("InvokeRequest.controlInstructions must be a string");
  if (request.runtimeLimits !== undefined) assertRuntimeLimits(request.runtimeLimits);
  for (const key of ["invocationId", "agentSessionId", "runId", "prompt"] as const) {
    if (typeof request[key] !== "string" || request[key].length === 0) {
      throw new TypeError(`InvokeRequest.${key} must be a non-empty string`);
    }
  }
  const providerWorkspace =
    contextItem(request.context, "octo.execution", "adapter")?.payload.type === "openclaw";
  if (
    typeof request.workdir !== "string" ||
    (!request.workdir && request.agentSource !== "preset" && !providerWorkspace)
  )
    throw new TypeError("InvokeRequest.workdir is required for provisioned execution");
  if (typeof request.modelInput !== "string" || request.modelInput.length === 0) {
    throw new TypeError("InvokeRequest.modelInput must be a non-empty string");
  }
  if (request.modelInputParts !== undefined) assertModelInputParts(request.modelInputParts);
  if (request.freshFallbackModelInputParts !== undefined)
    assertModelInputParts(request.freshFallbackModelInputParts);
  if (
    request.freshFallbackImagesUnavailable !== undefined &&
    typeof request.freshFallbackImagesUnavailable !== "boolean"
  )
    throw new TypeError("INPUT_PARTS_INVALID");
  const imageInput = {
    modelInputParts: request.modelInputParts,
    freshFallbackModelInputParts: request.freshFallbackModelInputParts,
    freshFallbackModelInput:
      typeof request.freshFallbackModelInput === "string"
        ? request.freshFallbackModelInput
        : undefined
  };
  if (
    hasImageInput(imageInput) &&
    request.freshFallbackModelInput !== undefined &&
    request.freshFallbackModelInputParts === undefined
  ) {
    throw new TypeError("IMAGE_RECOVERY_INPUT_REQUIRED");
  }
  assertImageRecoveryParts(imageInput);
  if (
    request.freshFallbackModelInput !== undefined &&
    (typeof request.freshFallbackModelInput !== "string" ||
      request.freshFallbackModelInput.length === 0)
  ) {
    throw new TypeError(
      "InvokeRequest.freshFallbackModelInput must be a non-empty string when present"
    );
  }
}

export function assertRuntimeLimits(value: unknown): asserts value is RuntimeLimits {
  if (!isRecord(value)) throw new TypeError("runtimeLimits must be an object");
  const bounds: Record<string, number> = {
    firstFrameTimeoutMs: 1_800_000,
    modelIdleTimeoutMs: 3_600_000,
    modelIdleWarningMs: 3_600_000,
    toolTimeoutMs: 86_400_000,
    toolWallTimeoutMs: 86_400_000,
    runTimeoutMs: 86_400_000,
    cancelGraceMs: 60_000
  };
  for (const [key, setting] of Object.entries(value)) {
    if (key === "enforcement" || key === "modelIdlePolicy") {
      if (setting !== "enforce" && setting !== "observe")
        throw new TypeError(`invalid runtimeLimits.${key}`);
    } else if (
      !(key in bounds) ||
      typeof setting !== "number" ||
      !Number.isSafeInteger(setting) ||
      setting < 100 ||
      setting > bounds[key]
    ) {
      throw new TypeError(`invalid runtimeLimits.${key}`);
    }
  }
  if (
    value.enforcement === "observe" &&
    ["modelIdlePolicy", "modelIdleWarningMs", "toolWallTimeoutMs"].some(
      (key) => value[key] !== undefined
    )
  ) {
    throw new TypeError(
      "legacy enforcement=observe cannot be combined with watchdog v2 settings; use modelIdlePolicy=observe with enforcement=enforce"
    );
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
  return typeof exposure === "string" && MESSAGE_EXPOSURES.has(exposure) ? exposure : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireEventString(
  payload: Record<string, unknown>,
  key: string,
  eventType: string
): void {
  if (typeof payload[key] !== "string" || payload[key].length === 0) {
    throw new TypeError(`${eventType} payload.${key} must be a non-empty string`);
  }
}

function assertAnalysisExposure(payload: Record<string, unknown>): void {
  if (
    payload.exposure !== undefined &&
    (typeof payload.exposure !== "string" ||
      !MESSAGE_EXPOSURES.has(payload.exposure as MessageExposure))
  ) {
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

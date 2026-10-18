import {
  assertAgentSource,
  assertApprovalMode,
  assertContextEnvelope,
  assertModelInputParts,
  assertRuntimeLimits,
  type AgentConfig,
  type AgentSource,
  type ApprovalMode,
  type CanonicalEvent,
  type ContextEnvelope,
  type ContextEnvsPayload,
  type HostFrame,
  type InvokeRequest,
  type ModelInputPart,
  type ProviderSession,
  type RuntimeLimits
} from "./index.js";
import { assertJsonValue } from "./context.js";
import { canonicalEvents } from "./run-protocol.js";
import { assertJsonByteLimit } from "./json-size.js";
import { INVOKE_REQUEST_MAX_BYTES } from "./invoke-size.js";
import type { StreamLimitPolicy } from "./stream-limits.js";

/**
 * Public JSON invocation contract shared by CLI, SDK and channels.
 * A plain JSON object satisfies this class structurally; `new` is not required.
 * Only inputs and contexts are required. Defaults are resolved by the execution
 * boundary, never by adding historical business context.
 */
export class InvokeInput {
  /** Exact current-turn text/image parts, in caller order. Image bytes occur here once. */
  declare inputs: ModelInputPart[];
  /** Caller-owned Context v3 snapshot; an empty items array is valid. */
  declare contexts: ContextEnvelope;
  /** Business session identity; generated if omitted. Does not imply provider resume. */
  declare sessionId?: string;
  /** Output view of the same execution stream; defaults to native. */
  declare protocol_mode?: "native" | "canonical";
  /** Cancellation identity for this invocation; generated if omitted. */
  declare invocationId?: string;
  /** Business Run identity; generated if omitted. Independent of invocation/session IDs. */
  declare runId?: string;
  /** Caller-owned session generation, used to fence stale updates; no inferred default. */
  declare sessionGeneration?: number;
  /** Caller-owned provider binding epoch; no inferred default. */
  declare providerEpoch?: number;
  /** Agent ownership: preset for OpenClaw by default, provisioned otherwise. */
  declare agentSource?: AgentSource;
  /** Display-safe description; defaults to the textual summary of inputs. */
  declare prompt?: string;
  /** Exact textual provider turn when distinct from the multipart inputs summary. */
  declare modelInput?: string;
  /** Provider cwd; defaults to the resolved workspace (local cwd when omitted). */
  declare workdir?: string;
  /** Trusted instructions, separate from model business context; derived if omitted. */
  declare controlInstructions?: string;
  /** Execution approval policy, normally resolved from contexts; defaults to ask. */
  declare approvalMode?: ApprovalMode;
  /** Full provider configuration, including providerOptions; context selections must agree. */
  declare agentConfig?: AgentConfig;
  /** Complete timeout/enforcement settings; execution defaults apply when omitted. */
  declare runtimeLimits?: RuntimeLimits;
  /** JSON metadata for tracing/business identity; not model text or authorization evidence. */
  declare runMetadata?: Record<string, unknown>;
  /** Opaque provider session, including provider extension fields; never rebuilt from sessionId. */
  declare providerSession?: ProviderSession;
  /** Fresh/continue intent; defaults to continue with providerSession, fresh otherwise. */
  declare continuityMode?: "fresh" | "continue";
  /** Caller-provided exact recovery text; no automatic history reconstruction. */
  declare freshFallbackModelInput?: string;
  /** Caller-provided recovery text/image parts; recovery images must be supplied explicitly. */
  declare freshFallbackModelInputParts?: ModelInputPart[];
  /** Explicitly fail fresh fallback when historical image bytes cannot be supplied. */
  declare freshFallbackImagesUnavailable?: boolean;

  /** Checks the JSON boundary; resolved execution additionally uses assertInvokeRequest. */
  static check(value: unknown): InvokeInput {
    assertInvokeInput(value);
    return value;
  }
}

/** Local ingress execution settings, outside caller-owned JSON and Context. */
export interface InvokeEnvironment {
  signal?: AbortSignal;
  /** Trusted per-invocation values; forwarded privately across the Host process boundary. */
  executionEnvOverrides?: ContextEnvsPayload;
  /** Trusted transport and replay budgets; never sourced from caller Context. */
  streamLimits?: StreamLimitPolicy;
}

export type InputFrames = (
  input: InvokeInput,
  environment?: InvokeEnvironment
) => AsyncGenerator<HostFrame>;

/** Stable correlation IDs for cancellation and stream reconnection, without resolving execution. */
export function identifyInvokeInput(input: InvokeInput) {
  return {
    ...input,
    invocationId: input.invocationId ?? globalThis.crypto.randomUUID(),
    runId: input.runId ?? globalThis.crypto.randomUUID(),
    sessionId: input.sessionId ?? globalThis.crypto.randomUUID()
  };
}

/** Select a view of one source stream; execution preparation belongs to the Host. */
export function createInputInvoke(source: InputFrames): InputInvoke {
  return async function* (input: InvokeInput, environment?: InvokeEnvironment) {
    environment?.signal?.throwIfAborted();
    const frames = source(input, environment);
    try {
      if (input.protocol_mode === "canonical") yield* canonicalEvents(frames);
      else yield* frames;
    } finally {
      environment?.signal?.throwIfAborted();
    }
  } as InputInvoke;
}
export interface InputInvoke {
  (
    input: InvokeInput & { protocol_mode: "canonical" },
    environment?: InvokeEnvironment
  ): AsyncGenerator<CanonicalEvent>;
  (
    input: InvokeInput & { protocol_mode?: "native" },
    environment?: InvokeEnvironment
  ): AsyncGenerator<HostFrame>;
  (input: InvokeInput, environment?: InvokeEnvironment): AsyncGenerator<CanonicalEvent | HostFrame>;
}

export function assertInvokeInput(value: unknown): asserts value is InvokeInput {
  assertJsonByteLimit(
    value instanceof InvokeInput ? { ...value } : value,
    INVOKE_REQUEST_MAX_BYTES,
    "INVOKE_REQUEST_TOO_LARGE"
  );
  assertJsonValue(value);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("InvokeInput must be a JSON object");
  const input = value as Record<string, unknown>;
  if (
    ["protocolMode", "adapterType", "request", "options"].some((key) => Object.hasOwn(input, key))
  )
    throw new TypeError(
      "InvokeInput requires the unified JSON contract, not a prepared request wrapper"
    );
  if (Object.hasOwn(input, "signal"))
    throw new TypeError("signal belongs to the local invoke environment");
  if (Object.hasOwn(input, "executionEnvOverrides"))
    throw new TypeError("executionEnvOverrides belongs to the local invoke environment");
  assertModelInputParts(input.inputs);
  assertContextEnvelope(input.contexts);
  for (const key of [
    "sessionId",
    "invocationId",
    "runId",
    "prompt",
    "modelInput",
    "freshFallbackModelInput"
  ])
    if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key]))
      throw new TypeError(`InvokeInput.${key} must be a non-empty string`);
  for (const key of ["workdir", "controlInstructions"])
    if (input[key] !== undefined && typeof input[key] !== "string")
      throw new TypeError(`InvokeInput.${key} must be a string`);
  for (const key of ["sessionGeneration", "providerEpoch"])
    if (
      input[key] !== undefined &&
      (!Number.isSafeInteger(input[key]) || (input[key] as number) < 0)
    )
      throw new TypeError(`InvokeInput.${key} must be a non-negative safe integer`);
  if (
    input.protocol_mode !== undefined &&
    !["native", "canonical"].includes(input.protocol_mode as string)
  )
    throw new TypeError("protocol_mode must be native or canonical");
  if (input.agentSource !== undefined) assertAgentSource(input.agentSource);
  if (input.approvalMode !== undefined) assertApprovalMode(input.approvalMode);
  if (
    input.continuityMode !== undefined &&
    !["fresh", "continue"].includes(input.continuityMode as string)
  )
    throw new TypeError("continuityMode must be fresh or continue");
  if (input.runtimeLimits !== undefined) assertRuntimeLimits(input.runtimeLimits);
  if (input.freshFallbackModelInputParts !== undefined)
    assertModelInputParts(input.freshFallbackModelInputParts);
  if (
    input.freshFallbackImagesUnavailable !== undefined &&
    typeof input.freshFallbackImagesUnavailable !== "boolean"
  )
    throw new TypeError("freshFallbackImagesUnavailable must be a boolean");
  for (const key of ["agentConfig", "runMetadata", "providerSession"])
    if (
      input[key] !== undefined &&
      (!input[key] || typeof input[key] !== "object" || Array.isArray(input[key]))
    )
      throw new TypeError(`InvokeInput.${key} must be a JSON object`);
  if (input.agentConfig) {
    const config = input.agentConfig as Record<string, unknown>;
    for (const key of [
      "workdir",
      "model",
      "sandbox",
      "providerAgentId",
      "effort",
      "openclawConfigPath",
      "openclawStateDir"
    ])
      if (config[key] !== undefined && typeof config[key] !== "string")
        throw new TypeError(`agentConfig.${key} must be a string`);
    if (
      config.timeoutSeconds !== undefined &&
      (typeof config.timeoutSeconds !== "number" || config.timeoutSeconds <= 0)
    )
      throw new TypeError("agentConfig.timeoutSeconds must be positive");
    if (
      config.providerOptions !== undefined &&
      (!config.providerOptions ||
        typeof config.providerOptions !== "object" ||
        Array.isArray(config.providerOptions))
    )
      throw new TypeError("agentConfig.providerOptions must be a JSON object");
  }
  if (input.providerSession) {
    const session = input.providerSession as Record<string, unknown>;
    if (typeof session.sessionId !== "string" || !session.sessionId.trim())
      throw new TypeError("providerSession.sessionId must be a non-empty string");
    if (session.resumable !== undefined && typeof session.resumable !== "boolean")
      throw new TypeError("providerSession.resumable must be a boolean");
    if (
      session.resumeOutcome !== undefined &&
      !["new", "resumed", "fresh_fallback", "compacted"].includes(session.resumeOutcome as string)
    )
      throw new TypeError("providerSession.resumeOutcome is invalid");
    if (session.resumeFallback !== undefined && typeof session.resumeFallback !== "string")
      throw new TypeError("providerSession.resumeFallback must be a string");
    if (
      session.contextInputVariant !== undefined &&
      !["primary", "recovery"].includes(session.contextInputVariant as string)
    )
      throw new TypeError("providerSession.contextInputVariant is invalid");
  }
}

/** Lossless field reorganization of a validated prepared execution, excluding its local signal. */
export function invocationInput(
  request: InvokeRequest,
  protocol_mode: "native" | "canonical" = "native",
  adapterType?: string
): InvokeInput {
  const {
    protocolVersion: _version,
    signal: _signal,
    executionEnvOverrides: _executionEnvOverrides,
    agentSessionId,
    context,
    modelInputParts,
    ...fields
  } = request;
  void _version;
  void _signal;
  void _executionEnvOverrides;
  const contexts = structuredClone(context);
  if (adapterType) {
    const adapter = contexts.items.find(
      (item) => item.namespace === "octo.execution" && item.name === "adapter"
    );
    if (adapter && adapter.payload.type !== adapterType)
      throw new TypeError("CONTEXT_PLAN_MISMATCH");
    if (!adapter)
      contexts.items.push({
        namespace: "octo.execution",
        name: "adapter",
        payload: {
          type: adapterType,
          ...(adapterType === "openclaw"
            ? { provider_agent_id: request.agentConfig.providerAgentId ?? "main" }
            : {})
        }
      });
  }
  return InvokeInput.check({
    ...fields,
    sessionId: agentSessionId,
    contexts,
    protocol_mode,
    inputs: modelInputParts ?? [{ type: "text", text: request.modelInput }]
  });
}

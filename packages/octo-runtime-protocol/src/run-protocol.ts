import { assertJsonValue } from "./context.js";
import { assertExecutionEvidence } from "./actmode.js";
import { assertCanonicalEvent, assertFailureEnvelope, type CanonicalEvent } from "./index.js";
import { safeCapacityEvidence } from "./failure.js";
import { isStreamCapacityReason } from "./stream-limits.js";
import type {
  ProtocolMode,
  RunProtocolErrorCode,
  HostInvokeOptions,
  HostRunReceipt,
  HostFrame,
  NativeHostFrame,
  CanonicalHostFrame,
  ControlHostFrame,
  HostControl,
  NativeInteractionResponse,
  AdapterProtocolSupport
} from "./generated/protocol-types.js";

export type {
  ProtocolMode,
  RunProtocolErrorCode,
  HostInvokeOptions,
  HostRunReceipt,
  HostFrame,
  NativeHostFrame,
  CanonicalHostFrame,
  ControlHostFrame,
  HostControl,
  NativeInteractionResponse,
  AdapterProtocolSupport
};

export const RUN_PROTOCOL_ERRORS = [
  "PROTOCOL_MODE_INVALID",
  "PROTOCOL_MODE_UNSUPPORTED",
  "EXECUTION_PROTOCOL_MISMATCH",
  "EXECUTION_IDENTITY_CONFLICT",
  "NATIVE_METHOD_UNSUPPORTED",
  "NATIVE_RESPONSE_INVALID",
  "INTERACTION_NOT_ACTIVE",
  "HOST_EXECUTION_FAILED",
  "HOST_ENDED_WITHOUT_TERMINAL",
  "PROVIDER_MESSAGE_TOO_LARGE",
  "HOST_FRAME_TOO_LARGE",
  "STREAM_QUEUE_ITEM_TOO_LARGE",
  "STREAM_QUEUE_BYTES_EXCEEDED",
  "STREAM_QUEUE_ITEMS_EXCEEDED",
  "STREAM_GAP",
  "STREAM_EXPIRED",
  "REMOTE_NATIVE_UNSUPPORTED",
  "HOST_FRAME_INVALID",
  "HOST_CONTROL_INVALID",
  "HOST_RECEIPT_INVALID",
  "PROTOCOL_SUPPORT_INVALID"
] as const satisfies readonly RunProtocolErrorCode[];

export function protocolError(
  code: (typeof RUN_PROTOCOL_ERRORS)[number],
  message: string = code
): Error & { code: (typeof RUN_PROTOCOL_ERRORS)[number] } {
  return Object.assign(new Error(message), { code });
}

/** Only an omitted mode defaults. A present undefined, null or empty value is invalid. */
export function resolveHostInvokeOptions(
  value: unknown = {}
): Readonly<Required<Pick<HostInvokeOptions, "protocolMode">> & HostInvokeOptions> {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["protocolMode", "protocol"].includes(key))
  )
    throw protocolError("PROTOCOL_MODE_INVALID");
  const mode = Object.hasOwn(value, "protocolMode") ? value.protocolMode : "native";
  if (mode !== "native" && mode !== "canonical") throw protocolError("PROTOCOL_MODE_INVALID");
  if (Object.hasOwn(value, "protocol") && !nonemptyString(value.protocol, 128))
    throw protocolError("EXECUTION_PROTOCOL_MISMATCH");
  assertProtocolJson(value, "PROTOCOL_MODE_INVALID");
  return Object.freeze({
    protocolMode: mode,
    ...(typeof value.protocol === "string" ? { protocol: value.protocol } : {})
  });
}

export function assertAdapterProtocolSupport(
  value: unknown
): asserts value is AdapterProtocolSupport {
  assertProtocolJson(value, "PROTOCOL_SUPPORT_INVALID");
  if (
    !isRecord(value) ||
    !exactKeys(value, ["protocol", "modes", "nativeMethods"]) ||
    !nonemptyString(value.protocol, 128) ||
    !Array.isArray(value.modes) ||
    !value.modes.length ||
    new Set(value.modes).size !== value.modes.length ||
    value.modes.some((mode) => mode !== "native" && mode !== "canonical") ||
    !Array.isArray(value.nativeMethods) ||
    new Set(value.nativeMethods).size !== value.nativeMethods.length ||
    value.nativeMethods.some((method) => !nonemptyString(method, 256))
  )
    throw protocolError("PROTOCOL_SUPPORT_INVALID");
  if (!value.modes.includes("native") && value.nativeMethods.length)
    throw protocolError("PROTOCOL_SUPPORT_INVALID");
}

export function assertProtocolSupport(
  support: AdapterProtocolSupport,
  options: HostInvokeOptions
): void {
  assertAdapterProtocolSupport(support);
  const resolved = resolveHostInvokeOptions(options);
  if (!support.modes.includes(resolved.protocolMode))
    throw protocolError("PROTOCOL_MODE_UNSUPPORTED");
  if (resolved.protocol !== undefined && resolved.protocol !== support.protocol)
    throw protocolError("EXECUTION_PROTOCOL_MISMATCH");
}

export function assertNativeInteractionResponse(
  value: unknown
): asserts value is NativeInteractionResponse {
  assertProtocolJson(value, "NATIVE_RESPONSE_INVALID");
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["requestId", "payload"].includes(key)) ||
    !requestId(value.requestId) ||
    !isRecord(value.payload)
  )
    throw protocolError("NATIVE_RESPONSE_INVALID");
}

const IDENTITY_KEYS = [
  "run_id",
  "invocation_id",
  "stream_id",
  "agent_session_id",
  "session_generation",
  "protocol_mode",
  "protocol"
];

export function assertHostRunReceipt(value: unknown): asserts value is HostRunReceipt {
  assertProtocolJson(value, "HOST_RECEIPT_INVALID");
  if (!isRecord(value) || !exactKeys(value, IDENTITY_KEYS) || !validIdentity(value))
    throw protocolError("HOST_RECEIPT_INVALID");
}

export function assertHostControl(value: unknown): asserts value is HostControl {
  assertProtocolJson(value, "HOST_CONTROL_INVALID");
  if (!isRecord(value)) throw protocolError("HOST_CONTROL_INVALID");
  if (
    value.type === "evidence" &&
    value.name === "execution" &&
    exactKeys(value, ["type", "name", "payload"])
  ) {
    try {
      assertExecutionEvidence(value.payload);
    } catch {
      throw protocolError("HOST_CONTROL_INVALID");
    }
    return;
  }
  if (
    value.type === "evidence" &&
    exactKeys(value, ["type", "name", "payload"]) &&
    value.name === "session" &&
    isRecord(value.payload)
  ) {
    return;
  }
  if (
    value.type === "state" &&
    exactKeys(value, ["type", "state"]) &&
    ["running", "completed", "failed", "cancelled", "lost"].includes(String(value.state))
  )
    return;
  if (
    value.type === "error" &&
    exactKeys(value, ["type", "code", "message"], ["failure"]) &&
    RUN_PROTOCOL_ERRORS.some((code) => code === value.code) &&
    typeof value.message === "string"
  ) {
    if (Object.hasOwn(value, "failure")) {
      try {
        assertFailureEnvelope(value.failure);
        const evidence = safeCapacityEvidence(value.failure.params);
        if (
          !isStreamCapacityReason(value.code) ||
          value.failure.reasonCode !== value.code ||
          !exactKeys(
            value.failure,
            [
              "schemaVersion",
              "code",
              "reasonCode",
              "category",
              "stage",
              "messageKey",
              "params",
              "retryable",
              "action",
              "diagnosticId",
              "source",
              "occurredAt"
            ],
            ["retryAfterMs", "cause"]
          ) ||
          !exactKeys(value.failure.source, ["component"], ["adapter"]) ||
          !exactKeys(value.failure.action, ["type", "labelKey"]) ||
          (value.failure.cause !== undefined &&
            !exactKeys(value.failure.cause, ["reasonCode"], ["httpStatus"])) ||
          Object.entries(value.failure.params).some(([key, entry]) => evidence[key] !== entry)
        )
          throw protocolError("HOST_CONTROL_INVALID");
      } catch {
        throw protocolError("HOST_CONTROL_INVALID");
      }
    }
    return;
  }
  if (
    value.type === "interaction" &&
    exactKeys(value, ["type", "requestId", "status"], ["expiresAt"]) &&
    requestId(value.requestId) &&
    ["pending", "resolved", "expired", "invalidated"].includes(String(value.status)) &&
    (!Object.hasOwn(value, "expiresAt") || safeInteger(value.expiresAt, 1)) &&
    (value.status !== "pending" || safeInteger(value.expiresAt, 1))
  )
    return;
  if (
    value.type === "gap" &&
    exactKeys(value, ["type", "requested_after_seq", "oldest_seq", "latest_seq"]) &&
    safeInteger(value.requested_after_seq, 0) &&
    safeInteger(value.oldest_seq, 1) &&
    safeInteger(value.latest_seq, 0) &&
    value.requested_after_seq + 1 < value.oldest_seq &&
    value.oldest_seq <= value.latest_seq + 1
  )
    return;
  throw protocolError("HOST_CONTROL_INVALID");
}

export function assertHostFrame(value: unknown): asserts value is HostFrame {
  assertProtocolJson(value, "HOST_FRAME_INVALID");
  if (!isRecord(value) || !validIdentity(value) || !safeInteger(value.seq, 1))
    throw protocolError("HOST_FRAME_INVALID");
  const identity = [...IDENTITY_KEYS, "seq", "kind"];
  if (
    value.kind === "native" &&
    value.protocol_mode === "native" &&
    exactKeys(value, [...identity, "messageKind", "payload"]) &&
    ["response", "notification", "request", "message"].includes(String(value.messageKind)) &&
    isRecord(value.payload)
  )
    return;
  if (
    value.kind === "canonical" &&
    value.protocol_mode === "canonical" &&
    exactKeys(value, [...identity, "event"])
  ) {
    if (!isRecord(value.event) || !exactKeys(value.event, ["protocolVersion", "type", "payload"]))
      throw protocolError("HOST_FRAME_INVALID");
    try {
      assertCanonicalEvent(value.event);
    } catch {
      throw protocolError("HOST_FRAME_INVALID");
    }
    for (const key of ["messageId", "stepId", "role", "status", "text", "reason", "message"]) {
      if (
        Object.hasOwn(value.event.payload, key) &&
        typeof Reflect.get(value.event.payload, key) !== "string"
      )
        throw protocolError("HOST_FRAME_INVALID", `CanonicalEvent.payload.${key} must be a string`);
    }
    return;
  }
  if (value.kind === "control" && exactKeys(value, [...identity, "control"])) {
    assertHostControl(value.control);
    return;
  }
  throw protocolError("HOST_FRAME_INVALID");
}

/** Subscription identity always comes from admission, never from omitted subscribe options. */
export function assertHostFrameIdentity(frame: HostFrame, receipt: HostRunReceipt): void {
  assertHostFrame(frame);
  assertHostRunReceipt(receipt);
  if (IDENTITY_KEYS.some((key) => Reflect.get(frame, key) !== Reflect.get(receipt, key)))
    throw protocolError("EXECUTION_IDENTITY_CONFLICT");
}

export function isHostTerminal(frame: HostFrame): boolean {
  return (
    frame.kind === "control" &&
    frame.control.type === "state" &&
    ["completed", "failed", "cancelled", "lost"].includes(frame.control.state)
  );
}

/** A typed view of the selected canonical stream, never a payload cast or format guess. */
export async function* canonicalEvents(
  frames: AsyncIterable<HostFrame>
): AsyncGenerator<CanonicalEvent> {
  let identity: HostRunReceipt | undefined;
  let lastSeq: number | undefined;
  for await (const frame of frames) {
    assertHostFrame(frame);
    if (frame.protocol_mode !== "canonical") throw protocolError("EXECUTION_PROTOCOL_MISMATCH");
    identity ??= {
      run_id: frame.run_id,
      invocation_id: frame.invocation_id,
      stream_id: frame.stream_id,
      agent_session_id: frame.agent_session_id,
      session_generation: frame.session_generation,
      protocol_mode: frame.protocol_mode,
      protocol: frame.protocol
    };
    assertHostFrameIdentity(frame, identity);
    if (lastSeq !== undefined && frame.seq !== lastSeq + 1) throw protocolError("STREAM_GAP");
    lastSeq = frame.seq;
    if (frame.kind === "canonical") {
      assertCanonicalEvent(frame.event);
      yield frame.event;
    } else if (frame.kind === "control" && frame.control.type === "gap")
      throw protocolError("STREAM_GAP");
    else if (frame.kind === "control" && frame.control.type === "error")
      throw Object.assign(new Error(frame.control.message), {
        code: frame.control.code,
        ...(frame.control.failure
          ? {
              ...safeCapacityEvidence(frame.control.failure.params),
              failure: frame.control.failure
            }
          : {})
      });
  }
}

function validIdentity(value: Record<string, unknown>): boolean {
  return (
    ["run_id", "invocation_id", "stream_id", "agent_session_id"].every((key) =>
      nonemptyString(value[key], 256)
    ) &&
    safeInteger(value.session_generation, 0) &&
    nonemptyString(value.protocol, 128) &&
    (value.protocol_mode === "native" || value.protocol_mode === "canonical")
  );
}

function assertProtocolJson(value: unknown, code: RunProtocolErrorCode): void {
  try {
    assertJsonValue(value);
  } catch {
    throw protocolError(code);
  }
}

function nonemptyString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && Array.from(value).length <= max;
}

function safeInteger(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function requestId(value: unknown): boolean {
  return nonemptyString(value, 256) || (typeof value === "number" && Number.isSafeInteger(value));
}

function exactKeys(value: object, required: string[], optional: string[] = []): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

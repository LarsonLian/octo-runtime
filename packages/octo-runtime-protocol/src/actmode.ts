import type { ContextEnvelope, ExecutionEvidence } from "./generated/protocol-types.js";

/** 只读取本轮已解析的显式意图；不补默认、不读取历史会话。 */
export function contextActmode(context: ContextEnvelope): "default" | "plan" | undefined {
  const item = context.items.find(
    (item) => item.namespace === "octo.execution" && item.name === "actmode"
  );
  if (!item) return undefined;
  if (item.payload.mode !== "default" && item.payload.mode !== "plan")
    throw new TypeError("CONTEXT_SCHEMA_INVALID");
  return item.payload.mode;
}

export function assertExecutionEvidence(value: unknown): asserts value is ExecutionEvidence {
  if (
    !record(value) ||
    Object.keys(value).some((key) => key !== "actmode") ||
    !record(value.actmode)
  )
    throw new TypeError("EXECUTION_EVIDENCE_INVALID");
  const mode = value.actmode;
  if (
    Object.keys(mode).some(
      (key) => !["requested", "effective", "status", "nativeMode", "reason"].includes(key)
    ) ||
    (mode.requested !== "default" && mode.requested !== "plan") ||
    !["default", "plan", null].includes(mode.effective as string | null) ||
    (mode.status !== "applied" && mode.status !== "fallback" && mode.status !== "unknown") ||
    (mode.nativeMode !== undefined && (typeof mode.nativeMode !== "string" || !mode.nativeMode)) ||
    (mode.reason !== undefined &&
      mode.reason !== "provider_unsupported" &&
      mode.reason !== "adapter_unmapped" &&
      mode.reason !== "provider_unconfirmed") ||
    (mode.status === "applied" &&
      (mode.effective !== mode.requested || mode.reason !== undefined)) ||
    (mode.status === "fallback" &&
      (mode.effective !== "default" ||
        (mode.reason !== "provider_unsupported" && mode.reason !== "adapter_unmapped"))) ||
    (mode.status === "unknown" &&
      (mode.effective !== null || mode.reason !== "provider_unconfirmed"))
  )
    throw new TypeError("EXECUTION_EVIDENCE_INVALID");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

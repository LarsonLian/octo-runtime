import type { CanonicalEvent } from "@mininglamp-oss/octo-harness-adapter-sdk";

type JsonRecord = Record<string, unknown>;

/** A decoded OpenClaw stdout event, discriminated by `kind`; keeps provider-native shape until normalized. */
export type OpenClawFrame =
  | { kind: "text"; text: string; sessionId?: string }
  | { kind: "tool-call"; id: string; name: string; args: JsonRecord }
  | { kind: "tool-result"; id: string; output: unknown; isError: boolean }
  | { kind: "usage"; inputTokens: number; outputTokens: number; provider?: string; model?: string }
  | { kind: "failure"; message: string }
  | { kind: "cancelled"; message: string };

/** The trailing "final blob" OpenClaw prints at the end of a run: authoritative reply text plus session/usage metadata. */
export interface OpenClawFinalFrame {
  kind: "final";
  text: string;
  aborted: boolean;
  sessionId?: string;
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
}

interface UsageLike {
  inputTokens: number;
  outputTokens: number;
  provider?: string;
  model?: string;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Best-effort JSON parse that returns null instead of throwing, so a malformed line is simply skipped. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Resolve a tool call id across the several field names OpenClaw uses, defaulting to "tool" when none is present. */
function toolId(native: JsonRecord): string {
  return string(native.callId) || string(native.toolCallId) || string(native.tool_call_id) ||
    string(native.tool_use_id) || string(native.id) || "tool";
}

/** Parse one OpenClaw stdout line into a frame, or null if the line is not a recognized event. */
export function tryParseOpenClawEvent(line: string): OpenClawFrame | null {
  const native = record(parseJson(line));
  if (!native) return null;

  switch (native.type) {
    case "text": {
      const text = string(native.text);
      if (!text) return null;
      return { kind: "text", text, sessionId: string(native.sessionId) || undefined };
    }
    case "tool_use":
      return {
        kind: "tool-call",
        id: toolId(native),
        name: string(native.tool) || string(native.name) || string(native.toolName) || "tool",
        args: record(native.input ?? native.args ?? native.arguments) ?? {}
      };
    case "tool_result":
      return {
        kind: "tool-result",
        id: toolId(native),
        output: native.output ?? native.result ?? native.text ?? native.content ?? "",
        isError: native.isError === true || native.is_error === true
      };
    case "step_finish": {
      const usage = record(native.usage);
      if (!usage) return null;
      const inputTokens = number(usage.input);
      const outputTokens = number(usage.output);
      if (inputTokens === 0 && outputTokens === 0) return null;
      return {
        kind: "usage",
        inputTokens,
        outputTokens,
        provider: string(usage.provider) || undefined,
        model: string(usage.model) || undefined
      };
    }
    case "error":
      return {
        kind: "failure",
        message: string(native.message) || string(native.error) || "OpenClaw reported an error"
      };
    case "lifecycle": {
      const phase = string(native.phase);
      if (!["error", "failed", "cancelled"].includes(phase)) return null;
      return {
        kind: phase === "cancelled" ? "cancelled" : "failure",
        message: string(native.message) || string(native.error) || `OpenClaw lifecycle phase=${phase}`
      };
    }
    default:
      return null;
  }
}

/** Parse the accumulated final blob (payloads + meta/usage) into a final frame, or null if it is not yet a complete/meaningful blob. */
export function tryParseOpenClawFinalBlob(text: string): OpenClawFinalFrame | null {
  const native = record(parseJson(text.trim()));
  if (!native || !Array.isArray(native.payloads)) return null;
  const reply = native.payloads
    .map(payload => string(record(payload)?.text))
    .filter(Boolean)
    .join("\n");
  const meta = record(native.meta);
  const agentMeta = record(meta?.agentMeta);
  const usage = record(agentMeta?.usage);
  if (!reply && meta?.aborted !== true && !agentMeta) return null;
  return {
    kind: "final",
    text: reply,
    aborted: meta?.aborted === true,
    sessionId: string(agentMeta?.sessionId) || undefined,
    provider: string(agentMeta?.provider) || undefined,
    model: string(agentMeta?.model) || undefined,
    inputTokens: number(usage?.input),
    outputTokens: number(usage?.output)
  };
}

/** Map a parsed frame to canonical events. */
export function normalizeOpenClawFrame(frame: OpenClawFrame): CanonicalEvent[] {
  // The parser preserves OpenClaw's native differences; this function only exposes provider-neutral canonical events upward.
  switch (frame.kind) {
    case "text":
      return [{ type: "message.delta", payload: { text: frame.text, channel: "final" } }];
    case "tool-call":
      return [{ type: "tool_call.create", payload: { id: frame.id, name: frame.name, args: frame.args } }];
    case "tool-result":
      return [{
        type: "tool_call.update",
        payload: { id: frame.id, status: frame.isError ? "error" : "completed", output: frame.output }
      }];
    case "usage":
      return [{ type: "usage.update", payload: usagePayload(frame) }];
    default:
      return [];
  }
}

/** Build the canonical usage payload, omitting provider/model when absent so the shape stays stable across frames. */
export function usagePayload(frame: UsageLike): Record<string, unknown> {
  return {
    inputTokens: frame.inputTokens ?? 0,
    outputTokens: frame.outputTokens ?? 0,
    ...(frame.provider ? { provider: frame.provider } : {}),
    ...(frame.model ? { model: frame.model } : {})
  };
}

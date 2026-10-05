import { canonicalTerminalStatus } from "@mininglamp-oss/octo-harness-protocol";
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

interface OpenClawTranscriptToolCall {
  id: string;
  name: string;
  args: JsonRecord;
}

/** One durable message appended by OpenClaw to its per-session JSONL transcript. */
export type OpenClawTranscriptFrame =
  | {
      kind: "assistant-step";
      stepId: string;
      reasoning: string[];
      text: string;
      tools: OpenClawTranscriptToolCall[];
      status: string;
      finishReason: string;
      startedAtMs?: number;
      endedAtMs?: number;
    }
  | {
      kind: "tool-result";
      id: string;
      name?: string;
      output: unknown;
      isError: boolean;
      durationMs?: number;
    };

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

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  const numeric = positiveInteger(value);
  if (numeric !== undefined) return numeric;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
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

function transcriptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(block => string(record(block)?.text))
    .filter(Boolean)
    .join("\n");
}

function finishReason(value: unknown): string {
  const reason = string(value);
  switch (reason.toLowerCase().replaceAll("_", "-")) {
    case "tooluse":
    case "tool-use":
    case "tool-calls":
      return "tool-calls";
    case "stop":
    case "end-turn":
    case "completed":
      return "stop";
    default:
      return reason;
  }
}

/** Parse one newly appended OpenClaw session transcript record. */
export function tryParseOpenClawTranscriptLine(line: string): OpenClawTranscriptFrame | null {
  const native = record(parseJson(line));
  const message = record(native?.message);
  if (!native || native.type !== "message" || !message) return null;

  const role = string(message.role);
  if (role === "assistant") {
    const nativeId = string(native.id) || string(message.responseId);
    if (!nativeId || !Array.isArray(message.content)) return null;
    const reasoning: string[] = [];
    const texts: string[] = [];
    const tools: OpenClawTranscriptToolCall[] = [];
    for (const value of message.content) {
      const block = record(value);
      if (!block) continue;
      switch (block.type) {
        case "thinking": {
          const thought = string(block.thinking);
          if (thought) reasoning.push(thought);
          break;
        }
        case "text": {
          const text = string(block.text);
          if (text) texts.push(text);
          break;
        }
        case "toolCall": {
          const id = string(block.id);
          if (!id) break;
          tools.push({
            id,
            name: string(block.name, "tool"),
            args: record(block.arguments) ?? {}
          });
          break;
        }
      }
    }
    const reason = finishReason(message.stopReason);
    const failed = ["error", "failed", "aborted", "cancelled"].includes(reason.toLowerCase());
    return {
      kind: "assistant-step",
      stepId: `openclaw:${nativeId}`,
      reasoning,
      text: texts.join("\n"),
      tools,
      status: failed ? "failed" : "completed",
      finishReason: reason,
      startedAtMs: timestamp(message.timestamp),
      endedAtMs: timestamp(native.timestamp)
    };
  }

  if (role === "toolResult") {
    const id = string(message.toolCallId);
    if (!id) return null;
    const details = record(message.details);
    return {
      kind: "tool-result",
      id,
      name: string(message.toolName) || undefined,
      output: transcriptText(message.content),
      isError: message.isError === true,
      durationMs: nonNegativeInteger(details?.durationMs)
    };
  }
  return null;
}

/** Stateful transcript normalizer that keeps tool results attached to their originating model round. */
export class OpenClawTranscriptNormalizer {
  private readonly toolSteps = new Map<string, string>();

  normalize(frame: OpenClawTranscriptFrame): CanonicalEvent[] {
    if (frame.kind === "tool-result") {
      const stepId = this.toolSteps.get(frame.id);
      return [{ protocolVersion: 2,
        type: "tool_call.update",
        payload: {
          id: frame.id,
          ...(frame.name ? { name: frame.name } : {}),
          status: canonicalTerminalStatus(frame.isError ? "failed" : "completed"),
          output: frame.output,
          ...(stepId ? { stepId } : {}),
          ...(frame.durationMs === undefined ? {} : { durationMs: frame.durationMs })
        }
      }];
    }

    const events: CanonicalEvent[] = [{ protocolVersion: 2,
      type: "model_step.started",
      payload: {
        stepId: frame.stepId,
        ...(frame.startedAtMs === undefined ? {} : { startedAtMs: frame.startedAtMs })
      }
    }];
    for (const thought of frame.reasoning) {
      events.push({ protocolVersion: 2,
        type: "message.delta",
        payload: {
          text: thought,
          stepId: frame.stepId,
          messageId: `${frame.stepId}:reasoning`,
          channel: "analysis",
          exposure: "public_reasoning",
          provenance: { provider: "openclaw", nativeEvent: "session.transcript.thinking" }
        }
      });
    }
    if (frame.text) {
      events.push({ protocolVersion: 2, type: "message.delta", payload: { text: frame.text, channel: "final", stepId: frame.stepId } });
    }
    for (const tool of frame.tools) {
      this.toolSteps.set(tool.id, frame.stepId);
      events.push({ protocolVersion: 2,
        type: "tool_call.create",
        payload: { status: "running", id: tool.id, name: tool.name, args: tool.args, stepId: frame.stepId }
      });
    }
    events.push({ protocolVersion: 2,
      type: "model_step.finished",
      payload: {
        stepId: frame.stepId,
        status: canonicalTerminalStatus(frame.status),
        ...(frame.finishReason ? { finishReason: frame.finishReason } : {}),
        ...(frame.endedAtMs === undefined ? {} : { endedAtMs: frame.endedAtMs })
      }
    });
    return events;
  }
}

/** Map a parsed frame to canonical events. */
export function normalizeOpenClawFrame(frame: OpenClawFrame): CanonicalEvent[] {
  // The parser preserves OpenClaw's native differences; this function only exposes provider-neutral canonical events upward.
  switch (frame.kind) {
    case "text":
      return [{ protocolVersion: 2, type: "message.delta", payload: { text: frame.text, channel: "final" } }];
    case "tool-call":
      return [{ protocolVersion: 2, type: "tool_call.create", payload: { status: "running", id: frame.id, name: frame.name, args: frame.args } }];
    case "tool-result":
      return [{ protocolVersion: 2,
        type: "tool_call.update",
        payload: { id: frame.id, status: canonicalTerminalStatus(frame.isError ? "error" : "completed"), output: frame.output }
      }];
    case "usage":
      return [{ protocolVersion: 2, type: "usage.update", payload: usagePayload(frame) }];
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

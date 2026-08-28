function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function string(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function toolId(native) {
  return string(native.callId) || string(native.toolCallId) || string(native.tool_call_id) ||
    string(native.tool_use_id) || string(native.id) || "tool";
}

export function tryParseOpenClawEvent(line) {
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

export function tryParseOpenClawFinalBlob(text) {
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

export function normalizeOpenClawFrame(frame) {
  switch (frame?.kind) {
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

export function usagePayload(frame) {
  return {
    inputTokens: frame.inputTokens ?? 0,
    outputTokens: frame.outputTokens ?? 0,
    ...(frame.provider ? { provider: frame.provider } : {}),
    ...(frame.model ? { model: frame.model } : {})
  };
}

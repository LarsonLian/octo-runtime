import type { AdapterInvocationContext } from "./index.js";
import type { CanonicalEvent } from "@mininglamp-oss/octo-harness-protocol";

/** ACP updates include both progress and completion; canonical update is terminal-only. */
export function acpToolTerminalStatus(value: unknown): "completed" | "failed" | "cancelled" | undefined {
  switch (typeof value === "string" ? value.toLowerCase() : value) {
    case "completed": case "success": case "succeeded": return "completed";
    case "failed": case "error": return "failed";
    case "cancelled": case "canceled": case "stopped": case "interrupted": return "cancelled";
    default: return undefined;
  }
}

export interface AcpToolUpdate {
  toolCallId?: string;
  status?: string;
  name?: string;
  title?: string;
  rawInput?: unknown;
  input?: unknown;
  rawOutput?: unknown;
  output?: unknown;
  content?: unknown;
}

export function normalizeAcpToolUpdate(update: AcpToolUpdate): CanonicalEvent[] {
  const id = update.toolCallId;
  if (!id) return [];
  const status = acpToolTerminalStatus(update.status);
  const output = update.rawOutput ?? update.output ?? update.content;
  if (status) {
    const input = update.rawInput ?? update.input;
    const name = update.name ?? update.title;
    return [{ protocolVersion: 2, type: "tool_call.update", payload: {
      id, status,
      ...(name ? { name } : {}),
      ...(input === undefined ? {} : { args: input !== null && typeof input === "object" && !Array.isArray(input) ? input : { value: input } }),
      ...(output === undefined ? {} : { output })
    } }];
  }
  // ACP content/rawOutput updates replace the provider's current tool result.
  // Status-only and unknown-status notifications must not invent a terminal.
  if (output === undefined) return [];
  return [{ protocolVersion: 2, type: "tool_call.delta", payload: {
    id, outputSnapshot: typeof output === "string" ? output : JSON.stringify(output)
  } }];
}

/** Unknown vendor states are diagnostic only; never log the raw notification. */
export function observeAcpToolStatus(context: AdapterInvocationContext | undefined, update: AcpToolUpdate & { sessionUpdate?: string; type?: string }): void {
  const type = update.sessionUpdate ?? update.type;
  if (!context || (type !== "tool_call" && type !== "tool_call_update") || update.status === undefined) return;
  if (acpToolTerminalStatus(update.status) || ["pending", "in_progress", "running"].includes(String(update.status).toLowerCase())) return;
  void context.observe({ event: "provider.output", rpcMethod: "session/update", data: {
    diagnostic_code: "ACP_TOOL_STATUS_UNRECOGNIZED", native_event_type: type, status_preserved: true
  } }).catch(() => undefined);
}

/**
 * OpenCode adapter: wraps the OpenCode CLI (`opencode run --format json
 * --thinking --auto`) and normalizes its JSON event/part stream into canonical
 * events. This adapter is an unattended local coding runtime, so tool
 * permissions are always auto-approved.
 */
import { createJsonCliAdapter, probeCommand, providerInputText, type CanonicalEvent, type InvokeRequest } from "@mininglamp-oss/octo-harness-adapter-sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A single OpenCode stream part; tool lifecycle is carried in `state.status` (running -> completed/error). */
interface OpenCodePart {
  sessionID?: string;
  messageID?: string;
  type?: string;
  text?: string;
  reason?: string;
  callID?: string;
  id?: string;
  tool?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    time?: { start?: unknown; end?: unknown };
  };
  tokens?: Record<string, unknown>;
  cost?: unknown;
  time?: { start?: unknown; end?: unknown };
}

/** A top-level OpenCode event, which may wrap a part and carries session/usage/error at the envelope level. */
interface OpenCodeNativeEvent extends OpenCodePart {
  sessionID?: string;
  sessionId?: string;
  part?: OpenCodePart;
  timestamp?: unknown;
  usage?: Record<string, unknown>;
  error?: { data?: { message?: string }; message?: string };
}

/**
 * Build the OpenCode CLI argv/env for one invocation.
 *
 * Harness context is injected as an extra entry in OpenCode's `instructions`
 * config (a temp markdown file) delivered through OPENCODE_CONFIG_CONTENT,
 * merged onto any inline config so the user's existing OpenCode config is not
 * overwritten. Returns a `cleanup` that removes the temp directory.
 *
 * The observation carrier contains the finalized argv and inline config,
 * including the user input and instruction-file reference actually exposed to
 * OpenCode. It must stay coupled to this builder as these transformations evolve.
 */
export async function buildOpenCodeCommand(req: InvokeRequest, command = "opencode") {
  const directory = await mkdtemp(join(tmpdir(), "octo-harness-opencode-"));
  const instructions = join(directory, "instructions.md");
  await writeFile(instructions, req.appendInstructions, { mode: 0o600 });
  let inline: Record<string, unknown> = {};
  if (process.env.OPENCODE_CONFIG_CONTENT) inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) as Record<string, unknown>;
  const configuredInstructions = Array.isArray(inline.instructions)
    ? inline.instructions.filter((value): value is string => typeof value === "string")
    : [];
  // Inject harness context via a temporary instructions file, without rewriting the user's existing OpenCode config.
  inline.instructions = [...configuredInstructions, instructions];
  // Reasoning output and non-interactive tool approval are mandatory parts of
  // this adapter's provider contract.
  const args = ["run", "--format", "json", "--thinking", "--auto"];
  if (req.providerSession?.sessionId) args.push("--session", req.providerSession.sessionId);
  if (req.agentConfig?.model) args.push("--model", req.agentConfig.model);
  const variant = typeof req.agentConfig?.thinking === "string" ? req.agentConfig.thinking : undefined;
  if (variant && variant !== "enabled" && variant !== "disabled") args.push("--variant", variant);
  args.push(providerInputText(req));
  return {
    command, args, env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(inline), OPENCODE_CLIENT: "octo-harness" },
    rpcMethod: "process.argv",
    providerSessionId: req.providerSession?.sessionId,
    // Do not fall back to the generic CommandSpec snapshot here: retaining the
    // logical inputs alongside argv makes file/config indirection evaluable.
    providerInput: {
      kind: "json_params" as const,
      content: {
        command,
        args,
        cwd: req.workdir,
        user_input: providerInputText(req),
        instructions: req.appendInstructions,
        inline_config: inline
      }
    },
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

/** Translate one OpenCode native event/part into canonical events; unrelated events yield an empty list. */
export function normalizeOpenCodeEvent(native: OpenCodeNativeEvent): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  const part: OpenCodePart = native.part ?? native;
  const sessionId = native.sessionID ?? native.sessionId ?? native.part?.sessionID;
  if ((native.type === "step_start" || native.type === "session.created") && sessionId) {
    events.push({ type: "session.update", payload: { providerSession: { sessionId, resumable: true } } });
  }
  const stepId = part.messageID;
  const timestamp = providerTimestamp(native.timestamp);
  if ((native.type === "step_start" || part.type === "step-start") && stepId) {
    events.push({
      type: "model_step.started",
      payload: { stepId, ...(timestamp === undefined ? {} : { startedAtMs: timestamp }) }
    });
  }
  const toolState = part.state;
  const toolId = part.callID ?? part.id;
  if ((native.type === "text" || part.type === "text") && typeof part.text === "string") {
    events.push({ type: "message.delta", payload: { text: part.text, ...(stepId ? { stepId } : {}) } });
  }
  if ((native.type === "reasoning" || part.type === "reasoning") && typeof part.text === "string") {
    events.push({
      type: "message.delta",
      payload: {
        text: part.text,
        ...(stepId ? { stepId, messageId: `opencode:${stepId}:reasoning` } : {}),
        channel: "analysis",
        exposure: "public_reasoning",
        provenance: { provider: "opencode", nativeEvent: "reasoning" }
      }
    });
  }
  if (part.type === "tool" && toolState?.status === "running" && toolId && part.tool) {
    const args = isRecord(toolState.input) ? toolState.input : toolState.input == null ? {} : { value: toolState.input };
    events.push({ type: "tool_call.create", payload: { id: toolId, name: part.tool, args, ...(stepId ? { stepId } : {}) } });
  }
  if (part.type === "tool" && toolId && toolState?.status && ["completed", "error"].includes(toolState.status)) {
    const args = isRecord(toolState.input) ? toolState.input : toolState.input == null ? {} : { value: toolState.input };
    const durationMs = toolDurationMs(toolState.time);
    // A terminal-only OpenCode frame carries enough identity to let the
    // projector create the item without inventing a duplicate start event.
    events.push({
      type: "tool_call.update",
      payload: {
        id: toolId,
        ...(part.tool ? { name: part.tool, args } : {}),
        status: toolState.status === "error" ? "failed" : toolState.status,
        output: toolState.output ?? toolState.error,
        ...(stepId ? { stepId } : {}),
        ...(durationMs === undefined ? {} : { durationMs })
      }
    });
  }
  if ((native.type === "step_finish" || part.type === "step-finish") && stepId) {
    events.push({
      type: "model_step.finished",
      payload: {
        stepId,
        status: "completed",
        ...(typeof part.reason === "string" ? { finishReason: part.reason } : {}),
        ...(timestamp === undefined ? {} : { endedAtMs: timestamp })
      }
    });
  }
  if (native.type === "step_finish" || part.type === "step-finish") {
    events.push({ type: "usage.update", payload: { ...(part.tokens ?? native.usage ?? {}), cost: part.cost, ...(stepId ? { stepId } : {}) } });
    if (part.reason === "stop") events.push({ type: "run.finished", payload: {} });
  }
  if (native.type === "error") events.push({ type: "run.error", payload: { message: native.error?.data?.message ?? native.error?.message ?? "OpenCode failed", providerError: native.error } });
  return events;
}

/** Narrow an unknown value to a plain object (excluding arrays), used to guard tool input before spreading it. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Return OpenCode's provider-measured whole-millisecond tool duration. */
function toolDurationMs(time: { start?: unknown; end?: unknown } | undefined): number | undefined {
  if (typeof time?.start !== "number" || typeof time.end !== "number") return undefined;
  if (!Number.isSafeInteger(time.start) || !Number.isSafeInteger(time.end) || time.end < time.start) return undefined;
  return time.end - time.start;
}

/** Preserve a provider event clock only when it is a valid Unix-millisecond value. */
function providerTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Create an OpenCode adapter over the JSON CLI helper. OpenCode's stream ends
 * without an explicit terminal, so `onSuccess` synthesizes the closing
 * message.update/run.finished; run.error is emitted inline by the normalizer.
 */
export function createOpenCodeAdapter({ command = "opencode" }: { command?: string } = {}) {
  return createJsonCliAdapter<OpenCodeNativeEvent>({
    metadata: { type: "opencode", capabilities: ["session.serialize", "tool.canonical"] },
    probe: () => probeCommand(command), buildCommand: req => buildOpenCodeCommand(req, command), normalize: normalizeOpenCodeEvent,
    onSuccess: () => [{ type: "message.update", payload: { role: "assistant", status: "completed" } }, { type: "run.finished", payload: {} }]
  });
}

export const opencodeAdapter = createOpenCodeAdapter();
export default opencodeAdapter;

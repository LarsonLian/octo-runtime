/**
 * OpenCode adapter: wraps the OpenCode CLI (`opencode run --format json`) and
 * normalizes its JSON event/part stream into canonical events. Dangerous
 * auto-approval (`--auto`) is opt-in via agentConfig.autoApprove.
 */
import { createJsonCliAdapter, probeCommand, providerInputText, type CanonicalEvent, type InvokeRequest } from "@mininglamp-oss/octo-harness-adapter-sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A single OpenCode stream part; tool lifecycle is carried in `state.status` (running -> completed/error). */
interface OpenCodePart {
  sessionID?: string;
  type?: string;
  text?: string;
  callID?: string;
  id?: string;
  tool?: string;
  state?: { status?: string; input?: unknown; output?: unknown; error?: unknown };
  tokens?: Record<string, unknown>;
  cost?: unknown;
}

/** A top-level OpenCode event, which may wrap a part and carries session/usage/error at the envelope level. */
interface OpenCodeNativeEvent extends OpenCodePart {
  sessionID?: string;
  sessionId?: string;
  part?: OpenCodePart;
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
  const args = ["run", "--format", "json"];
  if (req.providerSession?.sessionId) args.push("--session", req.providerSession.sessionId);
  if (req.agentConfig?.model) args.push("--model", req.agentConfig.model);
  if (req.agentConfig?.autoApprove === true) args.push("--auto");
  args.push(providerInputText(req));
  return {
    command, args, env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(inline), OPENCODE_CLIENT: "octo-harness" },
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

/** Translate one OpenCode native event/part into canonical events; unrelated events yield an empty list. */
export function normalizeOpenCodeEvent(native: OpenCodeNativeEvent): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  const sessionId = native.sessionID ?? native.sessionId ?? native.part?.sessionID;
  if ((native.type === "step_start" || native.type === "session.created") && sessionId) {
    events.push({ type: "session.update", payload: { providerSession: { sessionId, resumable: true } } });
  }
  const part: OpenCodePart = native.part ?? native;
  const toolState = part.state;
  const toolId = part.callID ?? part.id;
  if ((native.type === "text" || part.type === "text") && typeof part.text === "string") events.push({ type: "message.delta", payload: { text: part.text } });
  if (part.type === "tool" && toolState?.status === "running" && toolId && part.tool) {
    const args = isRecord(toolState.input) ? toolState.input : toolState.input == null ? {} : { value: toolState.input };
    events.push({ type: "tool_call.create", payload: { id: toolId, name: part.tool, args } });
  }
  if (part.type === "tool" && toolId && toolState?.status && ["completed", "error"].includes(toolState.status)) {
    events.push({ type: "tool_call.update", payload: { id: toolId, status: toolState.status, output: toolState.output ?? toolState.error } });
  }
  if (native.type === "step_finish" || part.type === "step-finish") events.push({ type: "usage.update", payload: { ...(part.tokens ?? native.usage ?? {}), cost: part.cost } });
  if (native.type === "error") events.push({ type: "run.error", payload: { message: native.error?.data?.message ?? native.error?.message ?? "OpenCode failed", providerError: native.error } });
  return events;
}

/** Narrow an unknown value to a plain object (excluding arrays), used to guard tool input before spreading it. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

import { createJsonCliAdapter, probeCommand, providerInputText, type CanonicalEvent, type InvokeRequest } from "@mininglamp-oss/octo-harness-adapter-sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

interface OpenCodeNativeEvent extends OpenCodePart {
  sessionID?: string;
  sessionId?: string;
  part?: OpenCodePart;
  usage?: Record<string, unknown>;
  error?: { data?: { message?: string }; message?: string };
}

export async function buildOpenCodeCommand(req: InvokeRequest, command = "opencode") {
  const directory = await mkdtemp(join(tmpdir(), "octo-harness-opencode-"));
  const instructions = join(directory, "instructions.md");
  await writeFile(instructions, req.appendInstructions, { mode: 0o600 });
  let inline: Record<string, unknown> = {};
  if (process.env.OPENCODE_CONFIG_CONTENT) inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) as Record<string, unknown>;
  const configuredInstructions = Array.isArray(inline.instructions)
    ? inline.instructions.filter((value): value is string => typeof value === "string")
    : [];
  // 通过临时指令文件注入 harness 上下文，不改写用户现有的 OpenCode 配置。
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createOpenCodeAdapter({ command = "opencode" }: { command?: string } = {}) {
  return createJsonCliAdapter<OpenCodeNativeEvent>({
    metadata: { type: "opencode", capabilities: ["session.serialize", "tool.canonical"] },
    probe: () => probeCommand(command), buildCommand: req => buildOpenCodeCommand(req, command), normalize: normalizeOpenCodeEvent,
    onSuccess: () => [{ type: "message.update", payload: { role: "assistant", status: "completed" } }, { type: "run.finished", payload: {} }]
  });
}

export const opencodeAdapter = createOpenCodeAdapter();
export default opencodeAdapter;

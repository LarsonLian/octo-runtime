import { createJsonCliAdapter, probeCommand } from "@orbtex-ai/adapter-sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function buildOpenCodeCommand(req, command = "opencode") {
  const directory = await mkdtemp(join(tmpdir(), "orbtex-opencode-"));
  const instructions = join(directory, "instructions.md");
  await writeFile(instructions, req.appendInstructions, { mode: 0o600 });
  let inline = {};
  if (process.env.OPENCODE_CONFIG_CONTENT) inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
  inline.instructions = [...(Array.isArray(inline.instructions) ? inline.instructions : []), instructions];
  const args = ["run", "--format", "json"];
  if (req.providerSession?.sessionId) args.push("--session", req.providerSession.sessionId);
  if (req.agentConfig?.model) args.push("--model", req.agentConfig.model);
  if (req.agentConfig?.autoApprove === true) args.push("--auto");
  args.push(req.prompt);
  return {
    command, args, env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(inline), OPENCODE_CLIENT: "orbtex" },
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

export function normalizeOpenCodeEvent(native) {
  const events = [];
  const sessionId = native.sessionID ?? native.sessionId ?? native.part?.sessionID;
  if ((native.type === "step_start" || native.type === "session.created") && sessionId) {
    events.push({ type: "session.update", payload: { providerSession: { sessionId, resumable: true } } });
  }
  const part = native.part ?? native;
  if ((native.type === "text" || part.type === "text") && typeof part.text === "string") events.push({ type: "message.delta", payload: { text: part.text } });
  if (part.type === "tool" && part.state?.status === "running") events.push({ type: "tool_call.create", payload: { id: part.callID ?? part.id, name: part.tool, args: part.state.input ?? {} } });
  if (part.type === "tool" && ["completed", "error"].includes(part.state?.status)) events.push({ type: "tool_call.update", payload: { id: part.callID ?? part.id, status: part.state.status, output: part.state.output ?? part.state.error } });
  if (native.type === "step_finish" || part.type === "step-finish") events.push({ type: "usage.update", payload: { ...(part.tokens ?? native.usage ?? {}), cost: part.cost } });
  if (native.type === "error") events.push({ type: "run.error", payload: { message: native.error?.data?.message ?? native.error?.message ?? "OpenCode failed", providerError: native.error } });
  return events;
}

export function createOpenCodeAdapter({ command = "opencode" } = {}) {
  return createJsonCliAdapter({
    metadata: { type: "opencode", capabilities: ["session.serialize", "tool.canonical"] },
    probe: () => probeCommand(command), buildCommand: req => buildOpenCodeCommand(req, command), normalize: normalizeOpenCodeEvent,
    onSuccess: () => [{ type: "message.update", payload: { role: "assistant", status: "completed" } }, { type: "run.finished", payload: {} }]
  });
}

export const opencodeAdapter = createOpenCodeAdapter();
export default opencodeAdapter;

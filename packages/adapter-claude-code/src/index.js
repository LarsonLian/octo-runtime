import { createJsonCliAdapter, probeCommand } from "@orbtex-ai/adapter-sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function buildClaudeCommand(req, command = "claude") {
  const directory = await mkdtemp(join(tmpdir(), "orbtex-claude-"));
  const promptFile = join(directory, "system-prompt.txt");
  await writeFile(promptFile, req.appendInstructions, { mode: 0o600 });
  const args = ["--print", "--input-format", "text", "--output-format", "stream-json", "--verbose", "--append-system-prompt-file", promptFile];
  if (req.providerSession?.sessionId) args.push("--resume", req.providerSession.sessionId);
  if (req.agentConfig?.model) args.push("--model", req.agentConfig.model);
  const mode = req.agentConfig?.permissionMode ?? "acceptEdits";
  args.push("--permission-mode", mode);
  if (mode === "bypassPermissions") args.push("--dangerously-skip-permissions");
  args.push("-");
  return { command, args, input: req.prompt, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

export function normalizeClaudeEvent(native) {
  if (native.type === "system" && native.session_id) return [{ type: "session.update", payload: { providerSession: { sessionId: native.session_id, resumable: true } } }];
  if (native.type === "assistant") {
    const events = [];
    for (const block of native.message?.content ?? []) {
      if (block.type === "text" && block.text) events.push({ type: "message.delta", payload: { text: block.text } });
      if (block.type === "tool_use") events.push({ type: "tool_call.create", payload: { id: block.id, name: block.name, args: block.input ?? {} } });
    }
    return events;
  }
  if (native.type === "result") return [
    { type: "usage.update", payload: native.usage ?? {} },
    { type: "message.update", payload: { role: "assistant", status: native.is_error ? "failed" : "completed", text: native.result } },
    { type: native.is_error ? "run.error" : "run.finished", payload: native.is_error ? { message: native.result ?? "Claude Code failed" } : {} }
  ];
  return [];
}

export function createClaudeCodeAdapter({ command = "claude" } = {}) {
  return createJsonCliAdapter({
    metadata: { type: "claude-code", capabilities: ["session.serialize", "tool.canonical"] },
    probe: () => probeCommand(command), buildCommand: req => buildClaudeCommand(req, command), normalize: normalizeClaudeEvent
  });
}

export const claudeCodeAdapter = createClaudeCodeAdapter();
export default claudeCodeAdapter;

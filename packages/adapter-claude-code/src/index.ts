import { createJsonCliAdapter, probeCommand, type CanonicalEvent, type InvokeRequest } from "@orbtex-ai/adapter-sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface ClaudeNativeEvent {
  type?: string;
  session_id?: string;
  message?: { content?: ClaudeContentBlock[] };
  usage?: Record<string, unknown>;
  is_error?: boolean;
  result?: string;
}

export async function buildClaudeCommand(req: InvokeRequest, command = "claude") {
  const directory = await mkdtemp(join(tmpdir(), "orbtex-claude-"));
  const promptFile = join(directory, "system-prompt.txt");
  // 控制提示词走 Claude 的专用文件参数，用户 prompt 仍从 stdin 输入，二者不会混淆。
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

export function normalizeClaudeEvent(native: ClaudeNativeEvent): CanonicalEvent[] {
  if (native.type === "system" && native.session_id) return [{ type: "session.update", payload: { providerSession: { sessionId: native.session_id, resumable: true } } }];
  if (native.type === "assistant") {
    const events: CanonicalEvent[] = [];
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

export function createClaudeCodeAdapter({ command = "claude" }: { command?: string } = {}) {
  return createJsonCliAdapter<ClaudeNativeEvent>({
    metadata: { type: "claude-code", capabilities: ["session.serialize", "tool.canonical"] },
    probe: () => probeCommand(command), buildCommand: req => buildClaudeCommand(req, command), normalize: normalizeClaudeEvent
  });
}

export const claudeCodeAdapter = createClaudeCodeAdapter();
export default claudeCodeAdapter;

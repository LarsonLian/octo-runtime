import { defineAdapter, probeCommand } from "@orbtex-ai/adapter-sdk";
import { spawnAcpClient } from "@orbtex-ai/acp-client";

export function normalizeCodeBuddyUpdate(update) {
  const type = update.sessionUpdate ?? update.type;
  if (type === "agent_message_chunk" || type === "agent_thought_chunk") {
    const text = update.content?.text ?? update.text;
    return typeof text === "string" ? [{ type: "message.delta", payload: { text, channel: type === "agent_thought_chunk" ? "analysis" : "final" } }] : [];
  }
  if (type === "tool_call") return [{ type: "tool_call.create", payload: { id: update.toolCallId, name: update.name ?? update.title ?? "provider_tool", args: update.rawInput ?? update.input ?? {} } }];
  if (type === "tool_call_update") return [{ type: "tool_call.update", payload: { id: update.toolCallId, status: update.status, output: update.content ?? update.output } }];
  if (type === "usage") return [{ type: "usage.update", payload: { ...update.usage, model: update.model } }];
  return [];
}

export function createCodeBuddyAdapter({ acpClientFactory = spawnAcpClient, command = "codebuddy" } = {}) {
  return defineAdapter({
    metadata: { type: "codebuddy", capabilities: ["session.serialize", "tool.canonical"] },
    probe: () => probeCommand(command),
    async *invoke(req) {
      const client = acpClientFactory({
        command, args: ["--acp", "--permission-mode", req.agentConfig?.permissionMode ?? "acceptEdits", "--disallowedTools", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode"],
        cwd: req.workdir, signal: req.signal
      });
      try {
        await client.initialize();
        const session = req.providerSession?.sessionId
          ? await client.loadSession(req.providerSession.sessionId, { cwd: req.workdir })
          : await client.newSession({ cwd: req.workdir, model: req.agentConfig?.model });
        yield { type: "session.update", payload: { providerSession: { sessionId: session.id, resumable: true, model: req.agentConfig?.model } } };
        yield { type: "message.create", payload: { role: "assistant", status: "streaming" } };
        for await (const update of client.prompt(session.id, `${req.prompt}\n\n${req.appendInstructions}`)) {
          for (const event of normalizeCodeBuddyUpdate(update)) yield event;
        }
        yield { type: "message.update", payload: { role: "assistant", status: "completed" } };
        yield { type: "run.finished", payload: {} };
      } finally { await client.close?.(); }
    }
  });
}

export const codebuddyAdapter = createCodeBuddyAdapter();
export default codebuddyAdapter;

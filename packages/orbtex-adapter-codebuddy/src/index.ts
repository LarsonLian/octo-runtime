import { defineAdapter, probeCommand, type CanonicalEvent, type InvokeRequest } from "@orbtex-ai/orbtex-adapter-sdk";
import { spawnAcpClient } from "@orbtex-ai/orbtex-acp-client";
import type { AcpUpdate } from "@orbtex-ai/orbtex-acp-client";

interface CodeBuddyUpdate extends AcpUpdate {
  sessionUpdate?: string;
  content?: unknown;
  text?: string;
  toolCallId?: string;
  name?: string;
  title?: string;
  rawInput?: unknown;
  input?: unknown;
  status?: string;
  output?: unknown;
}

export function normalizeCodeBuddyUpdate(update: CodeBuddyUpdate): CanonicalEvent[] {
  const type = update.sessionUpdate ?? update.type;
  if (type === "agent_message_chunk" || type === "agent_thought_chunk") {
    const text = isRecord(update.content) && typeof update.content.text === "string" ? update.content.text : update.text;
    return typeof text === "string" ? [{ type: "message.delta", payload: { text, channel: type === "agent_thought_chunk" ? "analysis" : "final" } }] : [];
  }
  if (type === "tool_call") {
    if (!update.toolCallId) return [];
    const value = update.rawInput ?? update.input;
    const args = isRecord(value) ? value : value == null ? {} : { value };
    return [{
      type: "tool_call.create",
      payload: { id: update.toolCallId, name: update.name ?? update.title ?? "provider_tool", args }
    }];
  }
  if (type === "tool_call_update") {
    if (!update.toolCallId || !update.status) return [];
    return [{
      type: "tool_call.update",
      payload: { id: update.toolCallId, status: update.status, output: update.content ?? update.output }
    }];
  }
  if (type === "usage") return [{ type: "usage.update", payload: { ...update.usage, model: update.model } }];
  return [];
}

export function createCodeBuddyAdapter({ acpClientFactory = spawnAcpClient, command = "codebuddy" }: { acpClientFactory?: typeof spawnAcpClient; command?: string } = {}) {
  return defineAdapter({
    metadata: { type: "codebuddy", capabilities: ["session.serialize", "tool.canonical"] },
    probe: () => probeCommand(command),
    async *invoke(req: InvokeRequest): AsyncGenerator<CanonicalEvent> {
      const client = acpClientFactory({
        command, args: ["--acp", "--permission-mode", req.agentConfig?.permissionMode ?? "acceptEdits"],
        cwd: req.workdir, signal: req.signal
      });
      try {
        await client.initialize();
        // Orbtex session 只保存 provider sessionId；新建和恢复都收敛到同一个 ACP prompt 流。
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const codebuddyAdapter = createCodeBuddyAdapter();
export default codebuddyAdapter;

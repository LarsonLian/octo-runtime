import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (args[0] !== "agent" || !args.includes("--local") || !args.includes("--json")) {
  process.stderr.write("expected: agent --local --json\n");
  process.exit(2);
}

const sessionId = option("--session-id");
const messageFile = option("--message-file");
const prompt = messageFile ? await readFile(messageFile, "utf8") : option("--message") ?? "";

if (prompt.includes("FAKE_WAIT_FOR_CANCEL")) {
  process.stdout.write(`${JSON.stringify({ type: "text", text: "ready", sessionId })}\n`);
  setInterval(() => {}, 1000);
} else {
  const transcriptEnabled = process.env.FAKE_OPENCLAW_TRANSCRIPT === "1" && process.env.OPENCLAW_STATE_DIR;
  if (transcriptEnabled) {
    const startedAt = Date.now();
    const sessionsDir = join(process.env.OPENCLAW_STATE_DIR, "agents", "main", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const records = [
      {
        type: "message", id: "assistant-1", timestamp: new Date(startedAt + 20).toISOString(),
        message: {
          role: "assistant", timestamp: startedAt, stopReason: "toolUse",
          content: [
            { type: "thinking", thinking: "Inspect the repository." },
            { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } }
          ]
        }
      },
      {
        type: "message", id: "tool-result-1", timestamp: new Date(startedAt + 35).toISOString(),
        message: {
          role: "toolResult", timestamp: startedAt + 21, toolCallId: "tool-1", toolName: "read",
          isError: false, content: [{ type: "text", text: "fixture" }], details: { durationMs: 15 }
        }
      },
      {
        type: "message", id: "assistant-2", timestamp: new Date(startedAt + 50).toISOString(),
        message: {
          role: "assistant", timestamp: startedAt + 36, stopReason: "stop",
          content: [{ type: "text", text: "OpenClaw reply" }]
        }
      }
    ];
    await appendFile(join(sessionsDir, `${sessionId}.jsonl`), `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
  }
  const lines = transcriptEnabled ? [] : [
    { type: "text", text: "OpenClaw ", sessionId },
    { type: "tool_use", tool: "read", callId: "tool-1", input: { path: "README.md" } },
    { type: "tool_result", tool: "read", callId: "tool-1", text: "fixture", isError: false },
    { type: "step_finish", usage: { input: 12, output: 3, provider: "fixture", model: "fixture-model" } }
  ];
  for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`);
  process.stdout.write(`${JSON.stringify({
    payloads: [{ text: "OpenClaw reply" }],
    meta: {
      durationMs: 5,
      aborted: false,
      agentMeta: { sessionId, provider: "fixture", model: "fixture-model", usage: { input: 12, output: 3 } }
    }
  }, null, 2)}\n`);
}

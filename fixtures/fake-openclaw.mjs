import { readFile } from "node:fs/promises";

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
  const lines = [
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

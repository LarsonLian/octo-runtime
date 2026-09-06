import { createInterface } from "node:readline";

const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
  if (message.method === "session/new") return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "acp-fixture-session" } });
  if (message.method === "session/load") return send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "session/prompt") {
    const sessionId = message.params.sessionId;
    if (message.params.prompt?.[0]?.text?.includes("FAIL_PROVIDER_REQUEST")) {
      return send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "fixture prompt rejected" }
      });
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ACP reply" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tool-1", name: "Read", rawInput: { path: "README.md" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", output: "ok" } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } } });
  }
  send({ jsonrpc: "2.0", id: message.id, result: {} });
});

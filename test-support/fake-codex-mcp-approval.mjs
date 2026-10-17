import { createInterface } from "node:readline";

const reader = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ id, result });

reader.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {});
    return;
  }
  if (message.method === "thread/start") {
    if (message.params.approvalPolicy !== "untrusted") {
      send({
        id: message.id,
        error: { code: -32000, message: "MCP approval policy must be untrusted" }
      });
      return;
    }
    reply(message.id, { thread: { id: "thread-mcp-approval" } });
    return;
  }
  if (message.method === "turn/start") {
    reply(message.id, { turn: { id: "turn-mcp-approval" } });
    send({
      id: "approval-mcp",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-mcp-approval", turnId: "turn-mcp-approval" }
    });
    return;
  }
  if (message.id === "approval-mcp") {
    if (message.result?.decision !== "accept") process.exitCode = 1;
    send({
      method: "item/started",
      params: {
        threadId: "thread-mcp-approval",
        turnId: "turn-mcp-approval",
        item: {
          id: "mcp-call",
          type: "mcpToolCall",
          server: "octo-integration",
          tool: "octo_echo",
          arguments: { value: "fixture" },
          status: "inProgress"
        }
      }
    });
    send({
      method: "item/completed",
      params: {
        threadId: "thread-mcp-approval",
        turnId: "turn-mcp-approval",
        item: {
          id: "mcp-call",
          type: "mcpToolCall",
          server: "octo-integration",
          tool: "octo_echo",
          arguments: { value: "fixture" },
          status: "completed",
          result: { content: [{ type: "text", text: "octo-echo:fixture" }] }
        }
      }
    });
    send({
      method: "turn/completed",
      params: {
        threadId: "thread-mcp-approval",
        turnId: "turn-mcp-approval",
        turn: { id: "turn-mcp-approval", status: "completed" }
      }
    });
  }
});

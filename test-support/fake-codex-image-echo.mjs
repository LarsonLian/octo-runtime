import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const rpc = JSON.parse(line);
  if (rpc.method === "initialize") send({ id: rpc.id, result: {} });
  else if (rpc.method === "thread/start")
    send({ id: rpc.id, result: { thread: { id: "image-thread" } } });
  else if (rpc.method === "thread/resume") {
    if (rpc.params.excludeTurns !== true)
      send({ id: rpc.id, error: { code: -32000, message: "history must be excluded" } });
    else send({ id: rpc.id, result: { thread: { id: "image-thread" } } });
  } else if (rpc.method === "turn/start") {
    send({ id: rpc.id, result: { turn: { id: "image-turn" } } });
    const content = rpc.params.input;
    const scenario = content.find((part) => part.type === "text")?.text;
    send({
      method: "item/started",
      params: {
        threadId: "image-thread",
        turnId: "image-turn",
        item: {
          id: "user-image",
          type: "userMessage",
          content,
          ...(scenario === "oversized-other-content" ? { extra: "x".repeat(256 * 1024) } : {})
        }
      }
    });
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: "image-thread",
        turnId: "image-turn",
        itemId: "answer",
        delta: "image accepted"
      }
    });
    send({
      method: "turn/completed",
      params: {
        threadId: "image-thread",
        turnId: "image-turn",
        turn: { id: "image-turn", status: "completed" }
      }
    });
  }
}

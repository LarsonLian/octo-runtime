import { createInterface } from "node:readline";
const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\n");
let scenario;
const finish = () =>
  send({
    method: "turn/completed",
    params: {
      threadId: "thread-native",
      turnId: "turn-native",
      turn: { id: "turn-native", status: "completed", future: { nested: [1, null, "raw"] } }
    },
    extension: { retained: true }
  });
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialize")
    send({ id: message.id, result: { privateInit: "excluded" } });
  else if (message.method === "thread/start")
    send({ id: message.id, result: { thread: { id: "thread-native" }, future: { exact: true } } });
  else if (message.method === "turn/start") {
    scenario = message.params.input[0].text;
    if (scenario === "rpc-error") {
      send({
        id: message.id,
        error: { code: -32123, message: "original error", data: { nested: [1, "raw"] } },
        unknown: true
      });
      continue;
    }
    send({ id: message.id, result: { turn: { id: "turn-native" } } });
    send({ method: "account/updated", params: { token: "excluded" } });
    send({
      method: "item/agentMessage/delta",
      params: { threadId: "other-thread", turnId: "turn-native", delta: "excluded" }
    });
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-native",
        turnId: "turn-native",
        itemId: "native-item-id",
        delta: "",
        extra: { keep: ["a", 2] }
      },
      future: "not canonical"
    });
    if (scenario === "approval")
      send({
        id: 42,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-native",
          turnId: "turn-native",
          command: "printf native",
          extra: { preserve: true }
        },
        future: ["original"]
      });
    else if (scenario === "unknown")
      send({
        id: "unknown-request",
        method: "global/config/write",
        params: { value: "do not apply" }
      });
    else if (scenario !== "hang" && scenario !== "eof") finish();
    else if (scenario === "eof") process.exit(0);
  } else if (message.id === 42) {
    send({
      method: "native/replyObserved",
      params: { threadId: "thread-native", turnId: "turn-native", reply: message }
    });
    finish();
  } else if (message.id === "unknown-request") {
    if (message.error?.code !== -32601) process.exit(1);
    finish();
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({
      method: "turn/completed",
      params: {
        threadId: "thread-native",
        turnId: "turn-native",
        turn: { id: "turn-native", status: "interrupted" }
      }
    });
  }
}

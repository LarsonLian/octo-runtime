import { createInterface } from "node:readline";
const reader = createInterface({ input: process.stdin });
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const emit = (method, params = {}) => send({ method, params: { threadId: "thread-final", turnId: "turn-final", ...params } });
const finish = status => emit("turn/completed", { turn: { id: "turn-final", status } });
let mode;
reader.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (["thread/start", "thread/resume"].includes(message.method)) send({ id: message.id, result: { thread: { id: "thread-final" } } });
  if (message.method === "turn/start") {
    mode = message.params.input[0].text;
    send({ id: message.id, result: { turn: { id: "turn-final" } } });
    emit("turn/started", { turn: { id: "turn-final" } });
    if (mode === "open-tool") emit("item/started", { item: { id: "tool", type: "commandExecution", command: "sleep 1", status: "inProgress" } });
    const item = { id: "answer", type: "agentMessage", phase: mode === "commentary" ? "commentary" : "final_answer", text: "answer preserved" };
    emit("item/started", { item });
    emit("item/completed", { item });
    if (mode === "new-work") setTimeout(() => emit("item/started", { item: { id: "reason", type: "reasoning" } }), 20);
    if (["normal", "commentary", "open-tool", "new-work"].includes(mode)) setTimeout(() => finish("completed"), mode === "normal" ? 10 : 150);
  }
  if (message.method === "turn/interrupt") {
    if (mode === "ignore-interrupt") return;
    send({ id: message.id, result: {} });
    finish("interrupted");
  }
});

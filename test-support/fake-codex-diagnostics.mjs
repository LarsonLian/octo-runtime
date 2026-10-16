import { createInterface } from "node:readline";

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const emit = (method, params = {}) =>
  send({ method, params: { threadId: "thread-diagnostic", turnId: "turn-diagnostic", ...params } });
const finish = (status) =>
  emit("turn/completed", {
    turn: {
      id: "turn-diagnostic",
      status,
      ...(status === "failed"
        ? { error: { message: "Synthetic terminal failure", codexErrorInfo: "unauthorized" } }
        : {})
    }
  });
const item = (text) =>
  emit("item/completed", {
    item: { id: "answer", type: "agentMessage", phase: "final_answer", text }
  });

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "config/read") send({ id: message.id, result: { config: {} } });
  if (["skills/extraRoots/set", "skills/config/write"].includes(message.method))
    send({ id: message.id, result: {} });
  if (message.method === "skills/list") send({ id: message.id, result: { data: [] } });
  if (["thread/start", "thread/resume"].includes(message.method))
    send({ id: message.id, result: { thread: { id: "thread-diagnostic" } } });
  if (message.method === "turn/start") {
    const mode = message.params.input[0].text.match(/DIAGNOSTIC_QA:(\w+)/)?.[1] ?? "silent";
    send({ id: message.id, result: { turn: { id: "turn-diagnostic" } } });
    emit("turn/started", { turn: { id: "turn-diagnostic" } });
    if (mode !== "normal") {
      emit("error", {
        willRetry: false,
        error: { message: "Synthetic in-turn diagnostic", codexErrorInfo: "unauthorized" }
      });
      emit("error", { willRetry: true, message: "Synthetic reconnect" });
      emit("error", {
        willRetry: false,
        error: { message: "Later diagnostic must not replace first" }
      });
    }
    if (mode === "tool") {
      emit("item/started", {
        item: {
          id: "tool",
          type: "commandExecution",
          command: "printf synthetic",
          status: "inProgress"
        }
      });
      emit("item/completed", {
        item: {
          id: "tool",
          type: "commandExecution",
          command: "printf synthetic",
          status: "completed",
          exitCode: 0
        }
      });
    }
    if (["recovered", "normal", "eof", "nonzero", "malformed"].includes(mode))
      item(`DIAGNOSTIC_QA:${mode}:answer`);
    if (mode === "snapshot") {
      item("old partial");
      item("");
    }
    if (mode === "eof") {
      process.exitCode = 0;
      process.stdin.destroy();
      return;
    }
    if (mode === "nonzero") {
      process.exit(3);
    }
    if (mode === "malformed") {
      process.stdout.write("{broken\n");
      process.stdin.destroy();
      return;
    }
    if (mode === "wait") return;
    finish(mode === "failed" ? "failed" : "completed");
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    finish("interrupted");
  }
});

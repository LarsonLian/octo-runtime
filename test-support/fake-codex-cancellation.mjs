import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const reader = createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
let threadId = "thread-cancel";

reader.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    respond(message.id, { userAgent: "fake-codex-cancellation" });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    respond(message.id, { thread: { id: threadId } });
    return;
  }
  if (message.method === "turn/start") {
    const prompt = message.params.input?.[0]?.text ?? "";
    const pidFile = prompt.match(/PID_FILE=([^\s]+)/)?.[1];
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore"
    });
    if (pidFile && grandchild.pid) writeFileSync(pidFile, String(grandchild.pid));
    respond(message.id, { turn: { id: "turn-cancel", status: "inProgress", items: [] } });
    notify("turn/started", {
      threadId,
      turn: { id: "turn-cancel", status: "inProgress", items: [] }
    });
    notify("item/started", {
      threadId,
      turnId: "turn-cancel",
      item: { type: "agentMessage", id: "message-waiting", text: "" }
    });
    notify("item/agentMessage/delta", {
      threadId,
      turnId: "turn-cancel",
      itemId: "message-waiting",
      delta: "waiting"
    });
    return;
  }
  if (message.method === "turn/interrupt") {
    respond(message.id, {});
  }
});

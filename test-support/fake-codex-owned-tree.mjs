import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const [mode, readyPath, tickPath] = process.argv.slice(2);
if (mode === "tool") {
  process.on("SIGTERM", () => {});
  appendFileSync(tickPath, ".");
  process.send("ready");
  setInterval(() => appendFileSync(tickPath, "."), 20);
} else {
  const send = (message, callback) =>
    process.stdout.write(`${JSON.stringify(message)}\n`, callback);
  const respond = (id, result) => send({ id, result });
  const threadId = "owned-thread",
    turnId = "owned-turn";
  createInterface({ input: process.stdin })
    .on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") respond(message.id, {});
      if (message.method === "thread/start") respond(message.id, { thread: { id: threadId } });
      if (message.method === "turn/start") {
        const tool = spawn(
          process.execPath,
          [fileURLToPath(import.meta.url), "tool", readyPath, tickPath],
          {
            // 后代与 leader 同组，但不继承 stdout；leader close 不能被后代持管道延迟。
            stdio: ["ignore", "ignore", "ignore", "ipc"]
          }
        );
        tool.once("message", () => {
          tool.disconnect();
          writeFileSync(readyPath, JSON.stringify({ parentPid: process.pid, childPid: tool.pid }));
          respond(message.id, { turn: { id: turnId } });
          if (mode.startsWith("complete")) {
            send(
              {
                method: "turn/completed",
                params: { threadId, turn: { id: turnId, status: "completed" } }
              },
              () => {
                if (mode === "complete") process.exit(0);
              }
            );
          }
        });
      }
      if (message.method === "turn/interrupt") {
        send({ id: message.id, result: {} }, () => process.exit(0));
      }
    })
    .on("close", () => {
      if (mode === "complete-eof") process.exit(0);
    });
}

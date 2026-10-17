import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const [
  readyPath = process.env.OCTO_REVIEW_READY,
  tickPath = process.env.OCTO_REVIEW_TICKS,
  mode = "host"
] = process.argv.slice(2);
if (mode === "host")
  createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: [] }) + "\n");
  });
let markReady;
const treeReady = new Promise((resolve) => {
  markReady = resolve;
});
if (mode === "zcode")
  createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    const result = request.method === "session/create" ? { sessionId: "tree-session" } : {};
    process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
    if (request.method === "session/send")
      void treeReady.then(() => {
        process.stdout.write(
          JSON.stringify({
            method: "session/event",
            params: {
              sessionId: "tree-session",
              seq: 1,
              type: "turn.completed",
              payload: { resultType: "success" }
            }
          }) + "\n"
        );
        process.exit(0);
      });
  });
if (mode === "tool") {
  process.on("SIGTERM", () => {});
  process.send("ready");
  setInterval(() => appendFileSync(tickPath, "."), 20);
} else {
  if (mode === "ignore-term") process.on("SIGTERM", () => {});
  const tool = spawn(
    process.execPath,
    [new URL(import.meta.url).pathname, readyPath, tickPath, "tool"],
    {
      stdio: ["ignore", "inherit", "inherit", "ipc"]
    }
  );
  tool.once("message", () => {
    const identity = { parentPid: process.pid, childPid: tool.pid };
    writeFileSync(readyPath, JSON.stringify(identity));
    markReady();
    process.stdout.write(JSON.stringify(identity) + "\n");
    if (mode === "parent-exits") process.exit(0);
  });
  setInterval(() => {}, 1000);
}

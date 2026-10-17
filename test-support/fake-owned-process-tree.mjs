import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const [readyPath, tickPath, mode] = process.argv.slice(2);
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
    process.stdout.write(JSON.stringify(identity) + "\n");
    if (mode === "parent-exits") process.exit(0);
  });
  setInterval(() => {}, 1000);
}

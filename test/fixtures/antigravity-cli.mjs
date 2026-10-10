#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

if (process.argv.includes("--version")) {
  console.log("1.3.3");
  process.exit(0);
}
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const input = JSON.parse(readFileSync(0, "utf8"));
const send = event => console.log(JSON.stringify(event));
if (input.event !== "user") throw new Error("wrong stdin event");
const sessionId = args.includes("--conversation") ? value("--conversation") : "fixture-conversation";
send({ event: "init", conversation_id: sessionId });
switch (args.includes("--model") ? value("--model") : "default") {
  case "empty": break;
  case "bad-json": console.log("not JSON"); break;
  case "exit-error": console.error("provider stopped"); process.exit(7); break;
  case "provider-error": send({ event: "result", result: { status: "ERROR", error: "unknown model" } }); break;
  case "log-error":
    writeFileSync(value("--log-file"), "exiting agent loop due to error: model is unavailable\n");
    setInterval(() => {}, 1000);
    break;
  case "hang": {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "inherit" });
    process.on("SIGTERM", () => {});
    send({ event: "step_update", step_update: { step_index: 0, step_type: "tool", state: "ACTIVE", tool_name: "run_command", tool_info: { parameters: { parentPid: process.pid, childPid: child.pid } } } });
    setInterval(() => {}, 1000);
    break;
  }
  default:
    send({ event: "step_update", step_update: { step_index: 1, step_type: "agent_response", state: "DONE", text_delta: "fixture answer", usage: { input_tokens: 12, output_tokens: 3 } } });
    send({ event: "result", result: { status: "SUCCESS", conversation_id: sessionId, response: "fixture answer", usage: { input_tokens: 1000, output_tokens: 999 } } });
}

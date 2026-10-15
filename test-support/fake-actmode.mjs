import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const log = args[args.indexOf("--log") + 1];
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
if (args.includes("--print")) {
  appendFileSync(log, `${JSON.stringify({args})}\n`);
  const lines = createInterface({ input: process.stdin });
  lines.once("line", () => {
    send({ type: "system", subtype: "init", session_id: "claude-actmode", permissionMode: args[args.indexOf("--permission-mode") + 1] });
    send({ type: "result", subtype: "success", is_error: false, result: "MODE_OK" });
  });
} else {
  createInterface({ input: process.stdin }).on("line", line => {
    const message = JSON.parse(line);
    appendFileSync(log, `${line}\n`);
    if (message.id === undefined) return;
    if (message.method === "collaborationMode/list") {
      send({ id: message.id, result: { data: [{mode:"default"}, ...(args.includes("--unsupported") ? [] : [{mode:"plan"}])] } });
    } else if (["thread/start", "thread/resume"].includes(message.method)) {
      send({ id: message.id, result: { thread:{id:"codex-actmode"}, model:"provider-chosen-model", reasoningEffort:"medium" } });
    } else if (message.method === "turn/start") {
      if (args.includes("--fail-turn")) return send({ id:message.id, error:{code:-32000,message:"provider unavailable"} });
      send({ id: message.id, result: { turn:{id:"turn-actmode"} } });
      send({ method:"turn/completed", params:{threadId:"codex-actmode",turnId:"turn-actmode",turn:{id:"turn-actmode",status:"completed"}} });
    } else send({ id: message.id, result: {} });
  });
}

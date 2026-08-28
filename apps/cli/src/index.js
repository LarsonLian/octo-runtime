#!/usr/bin/env node
import net from "node:net";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const { positionals, flags } = parseArguments(process.argv.slice(2));
const [group, action, id] = positionals;
if (group === "daemon") await import("../../daemon/src/index.js");
else {
  const request = command(group, action, id, flags);
  try { console.log(JSON.stringify(await callDaemon(request), null, 2)); }
  catch (error) { console.error(JSON.stringify({ error: error.message }, null, 2)); process.exitCode = 1; }
}

function parseArguments(args) {
  const flags = {}; const positionals = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) { positionals.push(args[i]); continue; }
    const key = args[i].slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    flags[key] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
  }
  return { flags, positionals };
}

function required(value, name) { if (!value) throw new Error(`missing --${name}`); return value; }
function json(value, fallback = {}) { return value ? JSON.parse(value) : fallback; }

function command(group, action, id, f) {
  if (!group || group === "help" || f.help) return { method: "help" };
  if (group === "status") return { method: "status" };
  if (group === "adapter" && action === "list") return { method: "adapter.list" };
  if (group === "adapter" && action === "probe") return { method: "adapter.probe", params: { adapterType: required(id, "adapter-type") } };
  if (group === "agent" && action === "list") return { method: "agent.list" };
  if (group === "agent" && action === "create") return { method: "agent.create", params: { name: required(f.name, "name"), adapterType: required(f.adapter, "adapter"), config: { workdir: resolve(f.workdir ?? "."), ...(f.model ? { model: f.model } : {}), ...(f.providerAgent ? { providerAgentId: f.providerAgent } : {}), ...(f.thinking ? { thinking: f.thinking } : {}), ...(f.timeoutSeconds ? { timeoutSeconds: Number(f.timeoutSeconds) } : {}), ...(f.permissionMode ? { permissionMode: f.permissionMode } : {}), ...(f.sandbox ? { sandbox: f.sandbox } : {}), ...(f.dangerouslyBypassPermissions === true ? { dangerouslyBypassPermissions: true } : {}), ...(f.autoApprove === true ? { autoApprove: true } : {}) } } };
  if (group === "chat" && action === "create") return { method: "chat.create", params: { agentId: required(f.agent, "agent"), title: f.title ?? "New chat", channel: f.channel ?? "local" } };
  if (group === "chat" && action === "list") return { method: "chat.list" };
  if (group === "chat" && action === "get") return { method: "chat.get", params: { sessionId: required(id, "session-id") } };
  if (group === "chat" && action === "send") return { method: "chat.send", params: { sessionId: required(id, "session-id"), prompt: required(f.prompt, "prompt"), instructions: f.instruction ?? "" } };
  if (group === "trigger" && action === "list") return { method: "trigger.list" };
  if (group === "trigger" && action === "create") return { method: "trigger.create", params: { name: required(f.name, "name"), kind: f.kind ?? "manual", agentId: required(f.agent, "agent"), ...(f.eventType ? { eventType: f.eventType, filter: json(f.filter, undefined) } : {}), ...(f.everyMs ? { everyMs: Number(f.everyMs) } : {}), task: { title: required(f.title, "title"), description: required(f.instruction, "instruction") } } };
  if (group === "trigger" && action === "fire") return { method: "trigger.fire", params: { triggerId: required(id, "trigger-id"), externalEventId: f.eventId ?? randomUUID(), payload: json(f.payload) } };
  if (group === "event" && action === "ingest") return { method: "event.ingest", params: { eventType: required(f.type, "type"), externalEventId: f.eventId ?? randomUUID(), payload: json(f.payload) } };
  if (group === "task" && action === "list") return { method: "task.list" };
  if (group === "task" && action === "get") return { method: "task.get", params: { taskId: required(id, "task-id") } };
  if (group === "task" && action === "continue") return { method: "task.continue", params: { taskId: required(id, "task-id"), sourceType: f.sourceType ?? "comment", sourceId: f.sourceId ?? randomUUID(), instructions: f.instruction ?? "" } };
  if (group === "run" && ["get", "events", "wait"].includes(action)) return { method: `run.${action}`, params: { runId: required(id, "run-id") } };
  if (group === "run" && action === "cancel") return { method: "run.cancel", params: { runId: required(id, "run-id"), reason: f.reason ?? "cancelled_by_user" } };
  throw new Error("unknown command; run orbtex help");
}

async function callDaemon(request) {
  if (request.method === "help") return { usage: [
    "orbtex daemon", "orbtex status", "orbtex adapter list|probe <type>",
    "orbtex agent create --name N --adapter TYPE [--workdir DIR] [--model M] [--provider-agent SLUG]", "orbtex agent list",
    "orbtex chat create --agent ID [--title T]", "orbtex chat send ID --prompt TEXT", "orbtex chat list|get ID",
    "orbtex trigger create --name N --kind manual|event|interval --agent ID --title T --instruction TEXT", "orbtex trigger fire ID [--event-id ID]", "orbtex trigger list",
    "orbtex event ingest --type TYPE --event-id ID [--payload JSON]",
    "orbtex task list|get ID|continue ID --instruction TEXT", "orbtex run get|events|wait|cancel ID"
  ] };
  const home = resolve(process.env.ORBTEX_HOME ?? ".orbtex");
  const socketPath = resolve(process.env.ORBTEX_SOCKET ?? `${home}/daemon.sock`);
  const socket = net.createConnection(socketPath);
  await new Promise((resolveConnection, reject) => { socket.once("connect", resolveConnection); socket.once("error", reject); });
  socket.write(`${JSON.stringify({ id: randomUUID(), ...request })}\n`);
  const response = await new Promise((resolveResponse, reject) => {
    createInterface({ input: socket }).once("line", line => { try { resolveResponse(JSON.parse(line)); } catch (error) { reject(error); } });
    socket.once("error", reject);
  });
  if (response.error) throw new Error(response.error.message);
  return response.result;
}

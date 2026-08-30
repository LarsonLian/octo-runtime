#!/usr/bin/env node
import net from "node:net";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { resolveDaemonRuntimePaths } from "@orbtex-ai/daemon-app/runtime-options";

type FlagValue = string | boolean;
type Flags = Record<string, FlagValue>;

interface CliRequest {
  method: string;
  params?: Record<string, unknown>;
}

interface CliResponse {
  result?: unknown;
  event?: unknown;
  error?: { message?: string; code?: string };
}

const cliArguments = process.argv.slice(2);
if (cliArguments[0] === "--") cliArguments.shift();
const { positionals, flags } = parseArguments(cliArguments);
const [group, action, id] = positionals;

try {
  if (group === "daemon") await import("../../daemon/dist/launcher.js");
  else {
    const request = command(group, action, id, flags);
    if (request.method === "chat.send" && flags.follow === true) {
      const acknowledgement = await callDaemon(request);
      writeJsonLine({ kind: "ack", result: acknowledgement });
      await streamDaemon({
        method: "run.stream",
        params: { runId: resultString(acknowledgement, "runId") }
      });
    } else if (request.method === "run.stream") {
      await streamDaemon(request);
    } else {
      console.log(JSON.stringify(await callDaemon(request), null, 2));
    }
  }
} catch (error) {
  console.error(JSON.stringify({ error: errorMessage(error) }, null, 2));
  process.exitCode = 1;
}

function parseArguments(args: string[]): { flags: Flags; positionals: string[] } {
  const flags: Flags = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const key = argument.slice(2).replace(/-([a-z])/g, (_match: string, char: string) => char.toUpperCase());
    const next = args[index + 1];
    flags[key] = next && !next.startsWith("--") ? args[++index] : true;
  }
  return { flags, positionals };
}

function required(value: FlagValue | string | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing --${name}`);
  return value;
}

function optionalString(value: FlagValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function json(value: FlagValue | undefined, fallback: unknown = {}): unknown {
  return typeof value === "string" ? JSON.parse(value) : fallback;
}

function command(group: string | undefined, action: string | undefined, id: string | undefined, flags: Flags): CliRequest {
  if (!group || group === "help" || flags.help) return { method: "help" };
  if (group === "status") return { method: "status" };
  if (group === "adapter" && action === "list") return { method: "adapter.list" };
  if (group === "adapter" && action === "probe") return { method: "adapter.probe", params: { adapterType: required(id, "adapter-type") } };
  if (group === "agent" && action === "list") return { method: "agent.list" };
  if (group === "agent" && action === "create") {
    const workdir = optionalString(flags.workdir) ?? ".";
    const model = optionalString(flags.model);
    const providerAgentId = optionalString(flags.providerAgent);
    const thinking = optionalString(flags.thinking);
    const timeoutSeconds = optionalString(flags.timeoutSeconds);
    const permissionMode = optionalString(flags.permissionMode);
    const sandbox = optionalString(flags.sandbox);
    return {
      method: "agent.create",
      params: {
        name: required(flags.name, "name"),
        adapterType: required(flags.adapter, "adapter"),
        config: {
          workdir: resolve(workdir),
          ...(model ? { model } : {}),
          ...(providerAgentId ? { providerAgentId } : {}),
          ...(thinking ? { thinking } : {}),
          ...(timeoutSeconds ? { timeoutSeconds: Number(timeoutSeconds) } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(sandbox ? { sandbox } : {}),
          ...(flags.dangerouslyBypassPermissions === true ? { dangerouslyBypassPermissions: true } : {}),
          ...(flags.autoApprove === true ? { autoApprove: true } : {})
        }
      }
    };
  }
  if (group === "chat" && action === "create") {
    return { method: "chat.create", params: { agentId: required(flags.agent, "agent"), title: optionalString(flags.title) ?? "New chat", channel: optionalString(flags.channel) ?? "local" } };
  }
  if (group === "chat" && action === "list") return { method: "chat.list" };
  if (group === "chat" && action === "get") return { method: "chat.get", params: { sessionId: required(id, "session-id") } };
  if (group === "chat" && action === "send") {
    return { method: "chat.send", params: { sessionId: required(id, "session-id"), prompt: required(flags.prompt, "prompt"), instructions: optionalString(flags.instruction) ?? "" } };
  }
  if (group === "trigger" && action === "list") return { method: "trigger.list" };
  if (group === "trigger" && action === "create") {
    const eventType = optionalString(flags.eventType);
    const everyMs = optionalString(flags.everyMs);
    return {
      method: "trigger.create",
      params: {
        name: required(flags.name, "name"),
        kind: optionalString(flags.kind) ?? "manual",
        agentId: required(flags.agent, "agent"),
        ...(eventType ? { eventType, filter: json(flags.filter, undefined) } : {}),
        ...(everyMs ? { everyMs: Number(everyMs) } : {}),
        task: { title: required(flags.title, "title"), description: required(flags.instruction, "instruction") }
      }
    };
  }
  if (group === "trigger" && action === "fire") {
    return { method: "trigger.fire", params: { triggerId: required(id, "trigger-id"), externalEventId: optionalString(flags.eventId) ?? randomUUID(), payload: json(flags.payload) } };
  }
  if (group === "event" && action === "ingest") {
    return { method: "event.ingest", params: { eventType: required(flags.type, "type"), externalEventId: optionalString(flags.eventId) ?? randomUUID(), payload: json(flags.payload) } };
  }
  if (group === "task" && action === "list") return { method: "task.list" };
  if (group === "task" && action === "get") return { method: "task.get", params: { taskId: required(id, "task-id") } };
  if (group === "task" && action === "continue") {
    return {
      method: "task.continue",
      params: {
        taskId: required(id, "task-id"),
        sourceType: optionalString(flags.sourceType) ?? "comment",
        sourceId: optionalString(flags.sourceId) ?? randomUUID(),
        instructions: optionalString(flags.instruction) ?? ""
      }
    };
  }
  if (group === "run" && action && ["get", "events", "wait"].includes(action)) {
    return { method: `run.${action}`, params: { runId: required(id, "run-id") } };
  }
  if (group === "run" && action === "stream") {
    const fromSeq = optionalString(flags.fromSeq);
    return {
      method: "run.stream",
      params: {
        runId: required(id, "run-id"),
        ...(fromSeq ? { fromSeq: Number(fromSeq) } : {})
      }
    };
  }
  if (group === "run" && action === "cancel") {
    return { method: "run.cancel", params: { runId: required(id, "run-id"), reason: optionalString(flags.reason) ?? "cancelled_by_user" } };
  }
  throw new Error("unknown command; run orbtex help");
}

async function callDaemon(request: CliRequest): Promise<unknown> {
  if (request.method === "help") {
    return { usage: [
      "orbtex daemon", "orbtex status", "orbtex adapter list|probe <type>",
      "orbtex agent create --name N --adapter TYPE [--workdir DIR] [--model M] [--provider-agent SLUG]", "orbtex agent list",
      "orbtex chat create --agent ID [--title T]", "orbtex chat send ID --prompt TEXT [--follow]", "orbtex chat list|get ID",
      "orbtex trigger create --name N --kind manual|event|interval --agent ID --title T --instruction TEXT", "orbtex trigger fire ID [--event-id ID]", "orbtex trigger list",
      "orbtex event ingest --type TYPE --event-id ID [--payload JSON]",
      "orbtex task list|get ID|continue ID --instruction TEXT", "orbtex run get|events|wait|stream|cancel ID"
    ] };
  }

  const socket = await connectDaemon();
  socket.write(`${JSON.stringify({ id: randomUUID(), ...request })}\n`);
  const response = await new Promise<CliResponse>((resolveResponse, reject) => {
    createInterface({ input: socket }).once("line", line => {
      try {
        resolveResponse(JSON.parse(line) as CliResponse);
      } catch (error) {
        reject(toError(error));
      }
    });
    socket.once("error", reject);
  });
  if (response.error) throw new Error(response.error.message ?? "daemon request failed");
  return response.result;
}

async function streamDaemon(request: CliRequest): Promise<void> {
  const socket = await connectDaemon();
  socket.write(`${JSON.stringify({ id: randomUUID(), ...request })}\n`);
  let done = false;
  try {
    for await (const line of createInterface({ input: socket })) {
      const response = JSON.parse(line) as CliResponse;
      if (response.error) throw new Error(response.error.message ?? "daemon stream failed");
      if (response.event !== undefined) writeJsonLine({ kind: "event", event: response.event });
      if (response.result !== undefined) {
        writeJsonLine({ kind: "done", result: response.result });
        done = true;
        break;
      }
    }
    if (!done) throw new Error("daemon stream closed before completion");
  } finally {
    socket.destroy();
  }
}

async function connectDaemon(): Promise<net.Socket> {
  const { socketPath } = resolveDaemonRuntimePaths([]);
  const socket = net.createConnection(socketPath);
  try {
    await new Promise<void>((resolveConnection, reject) => {
      socket.once("connect", resolveConnection);
      socket.once("error", reject);
    });
  } catch (error) {
    socket.destroy();
    const code = (error as NodeJS.ErrnoException).code;
    if (code && ["ENOENT", "ECONNREFUSED", "EINVAL"].includes(code)) {
      throw new Error(
        `cannot connect to Orbtex daemon at ${socketPath}; start it from the repository root with: pnpm daemon`,
        { cause: error }
      );
    }
    throw error;
  }
  return socket;
}

function writeJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function resultString(value: unknown, name: string): string {
  if (!isRecord(value) || typeof value[name] !== "string" || value[name].length === 0) {
    throw new Error(`daemon result requires ${name}`);
  }
  return value[name];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

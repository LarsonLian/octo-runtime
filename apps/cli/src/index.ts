#!/usr/bin/env node
import net from "node:net";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { resolveDaemonRuntimePaths } from "../../daemon/dist/runtime-options.js";
import { openBrowser, startLogViewer } from "./log-viewer.js";

type FlagValue = string | boolean;
type Flags = Record<string, FlagValue>;

/** One CLI-to-daemon call: `{ id, method, params }` serialized as a single JSON
 * line over the Unix socket. This is the daemon control-plane shape, not JSON-RPC. */
interface CliRequest {
  method: string;
  params?: Record<string, unknown>;
}

/** One JSON line from the daemon: a unary `result`, one streamed `event`, or an
 * `error`. A `run.stream` connection emits many `event` lines then a final `result`. */
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
  // `daemon` is handled in-process by importing the launcher; every other command
  // becomes a single request/response (or stream) against a running daemon.
  if (group === "daemon") await import("../../daemon/dist/launcher.js");
  else if (group === "logs" && action === "open") {
    // The viewer belongs to the invoking CLI process and dies with it. It is not
    // a daemon endpoint and never widens the daemon's Unix-socket trust boundary.
    await runLogViewer(flags);
  }
  else {
    const request = command(group, action, id, flags);
    if (request.method === "agent_run.stream") {
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
    // `--kebab-case` becomes `camelCase`; a flag with no following value is boolean.
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

/** Translate positional command + flags into a daemon request. Unknown commands
 * throw; `help` is answered locally without touching the socket. */
function command(group: string | undefined, action: string | undefined, id: string | undefined, flags: Flags): CliRequest {
  if (!group || group === "help" || flags.help) return { method: "help" };
  if (group === "status") return { method: "status" };
  if (group === "logs" && action === "path") return { method: "logs.path" };
  if (group === "logs" && action === "query") {
    const limit = optionalString(flags.limit);
    return {
      method: "logs.query",
      params: {
        ...(id ? { runId: id } : {}),
        ...(optionalString(flags.invocation) ? { invocationId: optionalString(flags.invocation) } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
        includeSensitive: flags.sensitive === true
      }
    };
  }
  if (group === "adapter" && action === "list") return { method: "adapter.list" };
  if (group === "adapter" && action === "probe") return { method: "adapter.probe", params: { adapterType: required(id, "adapter-type") } };
  if (group === "agent-session" && action && ["list", "get"].includes(action)) {
    return action === "list"
      ? { method: "agent_session.list" }
      : { method: "agent_session.get", params: { agentSessionId: required(id, "agent-session-id") } };
  }
  if (group === "agent-run" && action && ["list", "get", "events", "wait"].includes(action)) {
    return action === "list"
      ? { method: "agent_run.list" }
      : { method: `agent_run.${action}`, params: { agentRunId: required(id, "agent-run-id") } };
  }
  if (group === "agent-run" && action === "stream") {
    const fromSeq = optionalString(flags.fromSeq);
    return {
      method: "agent_run.stream",
      params: {
        agentRunId: required(id, "agent-run-id"),
        ...(fromSeq ? { fromSeq: Number(fromSeq) } : {})
      }
    };
  }
  if (group === "agent-run" && action === "cancel") {
    return { method: "agent_run.cancel", params: { agentRunId: required(id, "agent-run-id"), reason: optionalString(flags.reason) ?? "cancelled_by_operator" } };
  }
  throw new Error("unknown command; run octo-harness help");
}

/** Send one request and read exactly one JSON-line response. `help` is served
 * locally. The daemon closes the socket after the single reply. */
async function callDaemon(request: CliRequest): Promise<unknown> {
  if (request.method === "help") {
    return { usage: [
      "octo-harness daemon", "octo-harness status", "octo-harness adapter list|probe <type>",
      "octo-harness logs path|query [RUN_ID] [--sensitive]", "octo-harness logs open [--run RUN_ID] [--no-open]",
      "octo-harness agent-session list|get ID",
      "octo-harness agent-run list|get|events|wait|stream|cancel ID"
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

async function runLogViewer(flags: Flags): Promise<void> {
  const runId = optionalString(flags.run);
  const host = optionalString(flags.host) ?? "127.0.0.1";
  const portValue = optionalString(flags.port);
  const viewer = await startLogViewer({
    host,
    port: portValue ? Number(portValue) : 0,
    ...(runId ? { initialRunId: runId } : {}),
    query: options => callDaemon({ method: "logs.viewer", params: { ...options } })
  });
  // Print the capability-bearing URL before opening a browser so headless callers
  // can consume it without scraping platform launcher output.
  console.log(JSON.stringify({ url: viewer.url, pid: process.pid }));
  if (flags.noOpen !== true) openBrowser(viewer.url);
  await new Promise<void>(resolveStop => {
    const stop = (): void => resolveStop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await viewer.close();
}

/** Consume a run event stream: many `event` lines followed by a terminal
 * `result`. Errors and a stream that closes before the terminal both throw. */
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

/** Connect to the daemon's Unix socket (path derived from the same runtime
 * resolution the daemon uses), mapping "not running" errno codes to a hint. */
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
        `cannot connect to Octo Harness daemon at ${socketPath}; start it with: octo-harness daemon`,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

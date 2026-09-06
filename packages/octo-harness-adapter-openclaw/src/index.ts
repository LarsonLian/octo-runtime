import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defineAdapter, probeCommand, providerInputText, type AdapterInvocationContext, type CanonicalEvent, type InvokeRequest, type ProviderCarrier } from "@mininglamp-oss/octo-harness-adapter-sdk";
import {
  normalizeOpenClawFrame,
  tryParseOpenClawEvent,
  tryParseOpenClawFinalBlob,
  usagePayload,
  type OpenClawFinalFrame
} from "./parser.js";

/** Cap retained stderr so a chatty process cannot grow the buffer without bound; only the tail feeds the failure message. */
const STDERR_LIMIT = 64 * 1024;

interface OpenClawCommandSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  providerSessionId: string;
  providerAgentId?: string;
  messageFile: string;
  /** Final argv plus the message-file content that OpenClaw will consume. */
  providerInput: ProviderCarrier;
  cleanup: () => Promise<void>;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Compose the OpenClaw prompt, prefixing harness instructions in labeled sections so the local agent can distinguish them from the user request. */
export function composeOpenClawPrompt(req: InvokeRequest): string {
  const input = providerInputText(req);
  if (!req.appendInstructions) return input;
  return `[Harness Instructions]\n${req.appendInstructions}\n\n[User Request]\n${input}`;
}

/** Return the first accessible directory among the candidates, falling back to the current working directory. */
async function existingDirectory(candidates: Array<string | undefined>): Promise<string> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { await access(candidate); return candidate; } catch {
      // Skip a candidate that does not exist and keep trying; ultimately fall back to the current directory.
    }
  }
  return process.cwd();
}

/**
 * Build the OpenClaw CLI argv, env and stdin for one invocation.
 *
 * The prompt is written to a private `--message-file` rather than passed on the
 * command line. A provider session id is generated when none is resumed, so the
 * local session is addressable. The chosen `cwd` is the first existing of the
 * configured state/config dirs, then $HOME, so OpenClaw finds its local state.
 * The observation carrier includes the file body, not just its ephemeral path,
 * because the file contents are the provider-visible model input.
 */
export async function buildOpenClawCommand(
  req: InvokeRequest,
  command = "openclaw",
  commandArgsPrefix: string[] = [],
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<OpenClawCommandSpec> {
  const directory = await mkdtemp(join(tmpdir(), "octo-harness-openclaw-message-"));
  await chmod(directory, 0o700).catch(() => {});
  const messageFile = join(directory, "message.txt");
  await writeFile(messageFile, composeOpenClawPrompt(req), { encoding: "utf8", mode: 0o600 });
  await chmod(messageFile, 0o600).catch(() => {});

  const providerSessionId = req.providerSession?.sessionId ?? `octo-harness-${randomUUID()}`;
  const configuredAgent = req.agentConfig.providerOptions?.OPENCLAW_AGENT_ID;
  const providerAgentId = req.agentConfig.providerAgentId ??
    (typeof configuredAgent === "string" ? configuredAgent : undefined);
  const args = [...commandArgsPrefix, "agent", "--local", "--json", "--session-id", providerSessionId];
  if (providerAgentId) args.push("--agent", providerAgentId);
  if (req.agentConfig?.model) args.push("--model", req.agentConfig.model);
  if (req.agentConfig?.thinking) args.push("--thinking", req.agentConfig.thinking);
  const timeoutSeconds = req.agentConfig.timeoutSeconds;
  if (Number.isFinite(timeoutSeconds) && (timeoutSeconds ?? 0) > 0) {
    args.push("--timeout", String(timeoutSeconds));
  }
  args.push("--message-file", messageFile);

  const env = { ...extraEnv };
  if (req.agentConfig?.openclawConfigPath) env.OPENCLAW_CONFIG_PATH = req.agentConfig.openclawConfigPath;
  if (req.agentConfig?.openclawStateDir) env.OPENCLAW_STATE_DIR = req.agentConfig.openclawStateDir;
  const effectiveEnv = { ...process.env, ...env };
  const cwd = await existingDirectory([
    effectiveEnv.OPENCLAW_STATE_DIR,
    effectiveEnv.OPENCLAW_CONFIG_PATH ? dirname(effectiveEnv.OPENCLAW_CONFIG_PATH) : undefined,
    effectiveEnv.HOME || homedir(),
    process.cwd()
  ]);

  return {
    command,
    args,
    cwd,
    env,
    providerSessionId,
    providerAgentId,
    messageFile,
    providerInput: {
      kind: "json_params",
      content: {
        command,
        args,
        cwd,
        message: composeOpenClawPrompt(req),
        session_id: providerSessionId,
        agent_id: providerAgentId,
        model: req.agentConfig?.model,
        thinking: req.agentConfig?.thinking
      }
    },
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

/** Build a session.update event carrying the provider session (and optional agent) id for replay on the next invocation. */
function sessionEvent(sessionId: string, providerAgentId?: string): CanonicalEvent {
  return {
    type: "session.update",
    payload: {
      providerSession: {
        sessionId,
        resumable: true,
        ...(providerAgentId ? { agentId: providerAgentId } : {})
      }
    }
  };
}

/** Pick the most informative failure text: trimmed stderr, else the spawn error, else a synthesized exit-status message. */
function failureMessage(spec: OpenClawCommandSpec, exit: ProcessExit, spawnError: Error | undefined, stderr: string): string {
  return stderr.trim() || spawnError?.message ||
    `${spec.command} exited with ${exit.code ?? exit.signal ?? "an unknown status"}`;
}

/** Serialize a usage frame to its canonical payload JSON, used to suppress emitting a duplicate usage.update. */
function usageKey(frame: { inputTokens: number; outputTokens: number; provider?: string; model?: string }): string {
  return JSON.stringify(usagePayload(frame));
}

/**
 * Run one OpenClaw subprocess and stream canonical events.
 *
 * OpenClaw emits incremental JSON frames, then a trailing "final blob" (which
 * may span several lines and is reassembled here). Reconciliation quirks:
 * - the final blob's text is authoritative, so only its suffix beyond the
 *   already-streamed text is emitted, avoiding duplicated output;
 * - usage is emitted once, de-duplicated against the last streamed usage;
 * - abort/failure is decided after the stream closes so the exit code, an
 *   explicit cancel/failure frame and the abort signal are all considered,
 *   yielding exactly one run.stopped / run.error / run.finished terminal.
 */
async function* invokeOpenClaw(
  req: InvokeRequest,
  spec: OpenClawCommandSpec,
  context?: AdapterInvocationContext
): AsyncGenerator<CanonicalEvent> {
  yield sessionEvent(spec.providerSessionId, spec.providerAgentId);
  yield { type: "message.create", payload: { role: "assistant", status: "streaming", channel: "final" } };

  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ["ignore", "pipe", "pipe"],
    signal: req.signal
  });
  child.once("spawn", () => {
    // With an argv/message-file CLI there is no request response. Successful
    // spawn is the strongest available dispatch-written boundary; it does not
    // prove that OpenClaw opened or parsed the message file.
    void context?.observe({
      event: "provider.dispatch.written",
      rpcMethod: "process.argv",
      providerSessionId: spec.providerSessionId,
      data: { pid: child.pid ?? null }
    });
  });
  let spawnError: Error | undefined;
  const exitPromise = new Promise<ProcessExit>(resolve => {
    child.once("error", error => { spawnError = error; });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-STDERR_LIMIT); });

  let accumulatedText = "";
  let finalFrame: OpenClawFinalFrame | null = null;
  let failure: string | undefined;
  let cancelled: string | undefined;
  let blobLines: string[] = [];
  let lastUsage: string | undefined;
  let reportedSessionId = spec.providerSessionId;
  let firstOutput = true;

  for await (const line of createInterface({ input: child.stdout })) {
    if (firstOutput) {
      firstOutput = false;
      // Observe native stdout before parsing so diagnostic or final-blob lines
      // still establish that the provider process produced output.
      void context?.observe({
        event: "provider.output.first",
        rpcMethod: "process.stdout",
        providerSessionId: reportedSessionId
      });
    }
    const frame = tryParseOpenClawEvent(line);
    if (!frame) {
      // A non-event line may be the final blob: either a compact single line, or a multi-line object we accumulate until it parses.
      const compactFinal = tryParseOpenClawFinalBlob(line);
      if (compactFinal) finalFrame = compactFinal;
      else if (blobLines.length > 0 || line.trim() === "{") {
        blobLines.push(line);
        const completedBlob = tryParseOpenClawFinalBlob(blobLines.join("\n"));
        if (completedBlob) {
          finalFrame = completedBlob;
          blobLines = [];
        }
      }
      continue;
    }
    if (frame.kind === "failure") { failure ??= frame.message; continue; }
    if (frame.kind === "cancelled") { cancelled ??= frame.message; continue; }
    if (frame.kind === "text") {
      accumulatedText += frame.text;
      if (frame.sessionId && frame.sessionId !== reportedSessionId) {
        reportedSessionId = frame.sessionId;
        yield sessionEvent(frame.sessionId, spec.providerAgentId);
      }
    }
    if (frame.kind === "usage") lastUsage = usageKey(frame);
    for (const event of normalizeOpenClawFrame(frame)) yield event;
  }

  const exit = await exitPromise;
  if (!finalFrame && blobLines.length > 0) finalFrame = tryParseOpenClawFinalBlob(blobLines.join("\n"));
  if (finalFrame?.sessionId && finalFrame.sessionId !== reportedSessionId) {
    yield sessionEvent(finalFrame.sessionId, spec.providerAgentId);
  }
  if (finalFrame?.text) {
    // The final blob text is authoritative; emit only the suffix beyond what was already streamed so text is not duplicated.
    if (finalFrame.text.startsWith(accumulatedText)) {
      const suffix = finalFrame.text.slice(accumulatedText.length);
      if (suffix) yield { type: "message.delta", payload: { text: suffix, channel: "final" } };
    }
    accumulatedText = finalFrame.text;
  }
  if (finalFrame && (finalFrame.inputTokens > 0 || finalFrame.outputTokens > 0)) {
    const key = usageKey(finalFrame);
    if (key !== lastUsage) yield { type: "usage.update", payload: usagePayload(finalFrame) };
  }

  if (req.signal?.aborted || cancelled || finalFrame?.aborted) {
    yield { type: "message.update", payload: { role: "assistant", status: "stopped", text: accumulatedText, channel: "final" } };
    yield { type: "run.stopped", payload: { reason: String(req.signal?.reason ?? cancelled ?? "openclaw_aborted") } };
    return;
  }
  if (failure || spawnError || exit.code !== 0) {
    const message = failure ?? failureMessage(spec, exit, spawnError, stderr);
    yield { type: "message.update", payload: { role: "assistant", status: "failed", text: accumulatedText, channel: "final" } };
    yield { type: "run.error", payload: { message, adapterType: "openclaw", exit } };
    return;
  }
  yield { type: "message.update", payload: { role: "assistant", status: "completed", text: accumulatedText, channel: "final" } };
  yield { type: "run.finished", payload: {} };
}

/** Create an OpenClaw adapter that drives the local `openclaw agent` CLI; each invocation is an isolated subprocess with its own message file. */
export function createOpenClawAdapter({ command = "openclaw", commandArgsPrefix = [], env = {} }: { command?: string; commandArgsPrefix?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  return defineAdapter({
    metadata: {
      type: "openclaw",
      processModel: "subprocess-per-invocation",
      transport: "stdio-json",
      capabilities: ["session.serialize", "tool.canonical"]
    },
    probe: () => probeCommand(command, { env: { ...process.env, ...env } }),
    async *invoke(req: InvokeRequest, context?: AdapterInvocationContext): AsyncGenerator<CanonicalEvent> {
      const spec = await buildOpenClawCommand(req, command, commandArgsPrefix, env);
      try {
        // Capture must complete before spawn: strict mode must never dispatch
        // provider-visible input for which no durable evaluation record exists.
        await context?.observe({
          event: "provider.input",
          rpcMethod: "process.argv",
          providerSessionId: spec.providerSessionId,
          carrier: spec.providerInput
        });
        yield* invokeOpenClaw(req, spec, context);
      }
      catch (error) {
        void context?.observe({
          event: "provider.dispatch.failed",
          rpcMethod: "process.argv",
          providerSessionId: spec.providerSessionId,
          data: { error: error instanceof Error ? error.message : String(error) }
        });
        throw error;
      }
      finally { await spec.cleanup(); }
    }
  });
}

export {
  normalizeOpenClawFrame,
  tryParseOpenClawEvent,
  tryParseOpenClawFinalBlob
} from "./parser.js";

export const openclawAdapter = createOpenClawAdapter();
export default openclawAdapter;

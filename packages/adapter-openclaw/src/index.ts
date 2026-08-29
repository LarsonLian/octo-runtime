import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defineAdapter, probeCommand, type CanonicalEvent, type InvokeRequest } from "@orbtex-ai/adapter-sdk";
import {
  normalizeOpenClawFrame,
  tryParseOpenClawEvent,
  tryParseOpenClawFinalBlob,
  usagePayload,
  type OpenClawFinalFrame
} from "./parser.js";

const STDERR_LIMIT = 64 * 1024;

interface OpenClawCommandSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  providerSessionId: string;
  providerAgentId?: string;
  messageFile: string;
  cleanup: () => Promise<void>;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function composeOpenClawPrompt(req: InvokeRequest): string {
  if (!req.appendInstructions) return req.prompt;
  return `[Harness Instructions]\n${req.appendInstructions}\n\n[User Request]\n${req.prompt}`;
}

async function existingDirectory(candidates: Array<string | undefined>): Promise<string> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { await access(candidate); return candidate; } catch {
      // 候选路径不存在时继续尝试，最终回退到当前目录。
    }
  }
  return process.cwd();
}

export async function buildOpenClawCommand(
  req: InvokeRequest,
  command = "openclaw",
  commandArgsPrefix: string[] = [],
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<OpenClawCommandSpec> {
  const directory = await mkdtemp(join(tmpdir(), "orbtex-openclaw-message-"));
  await chmod(directory, 0o700).catch(() => {});
  const messageFile = join(directory, "message.txt");
  await writeFile(messageFile, composeOpenClawPrompt(req), { encoding: "utf8", mode: 0o600 });
  await chmod(messageFile, 0o600).catch(() => {});

  const providerSessionId = req.providerSession?.sessionId ?? `orbtex-${randomUUID()}`;
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
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

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

function failureMessage(spec: OpenClawCommandSpec, exit: ProcessExit, spawnError: Error | undefined, stderr: string): string {
  return stderr.trim() || spawnError?.message ||
    `${spec.command} exited with ${exit.code ?? exit.signal ?? "an unknown status"}`;
}

function usageKey(frame: { inputTokens: number; outputTokens: number; provider?: string; model?: string }): string {
  return JSON.stringify(usagePayload(frame));
}

async function* invokeOpenClaw(req: InvokeRequest, spec: OpenClawCommandSpec): AsyncGenerator<CanonicalEvent> {
  yield sessionEvent(spec.providerSessionId, spec.providerAgentId);
  yield { type: "message.create", payload: { role: "assistant", status: "streaming", channel: "final" } };

  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ["ignore", "pipe", "pipe"],
    signal: req.signal
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

  for await (const line of createInterface({ input: child.stdout })) {
    const frame = tryParseOpenClawEvent(line);
    if (!frame) {
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

export function createOpenClawAdapter({ command = "openclaw", commandArgsPrefix = [], env = {} }: { command?: string; commandArgsPrefix?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  return defineAdapter({
    metadata: {
      type: "openclaw",
      processModel: "subprocess-per-invocation",
      transport: "stdio-json",
      capabilities: ["session.serialize", "tool.canonical"]
    },
    probe: () => probeCommand(command, { env: { ...process.env, ...env } }),
    async *invoke(req: InvokeRequest): AsyncGenerator<CanonicalEvent> {
      const spec = await buildOpenClawCommand(req, command, commandArgsPrefix, env);
      try { yield* invokeOpenClaw(req, spec); }
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

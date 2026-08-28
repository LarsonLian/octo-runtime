import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defineAdapter, probeCommand } from "@orbtex-ai/adapter-sdk";
import {
  normalizeOpenClawFrame,
  tryParseOpenClawEvent,
  tryParseOpenClawFinalBlob,
  usagePayload
} from "./parser.js";

const STDERR_LIMIT = 64 * 1024;

export function composeOpenClawPrompt(req) {
  if (!req.appendInstructions) return req.prompt;
  return `[Harness Instructions]\n${req.appendInstructions}\n\n[User Request]\n${req.prompt}`;
}

async function existingDirectory(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try { await access(candidate); return candidate; } catch {}
  }
  return process.cwd();
}

export async function buildOpenClawCommand(req, command = "openclaw", commandArgsPrefix = [], extraEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), "orbtex-openclaw-message-"));
  await chmod(directory, 0o700).catch(() => {});
  const messageFile = join(directory, "message.txt");
  await writeFile(messageFile, composeOpenClawPrompt(req), { encoding: "utf8", mode: 0o600 });
  await chmod(messageFile, 0o600).catch(() => {});

  const providerSessionId = req.providerSession?.sessionId ?? `orbtex-${randomUUID()}`;
  const providerAgentId = req.agentConfig?.providerAgentId ??
    req.agentConfig?.providerOptions?.OPENCLAW_AGENT_ID;
  const args = [...commandArgsPrefix, "agent", "--local", "--json", "--session-id", providerSessionId];
  if (providerAgentId) args.push("--agent", providerAgentId);
  if (req.agentConfig?.model) args.push("--model", req.agentConfig.model);
  if (req.agentConfig?.thinking) args.push("--thinking", req.agentConfig.thinking);
  if (Number.isFinite(req.agentConfig?.timeoutSeconds) && req.agentConfig.timeoutSeconds > 0) {
    args.push("--timeout", String(req.agentConfig.timeoutSeconds));
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

function sessionEvent(sessionId, providerAgentId) {
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

function failureMessage(spec, exit, spawnError, stderr) {
  return stderr.trim() || spawnError?.message ||
    `${spec.command} exited with ${exit.code ?? exit.signal ?? "an unknown status"}`;
}

function usageKey(frame) {
  return JSON.stringify(usagePayload(frame));
}

async function* invokeOpenClaw(req, spec) {
  yield sessionEvent(spec.providerSessionId, spec.providerAgentId);
  yield { type: "message.create", payload: { role: "assistant", status: "streaming", channel: "final" } };

  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ["ignore", "pipe", "pipe"],
    signal: req.signal
  });
  let spawnError;
  const exitPromise = new Promise(resolve => {
    child.once("error", error => { spawnError = error; });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-STDERR_LIMIT); });

  let accumulatedText = "";
  let finalFrame;
  let failure;
  let cancelled;
  let blobLines = [];
  let lastUsage;
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
    reportedSessionId = finalFrame.sessionId;
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

export function createOpenClawAdapter({ command = "openclaw", commandArgsPrefix = [], env = {} } = {}) {
  return defineAdapter({
    metadata: {
      type: "openclaw",
      processModel: "subprocess-per-invocation",
      transport: "stdio-json",
      capabilities: ["session.serialize", "tool.canonical"]
    },
    probe: () => probeCommand(command, { env: { ...process.env, ...env } }),
    async *invoke(req) {
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

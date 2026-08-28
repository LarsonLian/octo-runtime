import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { isTerminal } from "@orbtex-ai/protocol";

export function defineAdapter(adapter) {
  if (!adapter?.metadata?.type || typeof adapter.invoke !== "function") {
    throw new TypeError("adapter requires metadata.type and invoke(req)");
  }
  return Object.freeze(adapter);
}

export async function* spawnJsonLines({ command, args, cwd, env, input, signal, parseLine }) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    signal
  });
  const exitPromise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  if (input !== undefined) child.stdin.end(input); else child.stdin.end();

  for await (const line of createInterface({ input: child.stdout })) {
    const event = parseLine(line);
    if (event) yield event;
  }

  const exit = await exitPromise;
  if (exit.code !== 0) {
    const error = new Error(stderr.trim() || `${command} exited with ${exit.code ?? exit.signal}`);
    error.exit = exit;
    throw error;
  }
}

export function parseJsonLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

export function createJsonCliAdapter({ metadata, buildCommand, normalize, probe, onSuccess }) {
  return defineAdapter({
    metadata,
    ...(probe ? { probe } : {}),
    async *invoke(req) {
      const spec = await buildCommand(req);
      let terminal = false;
      try {
        yield { type: "message.create", payload: { role: "assistant", status: "streaming" } };
        for await (const native of spawnJsonLines({
          ...spec,
          cwd: req.workdir,
          signal: req.signal,
          parseLine: parseJsonLine
        })) {
          for (const event of normalize(native, req) ?? []) {
            terminal ||= isTerminal(event);
            yield event;
          }
        }
        if (!terminal) for (const event of onSuccess?.(req) ?? []) yield event;
      } finally { await spec.cleanup?.(); }
    }
  });
}

export async function probeCommand(command, { env = process.env } = {}) {
  const candidates = command.includes("/") ? [command] : (env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").map(dir => `${dir}/${command}`);
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return { available: true, command: candidate }; } catch {}
  }
  return { available: false, command, reason: "command_not_found" };
}

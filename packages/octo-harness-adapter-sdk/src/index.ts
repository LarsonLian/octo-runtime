import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import {
  isTerminal,
  type CanonicalEvent,
  type InvokeRequest
} from "@mininglamp-oss/octo-harness-protocol";

export type {
  CanonicalEvent,
  InvokeRequest,
  MessageExposure,
  MessageProvenance
} from "@mininglamp-oss/octo-harness-protocol";
export { providerInputText } from "@mininglamp-oss/octo-harness-protocol";

export interface AdapterMetadata {
  type: string;
  capabilities: string[];
  processModel?: string;
  transport?: string;
}

export interface ProbeResult {
  available: boolean;
  command: string;
  reason?: string;
}

export interface Adapter {
  metadata: AdapterMetadata;
  probe?: () => Promise<ProbeResult>;
  invoke(request: InvokeRequest): AsyncIterable<CanonicalEvent>;
}

export interface CommandSpec {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  cleanup?: () => void | Promise<void>;
}

export interface JsonCliAdapterOptions<TNative> {
  metadata: AdapterMetadata;
  buildCommand: (request: InvokeRequest) => CommandSpec | Promise<CommandSpec>;
  normalize: (event: TNative, request: InvokeRequest) => CanonicalEvent[] | undefined;
  probe?: () => Promise<ProbeResult>;
  onSuccess?: (request: InvokeRequest) => CanonicalEvent[];
}

interface SpawnJsonLinesOptions<TNative> extends CommandSpec {
  signal?: AbortSignal;
  parseLine: (line: string) => TNative | null;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function defineAdapter<TAdapter extends Adapter>(adapter: TAdapter): Readonly<TAdapter> {
  if (!adapter?.metadata?.type || typeof adapter.invoke !== "function") {
    throw new TypeError("adapter requires metadata.type and invoke(req)");
  }
  return Object.freeze(adapter);
}

export async function* spawnJsonLines<TNative>(options: SpawnJsonLinesOptions<TNative>): AsyncGenerator<TNative> {
  const { command, args = [], cwd, env, input, signal, parseLine } = options;
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    signal
  });
  const exitPromise = new Promise<ProcessExit>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string | Buffer) => {
    stderr += chunk.toString();
  });
  child.stdin.end(input);

  // 每行只承载一个 provider 原生事件；解析失败由具体 adapter 决定是否忽略。
  for await (const line of createInterface({ input: child.stdout })) {
    const event = parseLine(line);
    if (event !== null) yield event;
  }

  const exit = await exitPromise;
  if (exit.code !== 0) {
    throw new ProviderProcessError(
      stderr.trim() || `${command} exited with ${exit.code ?? exit.signal}`,
      exit
    );
  }
}

export class ProviderProcessError extends Error {
  constructor(message: string, readonly exit: ProcessExit) {
    super(message);
    this.name = "ProviderProcessError";
  }
}

export function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function createJsonCliAdapter<TNative = Record<string, unknown>>(
  options: JsonCliAdapterOptions<TNative>
): Readonly<Adapter> {
  const { metadata, buildCommand, normalize, probe, onSuccess } = options;
  return defineAdapter({
    metadata,
    ...(probe ? { probe } : {}),
    async *invoke(request: InvokeRequest): AsyncGenerator<CanonicalEvent> {
      const spec = await buildCommand(request);
      let terminal = false;
      try {
        yield { type: "message.create", payload: { role: "assistant", status: "streaming" } };
        for await (const native of spawnJsonLines({
          ...spec,
          cwd: spec.cwd ?? request.workdir,
          signal: request.signal,
          parseLine: parseJsonLine as (line: string) => TNative | null
        })) {
          for (const event of normalize(native, request) ?? []) {
            terminal ||= isTerminal(event);
            yield event;
          }
        }
        if (!terminal) {
          for (const event of onSuccess?.(request) ?? []) yield event;
        }
      } finally {
        await spec.cleanup?.();
      }
    }
  });
}

export async function probeCommand(command: string, { env = process.env }: { env?: NodeJS.ProcessEnv } = {}): Promise<ProbeResult> {
  const candidates = command.includes("/")
    ? [command]
    : (env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").map(directory => `${directory}/${command}`);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return { available: true, command: candidate };
    } catch {
      // 当前候选不可执行，继续搜索 PATH 中的下一个目录。
    }
  }
  return { available: false, command, reason: "command_not_found" };
}

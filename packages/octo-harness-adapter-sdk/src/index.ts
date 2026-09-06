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
export { freshFallbackInputText, providerInputText } from "@mininglamp-oss/octo-harness-protocol";

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

/**
 * Validate and freeze an adapter definition. Freezing makes the metadata and
 * `invoke` reference immutable so a loaded adapter cannot be mutated at runtime.
 */
export function defineAdapter<TAdapter extends Adapter>(adapter: TAdapter): Readonly<TAdapter> {
  if (!adapter?.metadata?.type || typeof adapter.invoke !== "function") {
    throw new TypeError("adapter requires metadata.type and invoke(req)");
  }
  return Object.freeze(adapter);
}

/**
 * Spawn a JSON-lines subprocess and yield one parsed native event per stdout
 * line. stderr is buffered and surfaced only if the process exits non-zero (as
 * `ProviderProcessError`); the `signal` aborts the child. Stdout is drained to
 * completion before the exit code is awaited so no trailing events are lost.
 */
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

  // One provider-native event per line; whether a parse failure is ignored is
  // left to the specific adapter's parseLine.
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

/** Raised when a provider subprocess exits non-zero; carries the exit code/signal alongside the captured stderr message. */
export class ProviderProcessError extends Error {
  constructor(message: string, readonly exit: ProcessExit) {
    super(message);
    this.name = "ProviderProcessError";
  }
}

/** Parse a line as a JSON object, returning null on invalid JSON or a non-object (array/scalar) so callers can skip noise lines. */
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

/**
 * Build a stdout-JSON-lines CLI adapter from a per-provider spec. It handles the
 * lifecycle shared by every such adapter: emit an opening `message.create`,
 * normalize each native line into canonical events, and — if the provider never
 * produced a terminal event — synthesize the `onSuccess` events. `cleanup` runs
 * in a `finally` so it fires on cancellation and error paths too.
 */
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

/**
 * Resolve whether a command is runnable. A path-qualified command is checked
 * directly; a bare name is searched across `PATH` (`;`-separated on Windows).
 * Returns the first executable match, else `command_not_found`.
 */
export async function probeCommand(command: string, { env = process.env }: { env?: NodeJS.ProcessEnv } = {}): Promise<ProbeResult> {
  const candidates = command.includes("/")
    ? [command]
    : (env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").map(directory => `${directory}/${command}`);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return { available: true, command: candidate };
    } catch {
      // Current candidate is not executable; keep scanning the next PATH entry.
    }
  }
  return { available: false, command, reason: "command_not_found" };
}

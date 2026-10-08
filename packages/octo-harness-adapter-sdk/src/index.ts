import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { delimiter, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { sanitizePublicValue } from "./public-display.js";
import {
  isTerminal,
  type CanonicalEvent,
  type InvokeRequest
} from "@mininglamp-oss/octo-harness-protocol";
import type {
  AdapterInvocationContext,
  ProviderCarrier,
  ProviderObservation
} from "@mininglamp-oss/octo-harness-observability";

export type {
  CanonicalEvent,
  InvokeRequest,
  MessageChannel,
  MessageExposure,
  MessageProvenance
} from "@mininglamp-oss/octo-harness-protocol";
export type {
  AdapterInvocationContext,
  CaptureReceipt,
  ProviderCarrier,
  ProviderObservation
} from "@mininglamp-oss/octo-harness-observability";
export { freshFallbackInputText, providerInputText, providerInputParts, hasImageInput } from "@mininglamp-oss/octo-harness-protocol";
export { AcpApprovalBridge } from "./approval.js";
export { sanitizePublicValue } from "./public-display.js";
export { acpToolTerminalStatus, normalizeAcpToolUpdate } from "./acp-tool.js";

export interface AdapterMetadata {
  type: string;
  capabilities: string[];
  processModel?: string;
  transport?: string;
}

export interface ProbeResult {
  available: boolean;
  command: string;
  version?: string | null;
  reason?: string;
}

export interface Adapter {
  metadata: AdapterMetadata;
  probe?: () => Promise<ProbeResult>;
  /**
   * Execute one provider turn.
   *
   * `context` is optional so adapters built against the original SDK contract
   * remain loadable. New adapters should report provider I/O through it, but
   * must not use observability as a source of invocation identity or control
   * flow. The host attaches Run/session correlation outside the plugin boundary.
   */
  invoke(request: InvokeRequest, context?: AdapterInvocationContext): AsyncIterable<CanonicalEvent>;
}

/** The fully materialized subprocess contract produced immediately before spawn. */
export interface CommandSpec {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  cleanup?: () => void | Promise<void>;
  /**
   * Exact logical carrier presented to the provider after all adapter-specific
   * prompt, configuration, argv, and stdin transformations have been applied.
   * When omitted, the generic helper derives a carrier from this command spec.
   */
  providerInput?: ProviderCarrier;
  /** Stable transport operation name used to group provider observations. */
  rpcMethod?: string;
  /** Opaque provider-owned session identifier, when known before dispatch. */
  providerSessionId?: string;
}

export interface JsonCliAdapterOptions<TNative> {
  metadata: AdapterMetadata;
  buildCommand: (request: InvokeRequest) => CommandSpec | Promise<CommandSpec>;
  normalize: (event: TNative, request: InvokeRequest) => CanonicalEvent[] | undefined;
  probe?: () => Promise<ProbeResult>;
  onSuccess?: (request: InvokeRequest) => CanonicalEvent[];
}

/** Low-cardinality provider metadata that is safe to retain beside public output. */
export interface ProviderOutputMetadata {
  type?: string;
  subtype?: string;
  provider?: string;
  model?: string;
}

/**
 * A provider-native-shaped projection built exclusively from canonical fields
 * that the adapter already classified as public. It deliberately has no
 * catch-all envelope field, so prompt carriers and co-located private reasoning
 * cannot cross the adapter boundary by accident.
 */
export interface ProviderPublicOutputProjection {
  kind: "message" | "tool" | "usage" | "error";
  type: string;
  content: Record<string, unknown>;
}

export interface ObserveProviderOutputOptions {
  rpcMethod: string;
  providerSessionId?: string;
  providerRequestId?: string;
  native?: ProviderOutputMetadata;
}

interface SpawnJsonLinesOptions<TNative> extends CommandSpec {
  signal?: AbortSignal;
  parseLine: (line: string) => TNative | null;
  /** Called only after Node accepts the complete stdin payload for writing. */
  onInputWritten?: () => void;
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
 * Submit a non-critical observation without allowing logging availability to
 * alter provider execution. Strict provider input must continue to call and
 * await `context.observe` directly; every other milestone uses this helper so a
 * logger closed during shutdown cannot create an unhandled rejection.
 */
export function observeBestEffort(
  context: AdapterInvocationContext | undefined,
  observation: ProviderObservation
): void {
  if (!context) return;
  void context.observe(observation).catch(() => undefined);
}

/**
 * Capture only provider output that the canonical privacy contract classifies
 * as public. Raw provider envelopes are intentionally excluded because they may
 * echo prompts or co-locate private reasoning with public content. The optional
 * native projection is restricted to bounded type/provider/model labels.
 */
export function observeProviderOutput(
  context: AdapterInvocationContext | undefined,
  events: readonly CanonicalEvent[],
  options: ObserveProviderOutputOptions
): void {
  const canonical = events
    .filter(isAllowedProviderOutput)
    .map(sanitizeCanonicalProviderOutput);
  if (canonical.length === 0) return;
  const native = sanitizeProviderOutputMetadata(options.native);
  const publicOutput = canonical.map(projectPublicProviderOutput);
  observeBestEffort(context, {
    event: "provider.output",
    rpcMethod: options.rpcMethod,
    ...(options.providerSessionId ? { providerSessionId: options.providerSessionId } : {}),
    ...(options.providerRequestId ? { providerRequestId: options.providerRequestId } : {}),
    data: {
      native: { ...native, public: publicOutput },
      canonical
    }
  });
}

function isAllowedProviderOutput(event: CanonicalEvent): boolean {
  if (event.type.startsWith("tool_call.")) return true;
  if (event.type === "usage.update" || event.type === "run.failed") return true;
  if (!event.type.startsWith("message.")) return false;
  if (event.payload.channel !== "analysis") return true;
  return event.payload.exposure === "public_reasoning"
    || event.payload.exposure === "public_summary"
    || event.payload.exposure === "public_plan";
}

function sanitizeProviderOutputMetadata(metadata: ProviderOutputMetadata | undefined): ProviderOutputMetadata {
  if (!metadata) return {};
  const output: ProviderOutputMetadata = {};
  for (const key of ["type", "subtype", "provider", "model"] as const) {
    const value = metadata[key];
    if (typeof value === "string" && value.length > 0) output[key] = value.slice(0, 256);
  }
  return output;
}

/** Clone and redact the selected public event before handing it to a sink. */
function sanitizeCanonicalProviderOutput(event: CanonicalEvent): CanonicalEvent {
  return sanitizePublicValue(event) as CanonicalEvent;
}

/**
 * Convert a canonical provider event back into a small native-shaped record for
 * evaluation tooling. Only explicitly enumerated public fields are selected;
 * the original provider frame is never accepted by this function.
 */
function projectPublicProviderOutput(event: CanonicalEvent): ProviderPublicOutputProjection {
  const payload = event.payload as Record<string, unknown>;
  if (event.type.startsWith("message.")) {
    return {
      kind: "message",
      type: event.type,
      content: selectPublicFields(payload, ["messageId", "role", "status", "channel", "exposure", "text"])
    };
  }
  if (event.type.startsWith("tool_call.")) {
    return {
      kind: "tool",
      type: event.type,
      content: selectPublicFields(payload, ["id", "name", "status", "args", "argsDelta", "output", "error"])
    };
  }
  if (event.type === "usage.update") {
    return { kind: "usage", type: event.type, content: { ...payload } };
  }
  return {
    kind: "error",
    type: event.type,
    content: selectPublicFields(payload, ["adapterType", "code", "message"])
  };
}

function selectPublicFields(
  source: Record<string, unknown>,
  fields: readonly string[]
): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const field of fields) {
    if (source[field] !== undefined) selected[field] = source[field];
  }
  return selected;
}

/**
 * Spawn a JSON-lines subprocess and yield one parsed native event per stdout
 * line. stderr is buffered and surfaced only if the process exits non-zero (as
 * `ProviderProcessError`); the `signal` aborts the child. Stdout is drained to
 * completion before the exit code is awaited so no trailing events are lost.
 *
 * `onInputWritten` observes the stdin stream callback. It means the carrier was
 * accepted by Node's writable stream, not that the provider parsed or accepted
 * the request; transports with a response protocol must report acknowledgement
 * separately.
 */
export async function* spawnJsonLines<TNative>(options: SpawnJsonLinesOptions<TNative>): AsyncGenerator<TNative> {
  const { command, args = [], cwd, env, input, signal, parseLine, onInputWritten } = options;
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });
  const exitPromise = new Promise<ProcessExit>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
  });
  let killTimer: NodeJS.Timeout | undefined;
  const abort = (): void => {
    signalProcessTree(child, "SIGTERM");
    killTimer ??= setTimeout(() => {
      if (child.exitCode === null) signalProcessTree(child, "SIGKILL");
    }, 1_000);
    killTimer.unref();
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string | Buffer) => {
    stderr += chunk.toString();
  });
  // Use the completion callback rather than observing before end(): the latter
  // would incorrectly classify a synchronous write failure as dispatched.
  child.stdin.end(input, onInputWritten);

  let exited = false;
  try {
    // One provider-native event per line; whether a parse failure is ignored is
    // left to the specific adapter's parseLine.
    for await (const line of createInterface({ input: child.stdout })) {
      const event = parseLine(line);
      if (event !== null) yield event;
    }

    const exit = await exitPromise;
    exited = true;
    if (exit.code !== 0) {
      throw new ProviderProcessError(
        stderr.trim() || `${command} exited with ${exit.code ?? exit.signal}`,
        exit
      );
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!exited && child.exitCode === null) {
      abort();
      await Promise.race([
        exitPromise.catch(() => undefined),
        new Promise<void>(resolve => setTimeout(resolve, 1_000))
      ]);
      if (child.exitCode === null) signalProcessTree(child, "SIGKILL");
    }
    if (killTimer) clearTimeout(killTimer);
  }
}

function signalProcessTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals
): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  child.kill(signal);
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
 *
 * Observation ordering is intentional: `provider.input` is awaited before the
 * subprocess is spawned, allowing require-capture mode to fail closed. The
 * write and first-output observations are best-effort timing markers and never
 * delay the provider stream.
 */
export function createJsonCliAdapter<TNative = Record<string, unknown>>(
  options: JsonCliAdapterOptions<TNative>
): Readonly<Adapter> {
  const { metadata, buildCommand, normalize, probe, onSuccess } = options;
  return defineAdapter({
    metadata,
    ...(probe ? { probe } : {}),
    async *invoke(request: InvokeRequest, context?: AdapterInvocationContext): AsyncGenerator<CanonicalEvent> {
      const spec = await buildCommand(request);
      let terminal = false;
      let firstOutput = true;
      try {
        // Capture the final provider-visible carrier before starting a process.
        // In strict mode this await is the durability barrier for model input.
        await context?.observe({
          event: "provider.input",
          rpcMethod: spec.rpcMethod ?? "process.spawn",
          ...(spec.providerSessionId ? { providerSessionId: spec.providerSessionId } : {}),
          carrier: spec.providerInput ?? {
            kind: "json_params",
            content: {
              command: spec.command,
              args: spec.args ?? [],
              cwd: spec.cwd ?? request.workdir,
              env: spec.env ?? {},
              input: spec.input ?? ""
            }
          }
        });
        yield { protocolVersion: 2, type: "message.create", payload: { role: "assistant", status: "streaming" } };
        for await (const native of spawnJsonLines({
          ...spec,
          cwd: spec.cwd ?? request.workdir,
          signal: request.signal,
          onInputWritten: () => {
            // A stream write is a transport milestone, not provider acceptance.
            observeBestEffort(context, {
              event: "provider.dispatch.written",
              rpcMethod: spec.rpcMethod ?? "process.stdin",
              ...(spec.providerSessionId ? { providerSessionId: spec.providerSessionId } : {})
            });
          },
          parseLine: parseJsonLine as (line: string) => TNative | null
        })) {
          if (firstOutput) {
            firstOutput = false;
            // The first native stdout record proves that the provider started
            // producing a response, even for records the normalizer discards.
            observeBestEffort(context, {
              event: "provider.output.first",
              rpcMethod: spec.rpcMethod ?? "process.stdout",
              ...(spec.providerSessionId ? { providerSessionId: spec.providerSessionId } : {})
            });
          }
          const events = normalize(native, request) ?? [];
          observeProviderOutput(context, events, {
            rpcMethod: spec.rpcMethod ?? "process.stdout",
            ...(spec.providerSessionId ? { providerSessionId: spec.providerSessionId } : {}),
            native: providerOutputMetadata(native)
          });
          for (const event of events) {
            terminal ||= isTerminal(event);
            yield event;
          }
          // A provider-native semantic terminal is authoritative. Stop reading
          // here so the subprocess generator enters its cleanup path even when
          // the CLI leaves watchers or other handles alive after completing.
          if (terminal) break;
        }
        if (!terminal) {
          const events = onSuccess?.(request) ?? [];
          observeProviderOutput(context, events, {
            rpcMethod: spec.rpcMethod ?? "process.exit",
            ...(spec.providerSessionId ? { providerSessionId: spec.providerSessionId } : {}),
            native: { type: "process.exit" }
          });
          for (const event of events) yield event;
        }
      } catch (error) {
        observeBestEffort(context, {
          event: "provider.dispatch.failed",
          rpcMethod: spec.rpcMethod ?? "process.spawn",
          ...(spec.providerSessionId ? { providerSessionId: spec.providerSessionId } : {}),
          data: { error: error instanceof Error ? error.message : String(error) }
        });
        throw error;
      } finally {
        await spec.cleanup?.();
      }
    }
  });
}

/** Extract only low-cardinality labels from an otherwise untrusted native frame. */
function providerOutputMetadata(value: unknown): ProviderOutputMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const part = record.part !== null && typeof record.part === "object" && !Array.isArray(record.part)
    ? record.part as Record<string, unknown>
    : undefined;
  return {
    ...(typeof record.type === "string" ? { type: record.type } : {}),
    ...(typeof part?.type === "string" ? { subtype: part.type } : {}),
    ...(typeof record.provider === "string" ? { provider: record.provider } : {}),
    ...(typeof record.model === "string" ? { model: record.model } : {})
  };
}

/**
 * Resolve whether a command is runnable. A path-qualified command is checked
 * directly; a bare name is searched across `PATH` (`;`-separated on Windows).
 * Returns the first executable match, else `command_not_found`.
 */
export async function probeCommand(command: string, { env = process.env }: { env?: NodeJS.ProcessEnv } = {}): Promise<ProbeResult> {
  const candidates = isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? [command]
    : (env.PATH ?? "").split(delimiter).flatMap(directory => {
        const extensions = process.platform === "win32" && !/\.[^\\/]+$/.test(command)
          ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")]
          : [""];
        return extensions.map(extension => resolve(directory, command + extension));
      });
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      let version: string | null = null;
      try {
        const { stdout } = await promisify(execFile)(resolve(candidate), ["--version"], {
          env, timeout: 2_000, maxBuffer: 4096, windowsHide: true
        });
        const output = stdout.trim();
        // Keep a version label, not arbitrary CLI banners or diagnostics.
        version = output.match(/(?:^|\s)v?(\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?)(?=\s|$)/)?.[1] ?? null;
      } catch {
        // Executable availability does not imply support for --version.
      }
      return { available: true, command: resolve(candidate), version };
    } catch {
      // Current candidate is not executable; keep scanning the next PATH entry.
    }
  }
  return { available: false, command, reason: "command_not_found" };
}

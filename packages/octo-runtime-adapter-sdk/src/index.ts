import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { AdapterInvocationContext } from "./activity.js";
import { invocationEnvironment } from "./environment.js";
import { createProcessCleanup } from "./process-cleanup.js";
import { watchLineLimit } from "./line-limit.js";
import { mapReasoningEffort, reasoningLevelMap, type ReasoningLevelMap } from "./reasoning.js";
export type { AdapterInvocationContext, ProviderActivity } from "./activity.js";
export { invocationEnvironment, invocationEnvs } from "./environment.js";
export { invocationMcpServers, expandMcpValue, assertMcpOptions } from "./mcp.js";
export { actmodeEvidence } from "./actmode.js";

import {
  DEFAULT_STREAM_LIMIT_POLICY,
  isTerminal,
  assertProtocolSupport,
  type CanonicalEvent,
  type AdapterProtocolSupport,
  type HostControl,
  type NativeHostFrame,
  type InvokeRequest,
  type StreamLimitPolicy
} from "@mininglamp-oss/octo-runtime-protocol";

export {
  freshFallbackInputText,
  initialControlInstructions,
  hasImageInput,
  providerInputParts,
  providerInputText
} from "@mininglamp-oss/octo-runtime-protocol";
export type {
  CanonicalEvent,
  InvokeRequest,
  MessageChannel,
  MessageExposure,
  MessageProvenance
} from "@mininglamp-oss/octo-runtime-protocol";
export { acpToolTerminalStatus, normalizeAcpToolUpdate } from "./acp-tool.js";
export { AcpTurnNormalizer } from "./acp-turn.js";
export { AcpApprovalBridge } from "./approval.js";
export { DriverQueue, NativeInteractionBridge } from "./native.js";
export { watchLineLimit } from "./line-limit.js";
export { readBoundedLines } from "./bounded-lines.js";
export { HourlyLogWriter, HOURLY_LOG_MAX_BYTES } from "./hourly-log.js";
export {
  RuntimeLogging,
  assertRuntimeLogging,
  noopRuntimeLog,
  type RuntimeLog,
  type RuntimeLogLevel,
  type RuntimeLoggingOptions
} from "./runtime-log.js";
export { sanitizePublicValue } from "./public-display.js";
export {
  DEFAULT_REASONING_LEVEL_MAPS,
  OMNI_REASONING_LEVELS,
  mapReasoningEffort,
  reasoningLevelMap,
  type OmniReasoningLevel,
  type ReasoningLevelMap
} from "./reasoning.js";

export interface AdapterMetadata {
  /** Local implementation support; not a remote runtime admission feature. */
  mcp?: boolean;
  /** False ignores octo.execution/workspace; the Provider owns its workspace. */
  workspace?: boolean;
  protocolSupport?: AdapterProtocolSupport;
  type: string;
  agentSources: ("preset" | "provisioned")[];
  processModel?: string;
  transport?: string;
}

/** Trusted local connection settings; never sourced from model Context. */
export interface AdapterProbeOptions {
  providerOptions?: Record<string, string>;
  streamLimits?: StreamLimitPolicy;
}

export interface ProbeResult {
  available: boolean;
  command: string;
  version?: string | null;
  reason?: string;
}

export interface Adapter<TOutput extends AdapterOutput = AdapterOutput> {
  metadata: AdapterMetadata;
  probe?: (options?: AdapterProbeOptions) => Promise<ProbeResult>;
  /** Execute one provider turn, optionally reporting watchdog progress. */
  invoke(request: InvokeRequest, context?: AdapterInvocationContext): AsyncIterable<TOutput>;
}

/** Provider objects and lifetime signals before the Host assigns stream identity. */
export type DriverFrame =
  | Pick<NativeHostFrame, "kind" | "messageKind" | "payload">
  | { kind: "control"; control: HostControl };
export type AdapterOutput = CanonicalEvent | DriverFrame;

/** The fully materialized subprocess contract produced immediately before spawn. */
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
  probe?: (options?: AdapterProbeOptions) => Promise<ProbeResult>;
  onSuccess?: (request: InvokeRequest) => CanonicalEvent[];
}

interface SpawnJsonLinesOptions<TNative> extends CommandSpec {
  signal?: AbortSignal;
  parseLine: (line: string) => TNative | null;
  /** Called only after Node accepts the complete stdin payload for writing. */
  onInputWritten?: () => void;
  /** Keep stdin open for provider reverse requests; writes are acknowledged. */
  controlHandler?: (event: TNative, write: (response: unknown) => Promise<void>) => Promise<void>;
  endInputWhen?: (event: TNative) => boolean;
  onSpawn?: (close: () => Promise<void>) => void;
  rawMessageMaxBytes?: number;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Validate and freeze an adapter definition. Freezing makes the metadata and
 * `invoke` reference immutable so a loaded adapter cannot be mutated at runtime.
 */
export function defineAdapter<TAdapter extends Adapter>(
  adapter: TAdapter,
  levels: ReasoningLevelMap | null = reasoningLevelMap(adapter.metadata.type)
): Readonly<TAdapter> {
  if (!adapter?.metadata?.type || typeof adapter.invoke !== "function") {
    throw new TypeError("adapter requires metadata.type and invoke(req)");
  }
  const invoke = adapter.invoke.bind(adapter);
  const protocolSupport: AdapterProtocolSupport = adapter.metadata.protocolSupport ?? {
    protocol: `${adapter.metadata.type}.canonical`,
    modes: ["canonical"],
    nativeMethods: []
  };
  return Object.freeze({
    ...adapter,
    metadata: {
      ...adapter.metadata,
      protocolSupport
    },
    async *invoke(
      request: InvokeRequest,
      context?: AdapterInvocationContext
    ): AsyncGenerator<AdapterOutput> {
      assertProtocolSupport(protocolSupport, {
        protocolMode: context?.protocolMode ?? "canonical"
      });
      const mcp = request.context.items.find(
        (item) => item.namespace === "octo.execution" && item.name === "mcp"
      );
      if (mcp && Object.keys(mcp.payload.mcpServers as object).length && !adapter.metadata.mcp)
        throw new Error(`MCP_UNSUPPORTED: ${adapter.metadata.type}`);
      const requested = request.agentConfig.effort;
      const native = mapReasoningEffort(adapter.metadata.type, requested, levels);
      if (requested !== undefined && context?.protocolMode !== "native") {
        if (native === undefined || native !== requested)
          yield {
            protocolVersion: 2 as const,
            type: "run.notice" as const,
            payload: {
              noticeId: `${request.invocationId}:reasoning`,
              code: "config_warning" as const,
              severity: native === undefined ? ("warning" as const) : ("info" as const),
              params: {
                warningCode:
                  native === undefined
                    ? "REASONING_EFFORT_NOT_APPLIED"
                    : "REASONING_EFFORT_DOWNGRADED"
              }
            }
          };
      }
      // Keep the original four-level request intact. Only native carriers map it.
      yield* invoke(request, context);
    }
  });
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
export async function* spawnJsonLines<TNative>(
  options: SpawnJsonLinesOptions<TNative>
): AsyncGenerator<TNative> {
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
  // Spawn may fail before stdout closes and the generator reaches its exit await.
  void exitPromise.catch(() => undefined);
  const cleanup = createProcessCleanup(child, { processGroup: process.platform !== "win32" });
  const abort = (): void => {
    // R06：清理不能在 leader exit 时取消升级；finally 必须等待同一结果。
    // .octospec/tasks/pr1-yujiawei-review/assessment.md
    void cleanup().catch(() => undefined);
  };
  child.once("exit", abort);
  options.onSpawn?.(cleanup);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string | Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-64 * 1024);
  });
  // Use the completion callback rather than observing before end(): the latter
  // would incorrectly classify a synchronous write failure as dispatched.
  let controlError: Error | undefined;
  const reader = createInterface({ input: child.stdout });
  const removeLineGuard = watchLineLimit(
    child.stdout,
    options.rawMessageMaxBytes ?? DEFAULT_STREAM_LIMIT_POLICY.rawMessageMaxBytes,
    (error) => {
      Object.assign(error, { boundary: "provider.stdout" });
      controlError ??= error;
      reader.close();
      child.stdout.destroy();
      abort();
    }
  );
  const handlers = new Set<Promise<void>>();
  child.stdin.on("error", (error) => {
    controlError ??= error;
    abort();
  });
  const write = (response: unknown): Promise<void> =>
    new Promise((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(response)}\n`, (error) =>
        error ? reject(error) : resolve()
      );
    });
  if (options.controlHandler) child.stdin.write(input ?? "", onInputWritten);
  else child.stdin.end(input, onInputWritten);

  try {
    // One provider-native event per line; whether a parse failure is ignored is
    // left to the specific adapter's parseLine.
    for await (const line of reader) {
      const event = parseLine(line);
      if (event !== null) {
        if (options.controlHandler) {
          const task = options.controlHandler(event, write).catch((error) => {
            controlError ??= error instanceof Error ? error : new Error(String(error));
            abort();
          });
          handlers.add(task);
          void task.finally(() => handlers.delete(task));
        }
        if (options.endInputWhen?.(event)) child.stdin.end();
        yield event;
      }
    }

    const exit = await exitPromise;
    if (controlError) throw controlError;
    if (exit.code !== 0) {
      throw new ProviderProcessError(
        stderr.trim() || `${command} exited with ${exit.code ?? exit.signal}`,
        exit
      );
    }
  } finally {
    reader.close();
    removeLineGuard();
    signal?.removeEventListener("abort", abort);
    // 正常 EOF 也要回收继承进程组、但已关闭 stdio 的后台后代。
    await cleanup();
  }
}

/** Raised when a provider subprocess exits non-zero; carries the exit code/signal alongside the captured stderr message. */
export class ProviderProcessError extends Error {
  constructor(
    message: string,
    readonly exit: ProcessExit
  ) {
    super(message);
    this.name = "ProviderProcessError";
  }
}

/** Parse a line as a JSON object, returning null on invalid JSON or a non-object (array/scalar) so callers can skip noise lines. */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
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
): Readonly<Adapter<CanonicalEvent>> {
  const { metadata, buildCommand, normalize, probe, onSuccess } = options;
  return defineAdapter({
    metadata,
    ...(probe ? { probe } : {}),
    async *invoke(
      request: InvokeRequest,
      context?: AdapterInvocationContext
    ): AsyncGenerator<CanonicalEvent> {
      const spec = await buildCommand(request);
      let terminal = false;
      try {
        yield {
          protocolVersion: 2,
          type: "message.create",
          payload: { role: "assistant", status: "streaming" }
        };
        for await (const native of spawnJsonLines({
          ...spec,
          cwd: spec.cwd ?? request.workdir,
          env: invocationEnvironment(request, spec.env),
          signal: request.signal,
          rawMessageMaxBytes: context?.streamLimits?.rawMessageMaxBytes,
          parseLine: parseJsonLine as (line: string) => TNative | null
        })) {
          const events = normalize(native, request) ?? [];
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
          for (const event of events) yield event;
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
export async function probeCommand(
  command: string,
  { env = process.env }: { env?: NodeJS.ProcessEnv } = {}
): Promise<ProbeResult> {
  const candidates =
    isAbsolute(command) || command.includes("/") || command.includes("\\")
      ? [command]
      : (env.PATH ?? "").split(delimiter).flatMap((directory) => {
          const extensions =
            process.platform === "win32" && !/\.[^\\/]+$/.test(command)
              ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")]
              : [""];
          return extensions.map((extension) => resolve(directory, command + extension));
        });
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      let version: string | null = null;
      try {
        const { stdout } = await promisify(execFile)(resolve(candidate), ["--version"], {
          env,
          timeout: 2_000,
          maxBuffer: 4096,
          windowsHide: true
        });
        const output = stdout.trim();
        // Keep a version label, not arbitrary CLI banners or diagnostics.
        version =
          output.match(/(?:^|\s)v?(\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?)(?=\s|$)/)?.[1] ??
          null;
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

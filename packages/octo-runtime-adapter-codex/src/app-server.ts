import {
  actmodeEvidence,
  invocationEnvs,
  mapReasoningEffort
} from "@mininglamp-oss/octo-runtime-adapter-sdk";
import {
  canonicalTerminalStatus,
  classifyFailure,
  contextHash,
  contextActmode,
  assertJsonByteLimit,
  INVOKE_REQUEST_MAX_BYTES,
  hasImageInput,
  providerInputParts,
  PROVIDER_DIAGNOSTIC_MAX_BYTES,
  resolveStreamLimitPolicy,
  streamCapacityError,
  type StreamLimitPolicy
} from "@mininglamp-oss/octo-runtime-protocol";
import { codexEnvironmentConfig } from "./environment.js";
import { createProcessCleanup } from "@mininglamp-oss/octo-runtime-adapter-sdk/process-cleanup";
/**
 * Codex app-server transport and event adaptation layer.
 *
 * Unlike the one-way NDJSON of `codex exec --json`, the app-server uses
 * bidirectional JSON-RPC 2.0 over stdin/stdout: Octo Runtime both sends
 * initialize/thread/turn requests and must respond to approval/elicitation
 * requests that Codex sends back. That is why this does not reuse the generic
 * JSON CLI helper, but instead maintains a request pending map, notification
 * parser, cancellation and process-reaping state.
 *
 * This module upholds four key invariants:
 * - the provider session becomes visible to the Core only after turn/start
 *   succeeds;
 * - each invocation publishes at most one run.* terminal;
 * - only notifications for the current active thread are consumed, avoiding
 *   crosstalk;
 * - all pending RPCs and subprocess resources eventually converge via
 *   close()/finally.
 */
import {
  sanitizePublicValue,
  DriverQueue,
  watchLineLimit,
  type AdapterInvocationContext,
  type AdapterOutput,
  type CanonicalEvent,
  type InvokeRequest,
  type MessageChannel,
  type MessageExposure
} from "@mininglamp-oss/octo-runtime-adapter-sdk";
import {
  protocolError,
  type InteractionResponse,
  type NativeInteractionResponse
} from "@mininglamp-oss/octo-runtime-protocol";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";

const APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
// R06b：EOF 宽限 250 ms + 共享 TERM/KILL 确认 600 ms，位于默认 Host 1 秒预算内。
const APP_SERVER_CLOSE_GRACE_MS = 250;
const FINALIZATION_TIMEOUT_MS = 15_000;
const FINALIZATION_INTERRUPT_GRACE_MS = 2_000;
// Keep only the tail of stderr, balancing error diagnosability against the memory ceiling of a long-lived process.
const STDERR_TAIL_LIMIT = 64 * 1024;

type JsonRecord = Record<string, unknown>;
type RpcId = string | number;

interface PendingRequest {
  /** Retains the business method name across a timeout or RPC error, rather than exposing only a numeric ID. */
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingInteraction {
  rpcId: RpcId;
  method: string;
  params: JsonRecord;
  responding: boolean;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

export type CodexInteractionResponder = (response: InteractionResponse) => Promise<void>;

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface CodexAppServerNotification {
  method: string;
  params?: JsonRecord;
}

export interface CodexAppServerCommand {
  /** Executable and app-server args; tests can substitute a fake server. */
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  mcpServers?: Record<string, Record<string, unknown>>;
  cleanup?: () => void | Promise<void>;
}

export type CodexAppServerSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => ChildProcessWithoutNullStreams;

/** A JSON-RPC error the app-server explicitly returned, preserving method, code and raw data. */
export class CodexAppServerRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(`${method}: ${message}`);
    this.name = "CodexAppServerRpcError";
  }
}

/** Error for when the subprocess exits without producing a run terminal, preserving exit code/signal. */
export class CodexAppServerProcessError extends Error {
  constructor(
    message: string,
    readonly exit: ProcessExit
  ) {
    super(message);
    this.name = "CodexAppServerProcessError";
  }
}

/** Production always uses the stdio transport; other injected args are only for a test server. */
export function buildCodexAppServerArgs(): string[] {
  return ["app-server", "--listen", "stdio://"];
}

/**
 * Execute one Octo Runtime invocation and convert the native Codex event stream
 * into CanonicalEvents.
 *
 * This is the top-level protocol state machine: initialize -> thread
 * resume/start -> turn/start -> stream. The function itself drives "phase
 * advancement" and resume fallback; CodexAppServerClient owns wire I/O and
 * normalizeCodexEvent handles the pure per-notification conversion.
 */
export async function* runCodexAppServerTurn({
  request,
  spec,
  spawnFn = defaultSpawn,
  context,
  onInteractionResponder,
  onNativeResponder
}: {
  request: InvokeRequest;
  spec: CodexAppServerCommand;
  spawnFn?: CodexAppServerSpawn;
  context?: AdapterInvocationContext;
  onInteractionResponder?: (responder: CodexInteractionResponder | undefined) => void;
  onNativeResponder?: (
    responder: ((response: NativeInteractionResponse) => Promise<void>) | undefined
  ) => void;
}): AsyncGenerator<AdapterOutput> {
  const requestTimeoutMs = appServerRequestTimeout(request);
  const interactive = request.approvalMode !== "full_access";
  let client = new CodexAppServerClient(
    spec,
    spawnFn,
    requestTimeoutMs,
    interactive,
    request,
    context
  );
  onInteractionResponder?.((response) => client.respondInteraction(response));
  onNativeResponder?.((response) => client.respondNative(response));
  let terminal = false;
  let executionFailure: unknown;

  try {
    throwIfAborted(request.signal);

    // Phase 1: negotiate the experimental app-server API first; no thread request is sent until initialize completes.
    try {
      await initializeClient(client);
    } catch (error) {
      if (!isInitializeTimeout(error) || request.signal?.aborted) throw error;
      onInteractionResponder?.(undefined);
      await client.close();
      throwIfAborted(request.signal);
      client = new CodexAppServerClient(
        spec,
        spawnFn,
        requestTimeoutMs,
        interactive,
        request,
        context
      );
      onInteractionResponder?.((response) => client.respondInteraction(response));
      onNativeResponder?.((response) => client.respondNative(response));
      await initializeClient(client);
    }
    client.notify("initialized");
    let environmentConfig: JsonRecord | undefined;
    if (Object.keys(invocationEnvs(request)).length || spec.mcpServers) {
      const result = recordValue(
        await client.request("config/read", { includeLayers: false, cwd: request.workdir })
      );
      const config = recordValue(result?.config);
      if (!config)
        throw new Error("CONTEXT_ENVS_UNAVAILABLE: provider effective configuration is missing");
      const nativeServers = recordValue(config.mcp_servers) ?? {};
      for (const name of Object.keys(spec.mcpServers ?? {})) {
        if (Object.hasOwn(nativeServers, name))
          throw Object.assign(new Error(`MCP_SERVER_NAME_CONFLICT: ${name}`), {
            code: "MCP_SERVER_NAME_CONFLICT"
          });
      }
      environmentConfig = codexEnvironmentConfig(request, {
        ...config,
        mcp_servers: { ...nativeServers, ...spec.mcpServers }
      });
      if (spec.mcpServers) {
        const forwarding = recordValue(environmentConfig.mcp_servers) ?? {};
        // config/read is a read model: optional nulls cannot be round-tripped as overrides.
        environmentConfig.mcp_servers = {
          ...forwarding,
          ...Object.fromEntries(
            Object.entries(spec.mcpServers).map(([name, server]) => [
              name,
              { ...server, ...recordValue(forwarding[name]) }
            ])
          )
        };
      }
    }

    // Phase 2: providerSession.sessionId is the Codex thread ID, kept opaque to the Core.
    const requestedSessionId = request.providerSession?.sessionId;
    let resumeFallback: string | undefined;
    let resumed = false;
    let threadResult: unknown;

    if (requestedSessionId) {
      try {
        threadResult = await client.request(
          "thread/resume",
          threadParams(
            request,
            {
              threadId: requestedSessionId,
              ...(context?.protocolMode !== "native" ? { excludeTurns: true } : {})
            },
            environmentConfig
          )
        );
        resumed = true;
      } catch (error) {
        // A failed resume does not abort this turn; record a low-cardinality reason and fall back to a fresh thread.
        resumeFallback = rpcFailureReason(error);
      }
    }

    if (!threadResult) {
      threadResult = await client.request(
        "thread/start",
        threadParams(request, { sessionStartSource: "startup" }, environmentConfig)
      );
    }

    let threadId = extractThreadId(threadResult);
    if (!threadId) throw new Error("codex thread start/resume returned no thread id");
    client.setActiveThread(threadId);
    const requestedMode = contextActmode(request.context);
    let collaborationMode: JsonRecord | undefined;
    let effectiveMode: "default" | "plan" | undefined;
    if (requestedMode !== undefined) {
      const modes = recordValue(await client.request("collaborationMode/list", {}));
      const available = Array.isArray(modes?.data) ? modes.data.map(recordValue) : [];
      effectiveMode = available.some((mode) => mode?.mode === requestedMode)
        ? requestedMode
        : "default";
      if (!available.some((mode) => mode?.mode === effectiveMode))
        throw new Error(
          "ACTMODE_UNSUPPORTED: Codex did not advertise a default collaboration mode"
        );
      const thread = recordValue(threadResult);
      const model = request.agentConfig.model ?? stringValue(thread?.model);
      if (!model) throw new Error("ACTMODE_UNCONFIRMED: Codex omitted its effective model");
      collaborationMode = {
        mode: effectiveMode,
        settings: {
          model,
          reasoning_effort:
            mapReasoningEffort("codex", request.agentConfig.effort) ??
            thread?.reasoningEffort ??
            null,
          developer_instructions: null
        }
      };
    }
    let turnResult: unknown;
    try {
      turnResult = await client.request("turn/start", {
        ...turnParams(request, threadId, resumeFallback !== undefined),
        ...(collaborationMode ? { collaborationMode } : {})
      });
    } catch (error) {
      // Some corrupt sessions pass thread/resume but only reveal the missing rollout at turn/start.
      if (!resumed || !isThreadNotFound(error)) throw error;
      resumeFallback = "turn_start_thread_not_found";
      resumed = false;
      threadResult = await client.request(
        "thread/start",
        threadParams(request, { sessionStartSource: "startup" }, environmentConfig)
      );
      threadId = extractThreadId(threadResult);
      if (!threadId) {
        throw new Error("codex fresh fallback returned no thread id", { cause: error });
      }
      client.setActiveThread(threadId);
      turnResult = await client.request("turn/start", {
        ...turnParams(request, threadId, true),
        ...(collaborationMode ? { collaborationMode } : {})
      });
    }

    const turnId = extractTurnId(turnResult);
    if (turnId) client.setActiveTurn(turnId);
    context?.reportActivity?.({ kind: "turn_started", method: "turn_start" });
    if (requestedMode !== undefined && effectiveMode !== undefined)
      yield actmodeEvidence(
        {
          requested: requestedMode,
          effective: effectiveMode,
          status: effectiveMode === requestedMode ? "applied" : "fallback",
          nativeMode: effectiveMode,
          ...(effectiveMode !== requestedMode ? { reason: "provider_unsupported" as const } : {})
        },
        context?.protocolMode
      );

    // Must come after turn/start: otherwise the Core would persist a provider session that cannot be executed.
    const session: CanonicalEvent = {
      protocolVersion: 2,
      type: "session.update",
      payload: {
        providerSession: {
          sessionId: threadId,
          resumable: true,
          ...(resumed ? { resumeOutcome: "resumed" } : {}),
          ...(resumeFallback
            ? {
                resumeOutcome: "fresh_fallback",
                resumeFallback,
                contextInputVariant:
                  request.freshFallbackModelInputParts || request.freshFallbackModelInput
                    ? "recovery"
                    : "primary"
              }
            : {})
        }
      }
    };
    yield context?.protocolMode === "native"
      ? {
          kind: "control",
          control: { type: "evidence", name: "session", payload: session.payload }
        }
      : session;
    for await (const event of client.events()) {
      if ("kind" in event) {
        terminal ||=
          event.kind === "control" &&
          event.control.type === "state" &&
          event.control.state !== "running";
        yield event;
        if (terminal) break;
        continue;
      }
      // The thread RPC response already produced the authoritative initial
      // update. Later lifecycle outcomes (such as compaction) must pass through.
      if (
        event.type === "session.update" &&
        event.payload.providerSession?.sessionId === threadId &&
        event.payload.providerSession.resumeOutcome === undefined
      ) {
        continue;
      }
      terminal ||= isTerminalEvent(event);
      yield event;
      if (terminal) break;
    }

    if (!terminal) {
      // Ending without a terminal in the queue is a protocol/process anomaly and must not be disguised as success.
      const exit = await client.exit();
      throw new CodexAppServerProcessError(client.processErrorMessage(exit), exit);
    }
  } catch (error) {
    executionFailure = error;
    if (context?.protocolMode === "native") {
      yield* client.bufferedEvents();
      throw error;
    }
    if (!terminal) {
      // AbortSignal takes priority in deciding cancelled semantics; all other errors project uniformly to provider run.failed.
      if (request.signal?.aborted) {
        yield {
          protocolVersion: 2,
          type: "run.cancelled",
          payload: { reason: String(request.signal.reason ?? "cancelled") }
        };
      } else {
        const code = stringErrorCode(error);
        yield {
          protocolVersion: 2,
          type: "run.failed",
          payload: {
            message: client.errorMessage(error),
            adapterType: "codex",
            ...(code ? { code } : {}),
            ...(error instanceof CodexAppServerRpcError
              ? {
                  error: {
                    code: error.code,
                    message: error.message,
                    ...(error.data === undefined ? {} : { data: error.data })
                  }
                }
              : {}),
            ...(code === "RPC_TIMEOUT"
              ? {
                  timeoutStage: "rpc",
                  timeoutReason: "rpc_timeout",
                  timeoutMs: requestTimeoutMs
                }
              : {})
          }
        };
      }
    }
  } finally {
    // close() handles RPC/stdio/process; spec.cleanup handles any caller-owned resources.
    onInteractionResponder?.(undefined);
    onNativeResponder?.(undefined);
    await closeClientAndResources(client, spec, executionFailure);
  }
}

async function closeClientAndResources(
  client: CodexAppServerClient,
  spec: CodexAppServerCommand,
  executionFailure: unknown
): Promise<void> {
  try {
    await client.close();
  } catch (cleanupError) {
    // R06b：清理失败不能覆盖原始执行失败，也不能阻止调用方资源释放。
    if (executionFailure !== undefined)
      throw new AggregateError(
        [executionFailure, cleanupError],
        "Codex execution and process cleanup failed",
        { cause: cleanupError }
      );
    throw cleanupError;
  } finally {
    await spec.cleanup?.();
  }
}

function initializeClient(client: CodexAppServerClient): Promise<unknown> {
  return client.request("initialize", {
    clientInfo: {
      name: "@mininglamp-oss/octo-runtime-adapter-codex",
      version: "0.1.0"
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      optOutNotificationMethods: ["mcpServer/startupStatus/updated", "remoteControl/status/changed"]
    }
  });
}

function isInitializeTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^codex app-server initialize timed out after \d+ms$/.test(error.message)
  );
}

function stringErrorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

/**
 * Purely map one app-server notification into zero or more canonical events.
 *
 * The convenience function maps one isolated notification. Live invocations use
 * CodexEventNormalizer below so related reasoning, tool, and answer items share a
 * stable model-step id across notification boundaries.
 */
export function normalizeCodexEvent(native: CodexAppServerNotification): CanonicalEvent[] {
  return new CodexEventNormalizer().normalize(native);
}

/**
 * Reconstruct Codex model rounds from its item stream.
 *
 * Codex does not publish OpenCode-style step_start/step_finish frames. A model
 * round therefore starts with the first reasoning/plan/answer item after a tool
 * batch and finishes when that model response requests tools or completes its
 * answer. Consecutive tool items share the same round.
 */
export class CodexEventNormalizer {
  #turnId?: string;
  #round = 0;
  #planRevision = 0;
  #noticeNumber = 0;
  #attempt = 1;
  #diagnosticReported = false;
  #activeStepId?: string;
  #toolBatchStepId?: string;
  readonly #itemSteps = new Map<string, string>();
  readonly #itemChannels = new Map<string, MessageChannel>();

  normalize(native: CodexAppServerNotification): CanonicalEvent[] {
    const params = native.params ?? {};
    switch (native.method) {
      case "turn/plan/updated": {
        const plan = Array.isArray(params.plan) ? params.plan : [];
        return [
          {
            protocolVersion: 2,
            type: "plan.updated",
            payload: {
              planId: "codex:plan",
              revision: ++this.#planRevision,
              explanation:
                typeof params.explanation === "string" ? params.explanation.slice(0, 4096) : null,
              steps: plan.slice(0, 200).map((value) => {
                const step = recordValue(value) ?? {};
                const status =
                  step.status === "inProgress"
                    ? "in_progress"
                    : step.status === "completed"
                      ? "completed"
                      : "pending";
                return {
                  text: typeof step.step === "string" ? step.step.slice(0, 4096) : "",
                  status
                };
              })
            }
          }
        ];
      }
      case "item/mcpToolCall/progress": {
        const id = itemId(params);
        return id && typeof params.message === "string"
          ? [
              {
                protocolVersion: 2,
                type: "tool_call.progress",
                payload: { id, progress: { message: params.message.slice(0, 4096) } }
              }
            ]
          : [];
      }
      case "model/rerouted":
        return typeof params.fromModel === "string" && typeof params.toModel === "string"
          ? [
              {
                protocolVersion: 2,
                type: "run.notice",
                payload: {
                  noticeId: `codex:notice:${++this.#noticeNumber}`,
                  code: "model_rerouted",
                  severity: "info",
                  params: {
                    fromModel: params.fromModel.slice(0, 191),
                    toModel: params.toModel.slice(0, 191)
                  }
                }
              }
            ]
          : [];
      case "thread/started": {
        const threadId =
          stringValue(params.threadId) ||
          stringValue(recordValue(params.thread)?.id) ||
          stringValue(recordValue(params.thread)?.sessionId);
        return threadId
          ? [
              {
                protocolVersion: 2,
                type: "session.update",
                payload: { providerSession: { sessionId: threadId, resumable: true } }
              }
            ]
          : [];
      }
      case "thread/compacted": {
        const threadId =
          stringValue(params.threadId) ||
          stringValue(recordValue(params.thread)?.id) ||
          stringValue(recordValue(params.thread)?.sessionId);
        return threadId
          ? [
              {
                protocolVersion: 2,
                type: "run.notice",
                payload: {
                  noticeId: `codex:notice:${++this.#noticeNumber}`,
                  code: "context_compacted",
                  severity: "info",
                  params: {}
                }
              },
              {
                protocolVersion: 2,
                type: "session.update",
                payload: {
                  providerSession: {
                    sessionId: threadId,
                    resumable: true,
                    resumeOutcome: "compacted"
                  }
                }
              }
            ]
          : [];
      }
      case "turn/started":
        this.#beginTurn(params);
        return [];
      case "item/agentMessage/delta":
        return textDelta(
          params,
          this.#channelFor(params),
          undefined,
          undefined,
          this.#stepFor(params)
        );
      case "item/reasoning/summaryTextDelta":
        return textDelta(
          params,
          "analysis",
          "public_summary",
          "item/reasoning/summaryTextDelta",
          this.#stepFor(params)
        );
      case "item/reasoning/textDelta":
        return textDelta(
          params,
          "analysis",
          "private_reasoning",
          "item/reasoning/textDelta",
          this.#stepFor(params)
        );
      case "item/plan/delta":
        return textDelta(
          params,
          "analysis",
          "public_plan",
          "item/plan/delta",
          this.#stepFor(params)
        );
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta": {
        const id = itemId(params);
        const delta = stringValue(params.delta);
        const stepId = this.#stepFor(params);
        return id && delta
          ? [
              {
                protocolVersion: 2,
                type: "tool_call.delta",
                payload: { id, outputDelta: delta, ...(stepId ? { stepId } : {}) }
              }
            ]
          : [];
      }
      case "thread/tokenUsage/updated":
        return usageEvents(params);
      case "item/started":
        return this.#itemStarted(params);
      case "item/completed":
        return this.#itemCompleted(params);
      case "turn/completed":
        return [
          ...this.#finishActiveStep(turnStepStatus(recordValue(params.turn)), "stop"),
          ...turnCompletedEvents(recordValue(params.turn))
        ];
      case "error": {
        if (params.willRetry === true)
          return [
            {
              protocolVersion: 2,
              type: "run.notice",
              payload: {
                noticeId: `codex:notice:${++this.#noticeNumber}`,
                code: "retry_scheduled",
                severity: "warning",
                params: { attempt: (this.#attempt = Math.min(this.#attempt + 1, 65535)) }
              }
            }
          ];
        // ErrorNotification is an in-turn diagnostic. Codex may still recover
        // after a failed tool and emit more items; turn/completed is the only
        // authoritative turn terminal.
        const finished = this.#finishActiveStep("failed", "error");
        if (this.#diagnosticReported) return finished;
        this.#diagnosticReported = true;
        const error = recordValue(params.error);
        // 分类只使用 Provider 结构化证据；文本仅经脱敏后供业务展示。
        const failure = classifyFailure(codexFailureDetails(error), {
          stage: "provider.invoke",
          defaultDomain: "provider",
          source: { component: "octo-runtime", adapter: "codex" }
        });
        const safeMessage = String(
          sanitizePublicValue(
            (stringValue(error?.message) || stringValue(params.message)).trim() ||
              "Codex reported an in-turn error"
          )
        );
        let message = "";
        let bytes = 0;
        for (const character of safeMessage) {
          const size = Buffer.byteLength(character);
          if (bytes + size > PROVIDER_DIAGNOSTIC_MAX_BYTES) break;
          message += character;
          bytes += size;
        }
        return [
          ...finished,
          {
            protocolVersion: 2,
            type: "run.notice",
            payload: {
              noticeId: `codex:notice:${++this.#noticeNumber}`,
              code: "provider_diagnostic",
              severity: "warning",
              params: {
                adapter: "codex",
                diagnosticId: failure.diagnosticId,
                category: failure.category,
                message
              }
            }
          }
        ];
      }
      default: {
        if (isToolArgsDeltaMethod(native.method)) {
          const id = itemId(params);
          const delta = stringValue(params.delta);
          const stepId = this.#stepFor(params);
          return id && delta
            ? [
                {
                  protocolVersion: 2,
                  type: "tool_call.delta",
                  payload: { id, argsDelta: delta, ...(stepId ? { stepId } : {}) }
                }
              ]
            : [];
        }
        return [];
      }
    }
  }

  #beginTurn(params: JsonRecord): void {
    const turnId = notificationTurnId(params);
    if (!turnId || turnId === this.#turnId) return;
    this.#turnId = turnId;
    this.#round = 0;
    this.#activeStepId = undefined;
    this.#toolBatchStepId = undefined;
    this.#itemSteps.clear();
    this.#itemChannels.clear();
  }

  #itemStarted(params: JsonRecord): CanonicalEvent[] {
    const item = recordValue(params.item);
    if (!item) return [];
    const id = stringValue(item.id);
    const tool = toolDescriptor(item);
    if (tool) {
      const prefix: CanonicalEvent[] = [];
      let stepId = this.#toolBatchStepId;
      if (!stepId) {
        const started = this.#ensureActiveStep(params);
        prefix.push(...started.events);
        stepId = started.stepId;
      }
      if (id && stepId) this.#itemSteps.set(id, stepId);
      const events = itemStartedEvents(item, stepId);
      if (this.#activeStepId === stepId) {
        this.#toolBatchStepId = stepId;
        events.push(...this.#finishActiveStep("completed", "tool-calls"));
      }
      return [...prefix, ...events];
    }

    const type = stringValue(item.type);
    if (type === "contextCompaction" && id)
      return [
        {
          protocolVersion: 2,
          type: "activity.started",
          payload: {
            activityId: `codex:compaction:${id}`,
            kind: "compacting",
            subject: { type: "run" },
            source: "provider",
            info: {}
          }
        }
      ];
    if (type !== "reasoning" && type !== "plan" && type !== "agentMessage") return [];
    this.#toolBatchStepId = undefined;
    const started = this.#ensureActiveStep(params);
    if (id) {
      this.#itemSteps.set(id, started.stepId);
      if (type === "agentMessage") this.#itemChannels.set(id, agentMessageChannel(item));
    }
    return [...started.events, ...itemStartedEvents(item, started.stepId)];
  }

  #itemCompleted(params: JsonRecord): CanonicalEvent[] {
    const item = recordValue(params.item);
    if (!item) return [];
    const id = stringValue(item.id);
    if (stringValue(item.type) === "contextCompaction" && id) {
      const threadId = stringValue(params.threadId);
      return [
        {
          protocolVersion: 2,
          type: "activity.finished",
          payload: { activityId: `codex:compaction:${id}`, status: "completed" }
        },
        {
          protocolVersion: 2,
          type: "run.notice",
          payload: {
            noticeId: `codex:compaction:${id}`,
            code: "context_compacted",
            severity: "info",
            params: {}
          }
        },
        ...(threadId
          ? [
              {
                protocolVersion: 2 as const,
                type: "session.update" as const,
                payload: {
                  providerSession: {
                    sessionId: threadId,
                    resumable: true,
                    resumeOutcome: "compacted" as const
                  }
                }
              }
            ]
          : [])
      ];
    }
    const stepId = id ? this.#itemSteps.get(id) : undefined;
    const channel = id ? this.#itemChannels.get(id) : undefined;
    const events = itemCompletedEvents(item, stepId, channel);
    if (
      stringValue(item.type) === "agentMessage" &&
      (channel ?? agentMessageChannel(item)) === "final" &&
      stepId === this.#activeStepId
    ) {
      events.push(...this.#finishActiveStep("completed", "stop"));
    }
    return events;
  }

  #ensureActiveStep(params: JsonRecord): { stepId: string; events: CanonicalEvent[] } {
    this.#beginTurn(params);
    if (this.#activeStepId) return { stepId: this.#activeStepId, events: [] };
    const turnId = notificationTurnId(params) || this.#turnId || "turn";
    const stepId = `codex:${turnId}:round:${++this.#round}`;
    this.#activeStepId = stepId;
    return {
      stepId,
      events: [{ protocolVersion: 2, type: "model_step.started", payload: { stepId } }]
    };
  }

  #finishActiveStep(status: string, finishReason: string): CanonicalEvent[] {
    const stepId = this.#activeStepId;
    if (!stepId) return [];
    this.#activeStepId = undefined;
    return [
      {
        protocolVersion: 2,
        type: "model_step.finished",
        payload: { stepId, status: canonicalTerminalStatus(status), finishReason }
      }
    ];
  }

  #stepFor(params: JsonRecord): string | undefined {
    const id = itemId(params);
    return id ? this.#itemSteps.get(id) : undefined;
  }

  #channelFor(params: JsonRecord): MessageChannel {
    const id = itemId(params);
    return id ? (this.#itemChannels.get(id) ?? "final") : "final";
  }
}

function interactionKind(method: string): "approval" | "question" | "elicitation" | undefined {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "execCommandApproval":
    case "item/fileChange/requestApproval":
    case "applyPatchApproval":
    case "item/permissions/requestApproval":
      return "approval";
    case "item/tool/requestUserInput":
      return "question";
    case "mcpServer/elicitation/request":
      return "elicitation";
    default:
      return undefined;
  }
}

/** Keep provider-owned request ids opaque while producing a short, ASCII database key. */
function codexInteractionId(id: RpcId, invocationId: string, sequence: number): string {
  return `codex:${createHash("sha256")
    .update(JSON.stringify([invocationId, id, sequence]))
    .digest("hex")}`;
}

function automaticServerRequestResult(method: string): unknown {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "accept" };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: "approved" };
    default:
      return undefined;
  }
}

function displaySafeInteractionRequest(method: string, params: JsonRecord): JsonRecord {
  const request: JsonRecord = { provider: "codex", method };
  for (const key of ["itemId", "approvalId", "reason", "command", "cwd", "grantRoot"] as const) {
    if (params[key] !== undefined && params[key] !== null) request[key] = boundedJson(params[key]);
  }

  if (method === "execCommandApproval" && Array.isArray(params.command)) {
    request.command = boundedJson(params.command);
  }
  if (method === "applyPatchApproval") {
    const changes = recordValue(params.fileChanges);
    if (changes)
      request.files = Object.keys(changes)
        .slice(0, 100)
        .map((value) => boundedString(value));
  }
  if (method === "item/permissions/requestApproval") {
    request.permissions = boundedJson(params.permissions);
  }
  if (method === "item/tool/requestUserInput") {
    request.questions = Array.isArray(params.questions)
      ? params.questions.slice(0, 50).map((question) => {
          const value = recordValue(question) ?? {};
          return {
            id: boundedString(value.id),
            header: boundedString(value.header),
            question: boundedString(value.question),
            isOther: value.isOther === true,
            isSecret: value.isSecret === true,
            options: Array.isArray(value.options)
              ? value.options.slice(0, 50).map((option) => {
                  const entry = recordValue(option) ?? {};
                  return {
                    label: boundedString(entry.label),
                    description: boundedString(entry.description)
                  };
                })
              : null
          };
        })
      : [];
  }
  if (method === "mcpServer/elicitation/request") {
    for (const key of ["serverName", "mode", "title", "description", "message", "url"] as const) {
      if (params[key] !== undefined && params[key] !== null)
        request[key] = boundedString(params[key]);
    }
    if (params.requestedSchema !== undefined)
      request.requestedSchema = boundedJson(params.requestedSchema);
    // Provider `_meta` and user-verification challenges are deliberately not projected.
  }
  return sanitizePublicValue(request) as JsonRecord;
}

function providerInteractionReply(
  pending: PendingInteraction,
  response: InteractionResponse
): JsonRecord {
  const { method, params } = pending;
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { result: { decision: approvalDecision(response, false) } };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { result: { decision: approvalDecision(response, true) } };
    case "item/permissions/requestApproval": {
      requireApprovalOutcome(response);
      return {
        result: {
          permissions: response.outcome === "accepted" ? requestedPermissionGrant(params) : {},
          scope: "turn"
        }
      };
    }
    case "mcpServer/elicitation/request":
      if (response.outcome === "declined" || response.outcome === "cancelled") {
        return {
          result: {
            action: response.outcome === "declined" ? "decline" : "cancel",
            content: null,
            _meta: null
          }
        };
      }
      if (response.outcome !== "accepted" && response.outcome !== "answered") {
        throw new Error("unsupported elicitation outcome");
      }
      return { result: { action: "accept", content: jsonValue(response.value), _meta: null } };
    case "item/tool/requestUserInput":
      if (response.outcome === "declined" || response.outcome === "cancelled") {
        return {
          error: {
            code: -32001,
            message:
              response.outcome === "declined" ? "user declined input" : "user cancelled input"
          }
        };
      }
      if (response.outcome !== "answered") {
        throw new Error(
          `request_user_input requires answered outcome, received: ${response.outcome}`
        );
      }
      return { result: { answers: questionAnswers(params, response.value) } };
    default:
      throw new Error(`unsupported codex interaction method: ${method}`);
  }
}

function requireApprovalOutcome(response: InteractionResponse): void {
  if (response.outcome === "answered") {
    throw new Error("approval interaction does not accept answered outcome");
  }
}

function approvalDecision(response: InteractionResponse, legacy: boolean): unknown {
  requireApprovalOutcome(response);
  if (legacy) {
    if (response.outcome === "accepted") return "approved";
    if (response.outcome === "cancelled") return "abort";
    return { denied: { rejection: responseReason(response.value) } };
  }
  if (response.outcome === "accepted") return "accept";
  return response.outcome === "cancelled" ? "cancel" : "decline";
}

function requestedPermissionGrant(params: JsonRecord): JsonRecord {
  const requested = recordValue(params.permissions);
  if (!requested) return {};
  return {
    ...(recordValue(requested.network) ? { network: requested.network } : {}),
    ...(recordValue(requested.fileSystem) ? { fileSystem: requested.fileSystem } : {})
  };
}

function questionAnswers(params: JsonRecord, value: unknown): JsonRecord {
  const outer = recordValue(value);
  const source = recordValue(outer?.answers) ?? outer;
  if (!source) throw new TypeError("request_user_input response value must be an answer object");
  const questions = Array.isArray(params.questions) ? params.questions : [];
  const entries: Array<[string, { answers: string[] }]> = [];
  for (const question of questions) {
    const id = stringValue(recordValue(question)?.id);
    if (!id) continue;
    const raw = source[id];
    const wrapped = recordValue(raw);
    const answers =
      typeof raw === "string"
        ? [raw]
        : Array.isArray(raw)
          ? raw.filter((item): item is string => typeof item === "string")
          : Array.isArray(wrapped?.answers)
            ? wrapped.answers.filter((item): item is string => typeof item === "string")
            : [];
    if (answers.length === 0) throw new TypeError(`missing answer for Codex question: ${id}`);
    entries.push([id, { answers }]);
  }
  if (entries.length === 0)
    throw new TypeError("request_user_input contained no answerable questions");
  return Object.fromEntries(entries);
}

function responseReason(value: unknown): string {
  if (typeof value === "string" && value.trim()) return boundedString(value, 1_000);
  const reason = stringValue(recordValue(value)?.reason);
  return reason ? boundedString(reason, 1_000) : "declined by user";
}

function jsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("value is not JSON serializable");
    return JSON.parse(encoded) as unknown;
  } catch (error) {
    throw new TypeError("interaction response value must be JSON serializable", { cause: error });
  }
}

function boundedString(value: unknown, limit = 8_192): string {
  const text = typeof value === "string" ? value : "";
  return text.length <= limit ? text : `${text.slice(0, limit)}...[truncated]`;
}

function boundedJson(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return boundedString(value);
  if (depth >= 6) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => boundedJson(item, depth + 1));
  const record = recordValue(value);
  if (!record) return boundedString(value);
  return Object.fromEntries(
    Object.entries(record)
      .slice(0, 100)
      .map(([key, item]) => [boundedString(key, 256), boundedJson(item, depth + 1)])
  );
}

/**
 * JSON-RPC client for a single invocation, backed by a single app-server subprocess.
 *
 * Three kinds of frame may interleave on stdout:
 * 1. a response carrying id + result/error, which settles a Promise in #pending;
 * 2. a notification with no id, which is converted and pushed into #queue;
 * 3. a server request carrying id + method, which the adapter must respond to.
 *
 * This class does not decide the resume/fresh strategy; it only owns the wire,
 * the process and the active thread/turn state.
 */
class CodexAppServerClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #cleanupProcess: () => Promise<void>;
  #closePromise?: Promise<void>;
  readonly #reader: ReadLineInterface;
  readonly #removeLineGuard: () => void;
  readonly #queue: DriverQueue<AdapterOutput>;
  readonly #streamLimits: Readonly<StreamLimitPolicy>;
  readonly #normalizer?: CodexEventNormalizer;
  readonly #native: boolean;
  readonly #pending = new Map<RpcId, PendingRequest>();
  readonly #interactions = new Map<string, PendingInteraction>();
  readonly #nativeRequestIds = new Set<RpcId>();
  readonly #requestTimeoutMs: number;
  readonly #interactive: boolean;
  readonly #signal?: AbortSignal;
  readonly #exitPromise: Promise<ProcessExit>;
  #resolveExit: (exit: ProcessExit) => void = () => undefined;
  #nextId = 1;
  #nextInteractionId = 1;
  #stderr = "";
  #closed = false;
  #transportFailure?: Error;
  #closing = false;
  #exited = false;
  #terminal = false;
  #activeThreadId?: string;
  #activeTurnId?: string;
  #lastUsage = -1;
  readonly #seenItems = new Set<string>();
  #abortTimer?: NodeJS.Timeout;
  #finalizationTimer?: NodeJS.Timeout;
  #finalizationGraceTimer?: NodeJS.Timeout;
  #finalizationTimedOut = false;
  #finalizationTimeoutMs = FINALIZATION_TIMEOUT_MS;
  readonly #openItems = new Set<string>();

  #clearFinalizationTimer(): void {
    if (this.#finalizationTimer) clearTimeout(this.#finalizationTimer);
    this.#finalizationTimer = undefined;
  }

  #finalizationFailure(): AdapterOutput {
    if (this.#native)
      return {
        kind: "control",
        control: {
          type: "error",
          code: "HOST_EXECUTION_FAILED",
          message: "CODEX_FINALIZATION_TIMEOUT"
        }
      };
    return {
      protocolVersion: 2,
      type: "run.failed",
      payload: {
        code: "CODEX_FINALIZATION_TIMEOUT",
        adapterType: "codex",
        message:
          "Codex final answer completed but the turn did not finish before the finalization deadline",
        timeoutStage: "rpc",
        timeoutReason: "rpc_timeout",
        timeoutMs: this.#finalizationTimeoutMs
      }
    };
  }

  #watchFinalization(method: string, params: JsonRecord): void {
    if (this.#terminal || this.#closed || this.#finalizationTimedOut) return;
    if (method === "turn/completed") {
      this.#clearFinalizationTimer();
      return;
    }
    if (method === "item/started") {
      const id = stringValue(recordValue(params.item)?.id);
      if (id) this.#openItems.add(id);
      this.#clearFinalizationTimer();
      return;
    }
    if (method === "error" || method.endsWith("Delta") || method.endsWith("/delta")) {
      this.#clearFinalizationTimer();
      return;
    }
    if (method !== "item/completed") return;
    const item = recordValue(params.item);
    const id = stringValue(item?.id);
    if (id) this.#openItems.delete(id);
    if (
      item?.type !== "agentMessage" ||
      item.phase !== "final_answer" ||
      params.threadId !== this.#activeThreadId ||
      notificationTurnId(params) !== this.#activeTurnId ||
      this.#openItems.size ||
      this.#interactions.size ||
      !this.#activeThreadId ||
      !this.#activeTurnId
    )
      return;
    this.#clearFinalizationTimer();
    const configured = recordValue(
      this.invocation.agentConfig.providerOptions
    )?.finalizationTimeoutMs;
    const timeoutMs =
      typeof configured === "number" && Number.isFinite(configured) && configured > 0
        ? configured
        : FINALIZATION_TIMEOUT_MS;
    this.#finalizationTimeoutMs = timeoutMs;
    this.#finalizationTimer = setTimeout(() => {
      this.#finalizationTimedOut = true;
      // RPC acknowledgement is not a turn terminal; await the notification separately.
      this.#finalizationGraceTimer = setTimeout(() => {
        if (this.#terminal || this.#closed) return;
        this.#terminal = true;
        this.#queue.push(this.#finalizationFailure());
        if (this.#native)
          this.#queue.push({ kind: "control", control: { type: "state", state: "failed" } });
        this.#queue.close();
      }, FINALIZATION_INTERRUPT_GRACE_MS);
      void this.request(
        "turn/interrupt",
        { threadId: this.#activeThreadId, turnId: this.#activeTurnId },
        FINALIZATION_INTERRUPT_GRACE_MS
      ).catch(() => undefined);
    }, timeoutMs);
  }

  /**
   * Cancellation follows a "converge host events first, then best-effort notify
   * the provider" order.
   *
   * The queue immediately publishes the sole run.cancelled so the UI need not wait
   * for a Codex response; if the thread/turn IDs are known, turn/interrupt is
   * sent in the background. After 250ms the same bounded cleanup used by close()
   * starts even if the consumer has stopped reading the cancellation terminal.
   */
  readonly #abortListener = (): void => {
    if (this.#closed || this.#terminal) return;
    this.#terminal = true;
    this.#clearFinalizationTimer();
    this.#invalidateInteractions("run_cancelled");
    if (this.#native)
      this.#queue.push({ kind: "control", control: { type: "state", state: "cancelled" } });
    else
      this.#queue.push({
        protocolVersion: 2,
        type: "run.cancelled",
        payload: { reason: String(this.#signal?.reason ?? "cancelled") }
      });
    this.#queue.close();
    if (this.#activeThreadId && this.#activeTurnId) {
      void this.request(
        "turn/interrupt",
        {
          threadId: this.#activeThreadId,
          turnId: this.#activeTurnId
        },
        1_000
      ).catch(() => undefined);
    }
    this.#abortTimer = setTimeout(() => {
      // 观察异步失败以免产生 unhandled rejection；close 仍等待同一 Promise 并返回失败。
      void this.#cleanupProcess().catch((error: Error) => this.#handleProcessError(error));
    }, APP_SERVER_CLOSE_GRACE_MS);
    this.#abortTimer.unref?.();
  };

  constructor(
    spec: CodexAppServerCommand,
    spawnFn: CodexAppServerSpawn,
    requestTimeoutMs: number,
    interactive: boolean,
    readonly invocation: InvokeRequest,
    readonly context?: AdapterInvocationContext
  ) {
    this.#streamLimits = resolveStreamLimitPolicy(context?.streamLimits);
    this.#queue = new DriverQueue<AdapterOutput>({
      limits: this.#streamLimits,
      boundary: "codex.event_queue"
    });
    this.#native = context?.protocolMode === "native";
    if (!this.#native) this.#normalizer = new CodexEventNormalizer();
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#interactive = interactive;
    const signal = invocation.signal;
    this.#signal = signal;
    this.#exitPromise = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
    this.#child = spawnFn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env });
    this.#cleanupProcess = createProcessCleanup(this.#child, {
      // 只有 production defaultSpawn 明确拥有独立组；注入的 child 不推定拥有组。
      processGroup: isolatedProcessGroups.has(this.#child)
    });

    // The app-server protocol requires one JSON-RPC frame per line; readline handles chunk boundaries.
    const transportLimit =
      !this.#native && hasImageInput(invocation)
        ? INVOKE_REQUEST_MAX_BYTES
        : this.#streamLimits.rawMessageMaxBytes;
    this.#removeLineGuard = watchLineLimit(this.#child.stdout, transportLimit, (error) => {
      this.#reader.close();
      this.#child.stdout.destroy();
      this.#handleProcessError(error);
      signalProcessTree(this.#child, "SIGTERM");
    });
    this.#reader = createInterface({ input: this.#child.stdout });
    this.#reader.on("line", (line) => this.#handleLine(line));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string | Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString()).slice(-STDERR_TAIL_LIMIT);
    });

    // spawn error and normal/abnormal close are watched separately, but both ultimately reject pending RPCs and close the event stream.
    // S01（Jerry-Xin R05 同类）：write 回调不能代替流 error 监听。
    // .octospec/tasks/pr1-yujiawei-review/assessment.md
    for (const source of [
      this.#child,
      this.#child.stdin,
      this.#child.stdout,
      this.#child.stderr,
      this.#reader
    ]) {
      source.on("error", (error: Error) => this.#handleProcessError(error));
    }
    this.#child.once("close", (code, exitSignal) => this.#handleExit({ code, signal: exitSignal }));
    if (signal?.aborted) queueMicrotask(this.#abortListener);
    else signal?.addEventListener("abort", this.#abortListener, { once: true });
  }

  setActiveThread(threadId: string): void {
    this.#activeThreadId = threadId;
  }

  setActiveTurn(turnId: string): void {
    this.#activeTurnId = turnId;
  }

  events(): AsyncIterable<AdapterOutput> {
    return this.#queue;
  }
  bufferedEvents(): AdapterOutput[] {
    return this.#queue.drain();
  }

  /** Accept only a provider reply to a pending request in this invocation. */
  async respondNative(response: NativeInteractionResponse): Promise<void> {
    if (!this.#native || this.#closed || this.#exited || this.#terminal)
      throw protocolError("INTERACTION_NOT_ACTIVE");
    const entry = [...this.#interactions.entries()].find(
      ([, value]) => value.rpcId === response.requestId
    );
    if (!entry) throw protocolError("INTERACTION_NOT_ACTIVE");
    const [interactionId, pending] = entry;
    if (pending.responding || pending.expiresAt <= Date.now())
      throw protocolError("INTERACTION_NOT_ACTIVE");
    const payload = response.payload;
    if (
      payload.id !== pending.rpcId ||
      payload.jsonrpc !== "2.0" ||
      Object.hasOwn(payload, "result") === Object.hasOwn(payload, "error") ||
      Object.keys(payload).some((key) => !["jsonrpc", "id", "result", "error"].includes(key))
    )
      throw protocolError("NATIVE_RESPONSE_INVALID");
    const result = recordValue(payload.result);
    const error = recordValue(payload.error);
    if (error) {
      if (!Number.isSafeInteger(error.code) || typeof error.message !== "string")
        throw protocolError("NATIVE_RESPONSE_INVALID");
    } else if (!result) throw protocolError("NATIVE_RESPONSE_INVALID");
    else if (interactionKind(pending.method) === "approval") {
      const legacy =
        pending.method === "execCommandApproval" || pending.method === "applyPatchApproval";
      const decisions = legacy ? ["approved", "abort"] : ["accept", "decline", "cancel"];
      if (
        Object.keys(result).some((key) => key !== "decision") ||
        !(
          decisions.includes(String(result.decision)) ||
          (legacy && recordValue(recordValue(result.decision)?.denied))
        )
      )
        throw protocolError("NATIVE_RESPONSE_INVALID");
    } else if (pending.method === "item/tool/requestUserInput") {
      questionAnswers(pending.params, result);
    } else if (pending.method === "mcpServer/elicitation/request") {
      if (!["accept", "decline", "cancel"].includes(String(result.action)))
        throw protocolError("NATIVE_RESPONSE_INVALID");
    } else throw protocolError("NATIVE_METHOD_UNSUPPORTED");
    pending.responding = true;
    await new Promise<void>((resolve, reject) =>
      this.#write(
        payload,
        (error) => {
          this.#invalidateInteractions("response_delivery_failed");
          this.#queue.fail(error);
          signalProcessTree(this.#child, "SIGTERM");
          reject(error);
        },
        () => {
          if (!this.#interactions.has(interactionId)) {
            reject(protocolError("INTERACTION_NOT_ACTIVE"));
            return;
          }
          clearTimeout(pending.timer);
          this.#interactions.delete(interactionId);
          this.#interactionState(interactionId, pending.rpcId, "resolved");
          resolve();
        }
      )
    );
  }

  #interactionState(
    interactionId: string,
    requestId: RpcId,
    status: "resolved" | "expired" | "invalidated",
    reasonCode?: string
  ): void {
    this.#queue.push(
      this.#native
        ? { kind: "control", control: { type: "interaction", requestId, status } }
        : {
            protocolVersion: 2,
            type: "interaction.resolved",
            payload: {
              interactionId,
              executionInstanceId: this.invocation.invocationId,
              status,
              ...(reasonCode ? { reasonCode } : {}),
              ...(reasonCode === "full_access_policy" ? { outcome: "accepted" } : {})
            }
          }
    );
  }

  /** Resume one provider reverse request after the durable Worker response reaches this invocation. */
  respondInteraction(response: InteractionResponse): Promise<void> {
    if (this.#closed || this.#exited || this.#terminal) {
      return Promise.reject(new Error("codex interaction is no longer active"));
    }
    const pending = this.#interactions.get(response.interactionId);
    if (!pending) {
      return Promise.reject(new Error(`unknown codex interaction: ${response.interactionId}`));
    }
    if (pending.expiresAt <= Date.now()) return Promise.reject(new Error("INTERACTION_EXPIRED"));
    if (pending.responding) {
      return Promise.reject(
        new Error(`codex interaction response is already in flight: ${response.interactionId}`)
      );
    }

    let reply: JsonRecord;
    try {
      reply = providerInteractionReply(pending, response);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    pending.responding = true;
    return new Promise((resolve, reject) => {
      this.#write(
        { jsonrpc: "2.0", id: pending.rpcId, ...reply },
        (error) => {
          pending.responding = false;
          reject(error);
        },
        () => {
          if (!this.#interactions.has(response.interactionId)) {
            reject(new Error("INTERACTION_NOT_ACTIVE"));
            return;
          }
          clearTimeout(pending.timer);
          this.#interactions.delete(response.interactionId);
          this.#queue.push({
            protocolVersion: 2,
            type: "interaction.resolved",
            payload: {
              interactionId: response.interactionId,
              executionInstanceId: this.invocation.invocationId,
              status: "resolved",
              outcome: response.outcome
            }
          });
          resolve();
        }
      );
    });
  }

  exit(): Promise<ProcessExit> {
    return this.#exitPromise;
  }

  request(
    method: string,
    params: unknown,
    timeoutMs = this.#requestTimeoutMs,
    onWritten?: () => void,
    requestId?: RpcId
  ): Promise<unknown> {
    if (this.#transportFailure) return Promise.reject(this.#transportFailure);
    if (this.#closed || this.#exited) {
      return Promise.reject(new Error("codex app-server is closed"));
    }
    const id = requestId ?? this.reserveRequestId();
    if (this.#pending.has(id)) {
      return Promise.reject(
        new Error(`codex app-server request id ${String(id)} is already pending`)
      );
    }
    return new Promise((resolve, reject) => {
      // Register pending before writing stdin, so a synchronous reply from a test server/local process cannot arrive first.
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        reject(
          Object.assign(new Error(`codex app-server ${method} timed out after ${timeoutMs}ms`), {
            code: "RPC_TIMEOUT",
            timeoutStage: "rpc",
            timeoutReason: "rpc_timeout",
            timeoutMs
          })
        );
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      // onWritten is deliberately passed through to #write instead of running
      // before it; callers use it as the transport-written observation boundary.
      this.#write(
        { jsonrpc: "2.0", id, method, params },
        (error) => {
          const pending = this.#pending.get(id);
          if (!pending) return;
          this.#pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(error);
        },
        onWritten
      );
    });
  }

  /** Allocate the exact JSON-RPC id a subsequent request will put on the wire. */
  reserveRequestId(): RpcId {
    return this.#nextId++;
  }

  notify(method: string, params?: unknown): void {
    this.#write({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params })
    });
  }

  /**
   * R06b：父进程退出只结束 EOF 等待，不能代替本次受管组清理完成。
   * 重复 close 共享同一结果；保留已接纳终态，清理失败继续向调用方抛出。
   * .octospec/tasks/pr1-yujiawei-review/second-review.md
   */
  close(): Promise<void> {
    return (this.#closePromise ??= (async () => {
      this.#closed = true;
      this.#clearFinalizationTimer();
      if (this.#finalizationGraceTimer) clearTimeout(this.#finalizationGraceTimer);
      this.#closing = true;
      this.#signal?.removeEventListener("abort", this.#abortListener);
      if (this.#abortTimer) clearTimeout(this.#abortTimer);
      this.#reader.close();
      this.#removeLineGuard();
      this.#rejectPending(new Error("codex app-server closed"));
      this.#invalidateInteractions("execution_lost");
      try {
        if (!this.#exited) {
          this.#child.stdin.end();
          await waitForExit(this.#exitPromise, APP_SERVER_CLOSE_GRACE_MS);
        }
      } finally {
        // 即使 leader 早已退出或 EOF 已成功，仍确认后代消失并按需升级 KILL。
        await this.#cleanupProcess();
      }
    })());
  }

  errorMessage(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return this.#stderr.trim() ? `${raw}\n\n[codex stderr]\n${this.#stderr.trim()}` : raw;
  }

  processErrorMessage(exit: ProcessExit): string {
    const base = exit.signal
      ? `codex app-server exited on ${exit.signal}`
      : `codex app-server exited with code ${exit.code ?? -1}`;
    return this.#stderr.trim() ? `${base}: ${this.#stderr.trim()}` : base;
  }

  /** Dispatch one stdout frame. Ordering of the checks matters: a response may also lack a method. */
  #handleLine(line: string): void {
    const message = parseRecord(line);
    const bytes = Buffer.byteLength(line);
    if (bytes > this.#streamLimits.rawMessageMaxBytes && !this.#isBoundedInputEcho(message)) {
      const error = streamCapacityError("PROVIDER_MESSAGE_TOO_LARGE", {
        boundary: "codex.stdout",
        measuredBytes: bytes,
        limitBytes: this.#streamLimits.rawMessageMaxBytes
      });
      this.#rejectPending(error);
      this.#queue.fail(error);
      signalProcessTree(this.#child, "SIGTERM");
      return;
    }
    if (!message) return;
    const id = rpcId(message.id);
    if (id !== undefined && ("result" in message || "error" in message)) {
      this.#handleResponse(id, message);
      return;
    }
    const method = stringValue(message.method);
    if (!method) return;
    if (id !== undefined) {
      this.#handleServerRequest(id, method, recordValue(message.params) ?? {}, message);
      return;
    }
    const params = recordValue(message.params) ?? {};
    if (
      this.#native &&
      ((!this.#activeThreadId && method !== "thread/started") ||
        (this.#activeThreadId &&
          !params.threadId &&
          !recordValue(params.thread)?.id &&
          !notificationTurnId(params)))
    )
      return;
    if (!this.#acceptNotification(params)) return;
    this.#reportNotificationActivity(method, params);
    this.#watchFinalization(method, params);
    if (this.#native) {
      this.#queue.push({ kind: "native", messageKind: "notification", payload: message });
      if (method === "turn/completed") {
        this.#invalidateInteractions("run_terminal");
        this.#terminal = true;
        this.#clearFinalizationTimer();
        if (this.#finalizationGraceTimer) clearTimeout(this.#finalizationGraceTimer);
        const status = recordValue(params.turn)?.status;
        this.#queue.push({
          kind: "control",
          control: {
            type: "state",
            state:
              status === "completed"
                ? "completed"
                : status === "interrupted"
                  ? "cancelled"
                  : "failed"
          }
        });
        this.#queue.close();
      }
      return;
    }
    this.context?.reportConversion?.();
    for (const event of this.#normalizer!.normalize({ method, params })) {
      if (isTerminalEvent(event)) {
        this.#invalidateInteractions("run_terminal");
        this.#terminal = true;
        this.#clearFinalizationTimer();
        if (this.#finalizationGraceTimer) clearTimeout(this.#finalizationGraceTimer);
        this.#queue.push(
          this.#finalizationTimedOut && event.type !== "run.completed"
            ? this.#finalizationFailure()
            : event
        );
        this.#queue.close();
      } else this.#queue.push(event);
    }
  }

  #isBoundedInputEcho(message: JsonRecord | undefined): boolean {
    if (this.#native || !message) return false;
    const method = stringValue(message.method);
    const id = rpcId(message.id);
    const pending = id === undefined ? undefined : this.#pending.get(id);
    const item = recordValue(recordValue(message.params)?.item);
    const carrier =
      ((method === "item/started" || method === "item/completed") &&
        item?.type === "userMessage") ||
      ["turn/started", "turn/completed", "codex/event/user_message"].includes(method ?? "") ||
      (pending && ["thread/start", "thread/resume", "turn/start"].includes(pending.method));
    if (!carrier) return false;
    const images = new Set(
      [
        ...(this.invocation.modelInputParts ?? []),
        ...(this.invocation.freshFallbackModelInputParts ?? [])
      ]
        .filter((part) => part.type === "image")
        .map((part) => `data:${part.mimeType};base64,${part.data}`)
    );
    let matched = false;
    // Only identical submitted image URLs are exempt from canonical event sizing.
    // The original provider message still reaches the normalizer unchanged.
    const withoutEcho = (value: unknown, depth = 0): unknown => {
      if (depth > 64) throw new Error("JSON_DEPTH_EXCEEDED");
      if (typeof value === "string" && images.has(value)) {
        matched = true;
        return "[submitted image]";
      }
      if (Array.isArray(value)) return value.map((item) => withoutEcho(item, depth + 1));
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, withoutEcho(item, depth + 1)])
        );
      return value;
    };
    try {
      assertJsonByteLimit(
        withoutEcho(message),
        this.#streamLimits.rawMessageMaxBytes,
        "PROVIDER_MESSAGE_TOO_LARGE"
      );
      return matched;
    } catch {
      return false;
    }
  }

  #handleResponse(id: RpcId, message: JsonRecord): void {
    // A late response arriving after timeout has no pending entry; drop it so it cannot pollute the next request.
    const pending = this.#pending.get(id);
    if (!pending) return;
    if (
      this.#native &&
      ["thread/start", "thread/resume", "turn/start", "turn/interrupt"].includes(pending.method)
    )
      this.#queue.push({ kind: "native", messageKind: "response", payload: message });
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    this.context?.reportActivity?.({ kind: "transport_response", method: "rpc_response" });
    const error = recordValue(message.error);
    if (error) {
      pending.reject(
        new CodexAppServerRpcError(
          pending.method,
          numberValue(error.code) ?? -32000,
          stringValue(error.message) || "unknown app-server error",
          error.data
        )
      );
      return;
    }
    pending.resolve(message.result);
  }

  #handleServerRequest(id: RpcId, method: string, params: JsonRecord, message: JsonRecord): void {
    this.#clearFinalizationTimer();
    const kind = interactionKind(method);
    if (!kind) {
      this.#rejectServerRequest(id, method);
      return;
    }
    if (this.#terminal || this.#closed || this.#exited) {
      this.#write({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: "invocation is no longer active" }
      });
      return;
    }
    if (
      this.#native &&
      (!this.#acceptNotification(params) ||
        this.#nativeRequestIds.has(id) ||
        this.#nativeRequestIds.size >= 4096)
    ) {
      this.#write({
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "request does not belong to a new active interaction" }
      });
      return;
    }
    if (this.#native) this.#nativeRequestIds.add(id);

    if (method === "item/permissions/requestApproval") {
      this.#rejectServerRequest(id, method);
      this.#queue.fail(new Error("APPROVAL_GRANT_SCOPE_UNSUPPORTED"));
      return;
    }
    if (this.#interactions.size >= 16) {
      this.#rejectServerRequest(id, method);
      this.#queue.fail(new Error("APPROVAL_PENDING_LIMIT_EXCEEDED"));
      return;
    }
    const interactionId = codexInteractionId(
      id,
      this.invocation.invocationId,
      this.#nextInteractionId++
    );
    if ([...this.#interactions.values()].some((pending) => pending.rpcId === id)) {
      this.#write({
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "duplicate provider interaction id" }
      });
      return;
    }
    const expiresAt = Date.now() + 600_000;
    const timer = setTimeout(() => {
      this.#interactions.delete(interactionId);
      this.#interactionState(interactionId, id, "expired", "approval_timeout");
      this.#rejectServerRequest(id, method);
      this.#queue.fail(new Error("INTERACTION_EXPIRED"));
    }, 600_000);
    timer.unref?.();
    this.#interactions.set(interactionId, {
      rpcId: id,
      method,
      params,
      responding: false,
      timer,
      expiresAt
    });
    if (this.#native) {
      this.#queue.push({ kind: "native", messageKind: "request", payload: message });
      this.#queue.push({
        kind: "control",
        control: { type: "interaction", requestId: id, status: "pending", expiresAt }
      });
    } else {
      const display = displaySafeInteractionRequest(method, params);
      this.#queue.push({
        protocolVersion: 2,
        type: "interaction.requested",
        payload: {
          interactionId,
          kind,
          executionInstanceId: this.invocation.invocationId,
          expiresAt: new Date(expiresAt).toISOString(),
          request:
            kind === "approval"
              ? {
                  schema: "octo.approval-request/v1",
                  policy: {
                    mode: this.invocation.approvalMode,
                    hash: contextHash(this.invocation.context)
                  },
                  operation: {
                    kind:
                      method.includes("fileChange") || method === "applyPatchApproval"
                        ? "file_change"
                        : "command_execution",
                    summary:
                      typeof display.command === "string" && display.command
                        ? Array.from(display.command).slice(0, 500).join("")
                        : "Approve provider operation",
                    ...(typeof params.itemId === "string" ? { toolCallId: params.itemId } : {})
                  },
                  requestedPermissions: [],
                  allowedOutcomes: ["accepted", "declined", "cancelled"],
                  grantScope: "request",
                  providerDetails: display
                }
              : display
        }
      });
    }
    if (!this.#interactive && kind === "approval") {
      const automatic = automaticServerRequestResult(method);
      if (automatic === undefined) {
        this.#rejectServerRequest(id, method);
        this.#invalidateInteractions("approval_mapping_unsupported");
        this.#queue.fail(new Error("APPROVAL_OPERATION_UNSUPPORTED"));
        return;
      }
      this.#interactions.get(interactionId)!.responding = true;
      this.#write(
        { jsonrpc: "2.0", id, result: automatic },
        (error) => {
          this.#invalidateInteractions("response_delivery_failed");
          this.#queue.fail(error);
        },
        () => {
          const pending = this.#interactions.get(interactionId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.#interactions.delete(interactionId);
          this.#interactionState(interactionId, id, "resolved", "full_access_policy");
        }
      );
    }
  }

  #rejectServerRequest(id: RpcId, method: string): void {
    // Unknown server requests must be answered with an error, otherwise Codex waits forever on that JSON-RPC ID.
    this.#write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `unhandled server request: ${method}` }
    });
  }

  #write(message: JsonRecord, onError?: (error: Error) => void, onWritten?: () => void): void {
    if (this.#transportFailure) {
      onError?.(this.#transportFailure);
      return;
    }
    if (this.#closed || this.#exited) {
      onError?.(new Error("codex app-server is closed"));
      return;
    }
    let line: string;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.#child.stdin.write(line, (error) => {
      // Writable completion means local acceptance of the bytes. Only a later
      // frame with the same JSON-RPC id can acknowledge a request.
      if (error) onError?.(error);
      else onWritten?.();
    });
  }

  #acceptNotification(params: JsonRecord): boolean {
    // During initialize there is no active thread yet, so global notifications are allowed; afterward other threads are filtered out.
    if (!this.#activeThreadId) return true;
    const threadId = stringValue(params.threadId);
    if (threadId && threadId !== this.#activeThreadId) return false;
    const turnId = notificationTurnId(params);
    return !this.#activeTurnId || !turnId || turnId === this.#activeTurnId;
  }

  #reportNotificationActivity(method: string, params: JsonRecord): void {
    if (this.#terminal || !this.#activeThreadId) return;
    const turnId = notificationTurnId(params);
    if (!this.#activeTurnId && method === "turn/started" && turnId) this.setActiveTurn(turnId);
    if (!this.#activeTurnId) return;
    // Progress must belong to this turn. Thread-scoped token usage is a
    // documented exception and is accepted only when its total advances.
    if (turnId !== this.#activeTurnId && method !== "thread/tokenUsage/updated") return;
    if (method === "error" && params.willRetry === true) {
      this.context?.reportActivity?.({ kind: "retry_notice", method: "retry" });
    } else if (method === "thread/tokenUsage/updated") {
      if (stringValue(params.threadId) !== this.#activeThreadId) return;
      const total = recordValue(recordValue(params.tokenUsage)?.total);
      const tokens = numberValue(total?.totalTokens);
      if (tokens !== undefined && Number.isSafeInteger(tokens) && tokens > this.#lastUsage) {
        this.#lastUsage = tokens;
        this.context?.reportActivity?.({ kind: "turn_progress", method: "usage" });
      }
    } else if (
      [
        "item/agentMessage/delta",
        "item/reasoning/summaryTextDelta",
        "item/reasoning/textDelta",
        "item/plan/delta"
      ].includes(method) &&
      stringValue(params.delta)
    ) {
      this.context?.reportActivity?.({ kind: "turn_progress", method: "text_delta" });
    } else if (
      (((["item/commandExecution/outputDelta", "item/fileChange/outputDelta"].includes(method) ||
        isToolArgsDeltaMethod(method)) &&
        stringValue(params.delta)) ||
        (method === "item/mcpToolCall/progress" && stringValue(params.message))) &&
      itemId(params)
    ) {
      this.context?.reportActivity?.({
        kind: "turn_progress",
        method: "tool_delta",
        toolCallId: itemId(params)
      });
    } else if (method === "item/started" || method === "item/completed") {
      const item = recordValue(params.item);
      const id = stringValue(item?.id);
      if (
        !id ||
        !item ||
        !(
          ["agentMessage", "reasoning", "plan"].includes(stringValue(item.type)) ||
          toolDescriptor(item)
        )
      )
        return;
      const key = `${method}:${id}`;
      if (this.#seenItems.has(key)) return;
      if (this.#seenItems.size >= 4096)
        this.#seenItems.delete(this.#seenItems.values().next().value!);
      this.#seenItems.add(key);
      this.context?.reportActivity?.({
        kind: "turn_progress",
        method: "item_lifecycle",
        ...(toolDescriptor(item)
          ? { toolCallId: id, toolState: method === "item/started" ? "started" : "completed" }
          : {})
      });
    }
  }

  #handleProcessError(error: Error): void {
    if (this.#transportFailure) return;
    this.#transportFailure = error;
    this.#reader.close();
    this.#clearFinalizationTimer();
    this.#rejectPending(error);
    this.#invalidateInteractions("execution_lost");
    if (!this.#closing && !this.#terminal) this.#queue.fail(error);
  }

  #handleExit(exit: ProcessExit): void {
    this.#clearFinalizationTimer();
    if (this.#exited) return;
    this.#exited = true;
    this.#resolveExit(exit);
    const error = new CodexAppServerProcessError(this.processErrorMessage(exit), exit);
    this.#rejectPending(error);
    this.#invalidateInteractions("execution_lost");
    if (!this.#closing && !this.#terminal) this.#queue.fail(error);
  }

  #invalidateInteractions(reasonCode: string): void {
    for (const [interactionId, pending] of this.#interactions) {
      clearTimeout(pending.timer);
      this.#interactionState(interactionId, pending.rpcId, "invalidated", reasonCode);
    }
    this.#interactions.clear();
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): ChildProcessWithoutNullStreams {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: process.platform === "win32"
  });
  if (process.platform !== "win32") isolatedProcessGroups.add(child);
  return child;
}

const isolatedProcessGroups = new WeakSet<ChildProcessWithoutNullStreams>();

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (isolatedProcessGroups.has(child) && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  child.kill(signal);
}

/** Shared params for thread/start and thread/resume; the permission policy is fixed at the thread level. */
function threadParams(
  request: InvokeRequest,
  extra: JsonRecord,
  environmentConfig?: JsonRecord
): JsonRecord {
  return {
    ...extra,
    cwd: request.workdir,
    ...(request.agentConfig.model ? { model: request.agentConfig.model } : {}),
    sandbox: codexSandbox(request),
    // Dynamic MCP tools are untrusted until Codex asks the client to approve them. `never`
    // rejects those calls before the existing reverse-request handler can answer them.
    approvalPolicy: request.approvalMode === "assisted" ? "on-request" : "untrusted",
    ...(environmentConfig ? { config: environmentConfig } : {}),
    ...(extra.threadId ? {} : { developerInstructions: request.controlInstructions })
  };
}

/**
 * turn/start carries this turn's input plus the per-turn overridable model,
 * effort and reasoning summary. The summary must be sent explicitly: setting only
 * effort still consumes reasoning tokens, but the app-server does not guarantee
 * publishing summaryTextDelta, so a UI might see only an empty analysis lifecycle.
 */
function turnParams(request: InvokeRequest, threadId: string, freshFallback = false): JsonRecord {
  const effort = mapReasoningEffort("codex", request.agentConfig.effort);
  return {
    threadId,
    input: [
      ...providerInputParts(request, freshFallback).map((part) =>
        part.type === "image"
          ? { type: "image", url: `data:${part.mimeType};base64,${part.data}` }
          : { type: "text", text: part.text, text_elements: [] }
      )
    ],
    cwd: request.workdir,
    ...(request.agentConfig.model ? { model: request.agentConfig.model } : {}),
    ...(effort ? { effort } : {}),
    summary: codexReasoningSummary(request)
  };
}

/**
 * The app-server will not automatically publish reasoning summary deltas just
 * because effort was set. Chat requests auto by default; callers can tighten or
 * disable it via providerOptions.reasoningSummary.
 */
function codexReasoningSummary(request: InvokeRequest): string {
  const configured = recordValue(request.agentConfig.providerOptions)?.reasoningSummary;
  const value = typeof configured === "string" ? configured : "auto";
  if (!["auto", "concise", "detailed", "none"].includes(value)) {
    throw new Error(`unsupported Codex reasoning summary: ${value}`);
  }
  return value;
}

function codexSandbox(request: InvokeRequest): string {
  const value =
    request.approvalMode === "full_access"
      ? "danger-full-access"
      : (request.agentConfig.sandbox ?? "workspace-write");
  if (!["read-only", "workspace-write", "danger-full-access"].includes(value)) {
    throw new Error(`unsupported Codex sandbox mode: ${value}`);
  }
  if (request.approvalMode !== "full_access" && value === "danger-full-access")
    throw new Error("APPROVAL_SANDBOX_CONFLICT");
  return value;
}

function appServerRequestTimeout(request: InvokeRequest): number {
  const configured = recordValue(request.agentConfig.providerOptions)?.appServerRequestTimeoutMs;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? configured
    : APP_SERVER_REQUEST_TIMEOUT_MS;
}

/**
 * Text deltas preserve provider arrival order. Analysis deltas additionally carry
 * an adapter-signed exposure classification so a presentation can fail closed.
 */
function textDelta(
  params: JsonRecord,
  channel: MessageChannel,
  exposure?: MessageExposure,
  nativeEvent?: string,
  stepId?: string
): CanonicalEvent[] {
  const text = stringValue(params.delta);
  if (!text) return [];
  const id = itemId(params);
  return [
    {
      protocolVersion: 2,
      type: "message.delta",
      payload: {
        text,
        channel,
        ...(id ? { messageId: id } : {}),
        ...(stepId ? { stepId } : {}),
        ...(exposure && nativeEvent
          ? {
              exposure,
              provenance: { provider: "codex", nativeEvent }
            }
          : {})
      }
    }
  ];
}

/** usage carries both this turn's increment (last) and the provider cumulative value (total). */
function usageEvents(params: JsonRecord): CanonicalEvent[] {
  const tokenUsage = recordValue(params.tokenUsage);
  const last = recordValue(tokenUsage?.last);
  const total = recordValue(tokenUsage?.total);
  if (!last && !total) return [];
  return [
    {
      protocolVersion: 2,
      type: "usage.update",
      payload: {
        ...(last ?? total ?? {}),
        ...(total ? { cumulative: total } : {}),
        ...(typeof tokenUsage?.modelContextWindow === "number"
          ? { modelContextWindow: tokenUsage.modelContextWindow }
          : {})
      }
    }
  ];
}

/** item started only creates the lifecycle object; it does not guess the final output here. */
function itemStartedEvents(item: JsonRecord | undefined, stepId?: string): CanonicalEvent[] {
  if (!item) return [];
  const type = stringValue(item.type);
  const id = stringValue(item.id);
  if (type === "agentMessage") {
    const channel = agentMessageChannel(item);
    return [
      {
        protocolVersion: 2,
        type: "message.create",
        payload: {
          role: "assistant",
          status: "streaming",
          channel,
          ...(id ? { messageId: id } : {}),
          ...(stepId ? { stepId } : {})
        }
      }
    ];
  }
  if (type === "reasoning" || type === "plan") {
    const exposure: MessageExposure = type === "plan" ? "public_plan" : "unknown";
    return [
      {
        protocolVersion: 2,
        type: "message.create",
        payload: {
          role: "assistant",
          status: "streaming",
          channel: "analysis",
          exposure,
          provenance: { provider: "codex", nativeEvent: "item/started" },
          ...(id ? { messageId: id } : {}),
          ...(stepId ? { stepId } : {})
        }
      }
    ];
  }
  const tool = toolDescriptor(item);
  return tool
    ? [
        {
          protocolVersion: 2,
          type: "tool_call.create",
          payload: {
            status: "running",
            id: tool.id,
            name: tool.name,
            args: tool.args,
            ...(stepId ? { stepId } : {})
          }
        }
      ]
    : [];
}

/** item completed closes the corresponding message/tool lifecycle and attaches the provider's final snapshot. */
function itemCompletedEvents(
  item: JsonRecord | undefined,
  stepId?: string,
  knownChannel?: MessageChannel
): CanonicalEvent[] {
  if (!item) return [];
  const type = stringValue(item.type);
  const id = stringValue(item.id);
  if (type === "agentMessage") {
    const channel = knownChannel ?? agentMessageChannel(item);
    return [
      {
        protocolVersion: 2,
        type: "message.update",
        payload: {
          role: "assistant",
          status: "completed",
          channel,
          ...(id ? { messageId: id } : {}),
          ...(stepId ? { stepId } : {}),
          ...(typeof item.text === "string" ? { text: item.text } : {})
        }
      }
    ];
  }
  if (type === "reasoning" || type === "plan") {
    const exposure: MessageExposure = type === "plan" ? "public_plan" : "public_summary";
    const text =
      type === "plan" ? stringValue(item.text) : stringArray(item.summary).join("\n") || undefined;
    return [
      {
        protocolVersion: 2,
        type: "message.update",
        payload: {
          role: "assistant",
          status: "completed",
          channel: "analysis",
          exposure,
          provenance: { provider: "codex", nativeEvent: "item/completed" },
          ...(id ? { messageId: id } : {}),
          ...(stepId ? { stepId } : {}),
          ...(text ? { text } : {})
        }
      }
    ];
  }
  const tool = toolDescriptor(item);
  if (!tool) return [];
  return [
    {
      protocolVersion: 2,
      type: "tool_call.update",
      payload: {
        id: tool.id,
        status: canonicalTerminalStatus(toolStatus(item)),
        output: toolOutput(item),
        ...(stepId ? { stepId } : {}),
        ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {})
      }
    }
  ];
}

// Codex exposes its UI phase on agentMessage items. Normalize that provider
// detail here so every downstream consumer sees only the shared channel model.
function agentMessageChannel(item: JsonRecord | undefined): MessageChannel {
  return stringValue(item?.phase) === "commentary" ? "commentary" : "final";
}

/** One-to-one mapping from a Codex turn terminal to an Octo Runtime run terminal. */
function turnCompletedEvents(turn: JsonRecord | undefined): CanonicalEvent[] {
  const status = stringValue(turn?.status);
  if (status === "interrupted") {
    return [{ protocolVersion: 2, type: "run.cancelled", payload: { reason: "interrupted" } }];
  }
  if (status === "failed") {
    const error = recordValue(turn?.error);
    return [
      {
        protocolVersion: 2,
        type: "run.failed",
        payload: {
          message: stringValue(error?.message) || "Codex turn failed",
          ...codexFailureDetails(error),
          ...(error ? { error } : {})
        }
      }
    ];
  }
  return [{ protocolVersion: 2, type: "run.completed", payload: {} }];
}

/** 仅转换 Provider 的结构化故障事实；是否自动重跑由 Extra 决定。 */
function codexFailureDetails(error: JsonRecord | undefined): JsonRecord {
  const info = error?.codexErrorInfo;
  if (info === "rateLimitExceeded") return { httpStatus: 429 };
  if (info === "serverOverloaded") return { httpStatus: 503 };
  if (info === "internalServerError") return { httpStatus: 500 };
  if (info === "unauthorized") return { httpStatus: 401 };
  if (info === "usageLimitExceeded") return { code: "PROVIDER_QUOTA_EXHAUSTED" };
  const detail = recordValue(info);
  for (const kind of [
    "httpConnectionFailed",
    "responseStreamConnectionFailed",
    "responseStreamDisconnected",
    "responseTooManyFailedAttempts"
  ]) {
    const value = recordValue(detail?.[kind]);
    if (!value) continue;
    const status = numberValue(value.httpStatusCode);
    return {
      ...(status === undefined || status >= 500 || status === 429
        ? { code: "PROVIDER_UNAVAILABLE" }
        : {}),
      ...(status !== undefined ? { httpStatus: status } : {})
    };
  }
  return {};
}

/**
 * Flatten the various Codex items into an Octo Runtime tool descriptor.
 *
 * name is the cross-provider display/lookup key; args preserve the structured raw
 * fields as much as possible. An unknown item returns undefined rather than
 * impersonating a tool, avoiding the Core persisting an unexplainable lifecycle.
 */
function toolDescriptor(
  item: JsonRecord
): { id: string; name: string; args: JsonRecord } | undefined {
  const id = stringValue(item.id);
  if (!id) return undefined;
  switch (stringValue(item.type)) {
    case "commandExecution":
      return {
        id,
        name: "exec_command",
        args: {
          command: stringValue(item.command),
          ...(stringValue(item.cwd) ? { cwd: stringValue(item.cwd) } : {})
        }
      };
    case "fileChange":
      return { id, name: "apply_patch", args: { changes: item.changes ?? [] } };
    case "mcpToolCall": {
      const server = stringValue(item.server);
      const tool = stringValue(item.tool) || "tool";
      return {
        id,
        name: server ? `mcp__${server}__${tool}` : tool,
        args: recordValue(item.arguments) ?? { value: item.arguments }
      };
    }
    case "dynamicToolCall": {
      const namespace = stringValue(item.namespace);
      const tool = stringValue(item.tool) || "tool";
      return {
        id,
        name: namespace ? `${namespace}__${tool}` : tool,
        args: recordValue(item.arguments) ?? { value: item.arguments }
      };
    }
    case "collabAgentToolCall":
      return { id, name: stringValue(item.tool) || "collab_agent", args: { ...item } };
    case "webSearch":
      return { id, name: "web_search", args: { ...item } };
    case "imageView":
      return { id, name: "view_image", args: { path: item.path } };
    case "imageGeneration":
      return { id, name: "image_generation", args: { ...item } };
    case "sleep":
      return { id, name: "sleep", args: { ...item } };
    default:
      return undefined;
  }
}

/** Codex uses inProgress; the Octo Runtime canonical contract uses running. */
function toolStatus(item: JsonRecord): string {
  const status = stringValue(item.status);
  if (status === "inProgress") return "running";
  if (status === "failed" && isRipgrepNoMatch(item)) return "completed";
  return status || "completed";
}

/** ripgrep uses exit 1 for a successful search with no matches, not an execution error. */
function isRipgrepNoMatch(item: JsonRecord): boolean {
  if (stringValue(item.type) !== "commandExecution" || item.exitCode !== 1) return false;
  if (stringValue(item.aggregatedOutput).trim() !== "") return false;

  let command = stringValue(item.command).trim();
  const wrapped = command.match(/^(?:\S+\/)?(?:sh|bash|zsh)\s+-\S*c\s+(["'])([\s\S]*)\1$/);
  if (wrapped) command = wrapped[2].trim();

  const finalCommand = command.split("&&").at(-1)?.trim() ?? "";
  return /^(?:command\s+)?(?:[^\s"'`]+\/)?rg(?:\s|$)/.test(finalCommand);
}

/** Extract compact output for common tools; other tools keep the full item as a forward-compatible fallback. */
function toolOutput(item: JsonRecord): unknown {
  switch (stringValue(item.type)) {
    case "commandExecution":
      return item.aggregatedOutput ?? "";
    case "fileChange":
      return item.changes ?? [];
    case "mcpToolCall":
      return item.error ?? item.result ?? null;
    case "dynamicToolCall":
      return item.contentItems ?? null;
    default:
      return item;
  }
}

// Response shapes differ slightly across app-server versions, so the ID extractor accepts both top-level and nested fields.
function extractThreadId(value: unknown): string {
  const result = recordValue(value);
  const thread = recordValue(result?.thread);
  return (
    stringValue(result?.threadId) ||
    stringValue(result?.sessionId) ||
    stringValue(thread?.id) ||
    stringValue(thread?.sessionId)
  );
}

function extractTurnId(value: unknown): string {
  const result = recordValue(value);
  return stringValue(result?.turnId) || stringValue(recordValue(result?.turn)?.id);
}

function itemId(params: JsonRecord): string {
  return (
    stringValue(params.itemId) ||
    stringValue(params.callId) ||
    stringValue(recordValue(params.item)?.id)
  );
}

function notificationTurnId(params: JsonRecord): string {
  return stringValue(params.turnId) || stringValue(recordValue(params.turn)?.id);
}

function turnStepStatus(turn: JsonRecord | undefined): string {
  switch (stringValue(turn?.status)) {
    case "failed":
      return "failed";
    case "interrupted":
      return "cancelled";
    default:
      return "completed";
  }
}

function isToolArgsDeltaMethod(method: string): boolean {
  // Only accept known item namespaces, to avoid misprojecting an unrelated delta as tool arguments.
  return /^item\/(?:functionCall|toolCall|mcpToolCall|dynamicToolCall)\/(?:argumentsDelta|argsDelta|inputDelta|parametersDelta)$/.test(
    method
  );
}

function isTerminalEvent(event: CanonicalEvent): boolean {
  return (
    event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled"
  );
}

function isThreadNotFound(error: unknown): boolean {
  return error instanceof Error && /thread not found/i.test(error.message);
}

function rpcFailureReason(error: unknown): string {
  // The side channel stores only a low-cardinality classification, not the full provider error which may contain paths/credentials, into the session.
  const message = error instanceof Error ? error.message : String(error);
  return /rollout path/i.test(message) ? "rollout_path_missing" : "resume_rejected";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason ?? "cancelled"));
}

function parseRecord(line: string): JsonRecord | undefined {
  try {
    return recordValue(JSON.parse(line));
  } catch {
    // Occasional non-protocol text on stdout must not blow up the whole run; real diagnostics are still appended to the error from stderr.
    return undefined;
  }
}

function recordValue(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function rpcId(value: unknown): RpcId | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

async function waitForExit(exit: Promise<ProcessExit>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    exit.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

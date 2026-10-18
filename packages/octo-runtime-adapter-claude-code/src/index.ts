import {
  initialControlInstructions,
  hasImageInput,
  invocationEnvironment,
  invocationMcpServers,
  assertMcpOptions,
  actmodeEvidence,
  mapReasoningEffort
} from "@mininglamp-oss/octo-runtime-adapter-sdk";
import { canonicalTerminalStatus, contextActmode } from "@mininglamp-oss/octo-runtime-protocol";
/**
 * Claude Code local CLI transport and event normalization layer.
 *
 * Production invocations always enable stream-json partial messages. Claude
 * first sends a content block's start/delta, then replays the same block as a
 * complete assistant snapshot; the adapter only publishes the former, otherwise
 * Chat would see duplicated text and duplicated tool calls. A tool-args delta
 * carries no tool_use id of its own, so every invocation must own an
 * independent ClaudeEventNormalizer state.
 */
import {
  AcpApprovalBridge,
  NativeInteractionBridge,
  type AdapterOutput,
  type AdapterInvocationContext,
  defineAdapter,
  parseJsonLine,
  probeCommand,
  providerInputText,
  spawnJsonLines,
  type CanonicalEvent,
  type InvokeRequest,
  type MessageExposure
} from "@mininglamp-oss/octo-runtime-adapter-sdk";
import {
  protocolError,
  type InteractionResponse,
  type NativeInteractionResponse
} from "@mininglamp-oss/octo-runtime-protocol";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_STEP_PUBLIC_TEXT_CHARS = 1_000;

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface ClaudeStreamEvent {
  type?: string;
  index?: number;
  message?: { id?: string };
  content_block?: ClaudeContentBlock;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
}

interface ClaudeNativeEvent {
  [key: string]: unknown;
  type?: string;
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  event?: ClaudeStreamEvent;
  message?: { id?: string; content?: ClaudeContentBlock[] };
  usage?: Record<string, unknown>;
  is_error?: boolean;
  result?: string;
  request_id?: string;
  request?: {
    subtype?: string;
    tool_name?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
  };
}

/**
 * Build the Claude CLI argv and stdin for one invocation.
 *
 * The system/control prompt is written to a private temp file passed via
 * `--append-system-prompt-file`, while the user prompt stays on stdin, so the
 * two never get conflated. Returns a `cleanup` that removes the temp directory.
 */
export async function buildClaudeCommand(
  req: InvokeRequest,
  command = "claude",
  commandArgsPrefix: string[] = []
) {
  if (hasImageInput(req))
    throw new Error("UNSUPPORTED_INPUT_MODALITY: claude-code does not encode image input");
  const mode =
    contextActmode(req.context) === "plan" ? "plan" : claudePermissionMode(req.approvalMode);
  const servers = invocationMcpServers(req);
  assertMcpOptions(servers, "claude-code", []);
  // Native Claude expands placeholders again at connection time. Reject values
  // it cannot preserve instead of silently changing a resolved literal/token.
  if (Object.values(servers).some((server) => JSON.stringify(server).includes("${")))
    throw new Error(
      "MCP_LITERAL_UNSUPPORTED: claude-code cannot preserve resolved placeholder text"
    );
  const directory = await mkdtemp(join(tmpdir(), "octo-runtime-claude-"));
  const promptFile = join(directory, "system-prompt.txt");
  // The control prompt goes through Claude's dedicated file argument while the
  // user prompt is still fed via stdin, so the two never get conflated.
  await writeFile(promptFile, initialControlInstructions(req), { mode: 0o600 });
  if (Object.keys(servers).length) {
    const mcpFile = join(directory, "mcp.json");
    const mcpServers = Object.fromEntries(
      Object.entries(servers).map(([name, server]) => [
        name,
        server.type === "stdio"
          ? {
              type: "stdio",
              command: server.command,
              args: server.args ?? [],
              env: server.env ?? {}
            }
          : { type: "http", url: server.url, headers: server.headers ?? {} }
      ])
    );
    await writeFile(mcpFile, JSON.stringify({ mcpServers }), { mode: 0o600 });
    commandArgsPrefix = [...commandArgsPrefix, "--mcp-config", mcpFile];
  }
  // Only --include-partial-messages produces thinking/text/input_json deltas;
  // plain stream-json still delivers whole assistant blocks, which cannot
  // satisfy the local Chat's real-time streaming requirement.
  const args = [
    ...commandArgsPrefix,
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...(initialControlInstructions(req) ? ["--append-system-prompt-file", promptFile] : [])
  ];
  if (req.providerSession?.sessionId) args.push("--resume", req.providerSession.sessionId);
  if (req.agentConfig?.model) args.push("--model", req.agentConfig.model);
  const effort = mapReasoningEffort("claude-code", req.agentConfig?.effort);
  if (effort) args.push("--effort", effort);
  args.push("--permission-mode", mode);
  args.push("--permission-prompt-tool", "stdio");
  if (mode === "bypassPermissions") args.push("--dangerously-skip-permissions");
  const input = `${JSON.stringify({ type: "user", session_id: req.providerSession?.sessionId ?? "", message: { role: "user", content: providerInputText(req) }, parent_tool_use_id: null })}\n`;
  return {
    command,
    args,
    input,
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

export function claudePermissionMode(mode: InvokeRequest["approvalMode"]): string {
  switch (mode) {
    case "ask":
      return "default";
    case "assisted":
      return "auto";
    case "full_access":
      return "bypassPermissions";
    default:
      throw new Error("APPROVAL_MODE_UNSUPPORTED");
  }
}

/**
 * Translates Claude's native stream into canonical events for one invocation.
 *
 * In the partial stream a tool-args delta carries only its block index, not a
 * repeated tool_use id, so the normalizer must map index -> id per invocation;
 * sharing one instance globally would cross-wire concurrent Runs.
 */
export class ClaudeEventNormalizer {
  #compactionNumber = 0;
  /** Once a partial arrives, later assistant snapshots and result text are treated as duplicate snapshots. */
  #sawPartialMessages = false;
  /** Claude repeats system/status on every tool turn; publish the session id to Core only once per session. */
  #publishedSessionId?: string;
  /** parent tool scope -> content block index -> tool_use id, so concurrent sub-tasks cannot collide on index. */
  readonly #toolBlocks = new Map<string, Map<number, string>>();
  /** parent tool scope -> provider message id, used to give each thinking phase a stable public item identity. */
  readonly #messageIds = new Map<string, string>();
  /** parent tool scope -> native stop reason for the current provider model round. */
  readonly #finishReasons = new Map<string, string>();
  /** parent tool scope -> bounded text already emitted on the public final channel during this round. */
  readonly #publicTexts = new Map<string, string>();
  /** parent tool scope -> content block index -> public thinking item id. */
  readonly #thinkingBlocks = new Map<string, Map<number, string>>();
  readonly #textBlocks = new Map<string, Map<number, string>>();
  readonly #completedMessages = new Set<string>();
  /** tool_use id -> provider model round, retained until Claude reports the tool result. */
  readonly #toolSteps = new Map<string, string>();
  #messageSequence = 0;

  /** Return canonical events in stdout arrival order; this method neither buffers a whole turn nor reorders events. */
  normalize(native: ClaudeNativeEvent): CanonicalEvent[] {
    // compact_boundary 是历史已被 Provider 压缩的确认；不得据此重发当前用户 turn。
    if (native.type === "system" && native.subtype === "compact_boundary" && native.session_id) {
      return [
        {
          protocolVersion: 2,
          type: "run.notice",
          payload: {
            noticeId: `claude:compaction:${native.session_id}:${++this.#compactionNumber}`,
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
              sessionId: native.session_id,
              resumable: true,
              resumeOutcome: "compacted"
            }
          }
        }
      ];
    }
    if (native.type === "system" && native.session_id) {
      if (native.session_id === this.#publishedSessionId) return [];
      this.#publishedSessionId = native.session_id;
      return [
        {
          protocolVersion: 2,
          type: "session.update",
          payload: { providerSession: { sessionId: native.session_id, resumable: true } }
        }
      ];
    }

    if (native.type === "stream_event") {
      this.#sawPartialMessages = true;
      return this.#normalizePartial(native);
    }

    if (native.type === "assistant") {
      // --include-partial-messages replays the complete block after the delta; do not emit it again.
      if (this.#sawPartialMessages) return [];
      const events: CanonicalEvent[] = [];
      const stepId = native.message?.id ?? `claude:message-${++this.#messageSequence}`;
      if (this.#completedMessages.has(stepId)) return [];
      this.#completedMessages.add(stepId);
      for (const [index, block] of (native.message?.content ?? []).entries()) {
        if (block.type === "text" && block.text) {
          events.push({
            protocolVersion: 2,
            type: "message.update",
            payload: {
              messageId: `claude:${stepId}:text:${index}`,
              stepId,
              status: "completed",
              text: block.text,
              channel: "final"
            }
          });
        }
        if (block.type === "thinking" && block.thinking) {
          events.push({
            protocolVersion: 2,
            type: "message.update",
            payload: {
              messageId: `claude:${stepId}:thinking:${index}`,
              stepId,
              status: "completed",
              text: block.thinking,
              ...claudeAnalysisMetadata("public_reasoning", "assistant.content.thinking")
            }
          });
        }
        if (block.type === "tool_use" && block.id && block.name) {
          events.push({
            protocolVersion: 2,
            type: "tool_call.create",
            payload: { status: "running", id: block.id, name: block.name, args: block.input ?? {} }
          });
        }
      }
      return events;
    }

    if (native.type === "user") {
      const events: CanonicalEvent[] = [];
      for (const block of native.message?.content ?? []) {
        if (block.type !== "tool_result" || !block.tool_use_id) continue;
        const output = claudeToolResultOutput(block.content);
        const stepId = this.#toolSteps.get(block.tool_use_id);
        events.push({
          protocolVersion: 2,
          type: "tool_call.update",
          payload: {
            id: block.tool_use_id,
            status: canonicalTerminalStatus(block.is_error ? "error" : "completed"),
            ...(stepId ? { stepId } : {}),
            ...(output === undefined ? {} : { output }),
            ...(block.is_error
              ? {
                  error: {
                    message: typeof output === "string" ? output : "Claude tool call failed"
                  }
                }
              : {})
          }
        });
        this.#toolSteps.delete(block.tool_use_id);
      }
      return events;
    }

    if (native.type === "result") {
      const events = this.#finishActiveSteps(native.is_error ? "failed" : "completed");
      events.push(
        { protocolVersion: 2, type: "usage.update", payload: native.usage ?? {} },
        {
          protocolVersion: 2,
          type: "message.update",
          payload: {
            role: "assistant",
            status: native.is_error ? "failed" : "completed",
            channel: "final",
            // Partial mode already delivered all visible text incrementally; overwriting here would drop pre-tool progress in the UI.
            ...(!this.#sawPartialMessages && typeof native.result === "string"
              ? { text: native.result }
              : {})
          }
        },
        {
          protocolVersion: 2,
          type: native.is_error ? "run.failed" : "run.completed",
          payload: native.is_error
            ? {
                message:
                  native.result ||
                  (Array.isArray(native.errors)
                    ? native.errors
                        .filter((error): error is string => typeof error === "string")
                        .join("\n")
                    : "") ||
                  "Claude Code failed",
                error: {
                  ...(native.subtype ? { subtype: native.subtype } : {}),
                  ...(native.errors ? { errors: native.errors } : {})
                }
              }
            : {}
        }
      );
      return events;
    }
    return [];
  }

  #normalizePartial(native: ClaudeNativeEvent): CanonicalEvent[] {
    const event = native.event;
    if (!event) return [];
    const scope = native.parent_tool_use_id ?? "root";

    if (event.type === "message_start") {
      const events = this.#finishStep(scope, "completed");
      // A block index is only stable within one provider message, so a new message must clear the current scope.
      this.#toolBlocks.set(scope, new Map());
      this.#thinkingBlocks.set(scope, new Map());
      this.#textBlocks.set(scope, new Map());
      this.#finishReasons.delete(scope);
      this.#publicTexts.set(scope, "");
      const stepId = event.message?.id ?? `claude:${scope}:message-${++this.#messageSequence}`;
      this.#messageIds.set(scope, stepId);
      events.push({ protocolVersion: 2, type: "model_step.started", payload: { stepId } });
      return events;
    }

    if (event.type === "message_delta") {
      if (typeof event.delta?.stop_reason === "string") {
        this.#finishReasons.set(scope, event.delta.stop_reason);
      }
      return [];
    }

    if (event.type === "message_stop") return this.#finishStep(scope, "completed");

    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (block?.type === "text" && typeof event.index === "number") {
        const stepId =
          this.#messageIds.get(scope) ?? `claude:${scope}:message-${++this.#messageSequence}`;
        this.#messageIds.set(scope, stepId);
        const messageId = `claude:${stepId}:text:${event.index}`;
        const blocks = this.#textBlocks.get(scope) ?? new Map<number, string>();
        this.#textBlocks.set(scope, blocks);
        blocks.set(event.index, messageId);
        return [
          {
            protocolVersion: 2,
            type: "message.create",
            payload: {
              role: "assistant",
              status: "streaming",
              channel: "final",
              messageId,
              stepId,
              ...(block.text ? { text: block.text } : {})
            }
          }
        ];
      }
      if (block?.type === "thinking" && typeof event.index === "number") {
        let blocks = this.#thinkingBlocks.get(scope);
        if (!blocks) {
          blocks = new Map();
          this.#thinkingBlocks.set(scope, blocks);
        }
        const providerMessageId =
          this.#messageIds.get(scope) ?? `message-${++this.#messageSequence}`;
        const messageId = `claude:${providerMessageId}:thinking:${event.index}`;
        blocks.set(event.index, messageId);
        return [
          {
            protocolVersion: 2,
            type: "message.create",
            payload: {
              role: "assistant",
              status: "streaming",
              messageId,
              stepId: providerMessageId,
              ...claudeAnalysisMetadata("public_reasoning", "stream_event.thinking_start")
            }
          }
        ];
      }
      if (block?.type !== "tool_use" || typeof event.index !== "number" || !block.id || !block.name)
        return [];
      let blocks = this.#toolBlocks.get(scope);
      if (!blocks) {
        blocks = new Map();
        this.#toolBlocks.set(scope, blocks);
      }
      blocks.set(event.index, block.id);
      const stepId = this.#messageIds.get(scope);
      if (stepId) this.#toolSteps.set(block.id, stepId);
      return [
        {
          protocolVersion: 2,
          type: "tool_call.create",
          payload: {
            status: "running",
            id: block.id,
            name: block.name,
            args: block.input ?? {},
            ...(stepId ? { stepId } : {})
          }
        }
      ];
    }

    if (event.type === "content_block_stop" && typeof event.index === "number") {
      const textId = this.#textBlocks.get(scope)?.get(event.index);
      if (textId) {
        this.#textBlocks.get(scope)?.delete(event.index);
        return [
          {
            protocolVersion: 2,
            type: "message.update",
            payload: {
              messageId: textId,
              channel: "final",
              status: "completed",
              stepId: this.#messageIds.get(scope)
            }
          }
        ];
      }
      const messageId = this.#thinkingBlocks.get(scope)?.get(event.index);
      if (!messageId) return [];
      this.#thinkingBlocks.get(scope)?.delete(event.index);
      return [
        {
          protocolVersion: 2,
          type: "message.update",
          payload: {
            role: "assistant",
            status: "completed",
            messageId,
            ...(this.#messageIds.get(scope) ? { stepId: this.#messageIds.get(scope) } : {}),
            ...claudeAnalysisMetadata("public_reasoning", "stream_event.thinking_stop")
          }
        }
      ];
    }

    if (event.type !== "content_block_delta") return [];
    const delta = event.delta;
    if (delta?.type === "text_delta" && delta.text) {
      const stepId =
        this.#messageIds.get(scope) ?? `claude:${scope}:message-${++this.#messageSequence}`;
      this.#messageIds.set(scope, stepId);
      const index = event.index ?? 0;
      const blocks = this.#textBlocks.get(scope) ?? new Map<number, string>();
      this.#textBlocks.set(scope, blocks);
      const messageId = blocks.get(index) ?? `claude:${stepId}:text:${index}`;
      blocks.set(index, messageId);
      this.#appendPublicText(scope, delta.text);
      return [
        {
          protocolVersion: 2,
          type: "message.delta",
          payload: { text: delta.text, channel: "final", messageId, stepId }
        }
      ];
    }
    if (delta?.type === "thinking_delta" && delta.thinking) {
      const messageId =
        typeof event.index === "number"
          ? this.#thinkingBlocks.get(scope)?.get(event.index)
          : undefined;
      return [
        {
          protocolVersion: 2,
          type: "message.delta",
          payload: {
            text: delta.thinking,
            ...(messageId ? { messageId } : {}),
            ...(this.#messageIds.get(scope) ? { stepId: this.#messageIds.get(scope) } : {}),
            ...claudeAnalysisMetadata("public_reasoning", "stream_event.thinking_delta")
          }
        }
      ];
    }
    if (
      delta?.type === "input_json_delta" &&
      delta.partial_json &&
      typeof event.index === "number"
    ) {
      const id = this.#toolBlocks.get(scope)?.get(event.index);
      const stepId = this.#messageIds.get(scope);
      return id
        ? [
            {
              protocolVersion: 2,
              type: "tool_call.delta",
              payload: { id, argsDelta: delta.partial_json, ...(stepId ? { stepId } : {}) }
            }
          ]
        : [];
    }
    return [];
  }

  #finishStep(scope: string, status: string): CanonicalEvent[] {
    const stepId = this.#messageIds.get(scope);
    if (!stepId) return [];
    const finishReason = this.#finishReasons.get(scope);
    const closed: CanonicalEvent[] = [];
    for (const messageId of this.#textBlocks.get(scope)?.values() ?? []) {
      closed.push({
        protocolVersion: 2,
        type: "message.update",
        payload: { messageId, channel: "final", stepId, status: canonicalTerminalStatus(status) }
      });
    }
    this.#textBlocks.delete(scope);
    this.#messageIds.delete(scope);
    this.#finishReasons.delete(scope);
    this.#publicTexts.delete(scope);
    return [
      ...closed,
      {
        protocolVersion: 2,
        type: "model_step.finished",
        payload: {
          stepId,
          status: canonicalTerminalStatus(status),
          ...(finishReason ? { finishReason } : {})
        }
      }
    ];
  }

  #appendPublicText(scope: string, delta: string): void {
    const current = this.#publicTexts.get(scope) ?? "";
    const remaining = MAX_STEP_PUBLIC_TEXT_CHARS - Array.from(current).length;
    if (remaining <= 0) return;
    this.#publicTexts.set(scope, current + Array.from(delta).slice(0, remaining).join(""));
  }

  #finishActiveSteps(status: string): CanonicalEvent[] {
    const events: CanonicalEvent[] = [];
    for (const scope of [...this.#messageIds.keys()])
      events.push(...this.#finishStep(scope, status));
    return events;
  }
}

function claudeAnalysisMetadata(exposure: MessageExposure, nativeEvent: string) {
  return {
    channel: "analysis" as const,
    exposure,
    provenance: { provider: "claude-code", nativeEvent }
  };
}

/** Compatibility entry for a single complete event; a partial sequence must reuse one ClaudeEventNormalizer. */
export function normalizeClaudeEvent(native: ClaudeNativeEvent): CanonicalEvent[] {
  return new ClaudeEventNormalizer().normalize(native);
}

function claudeToolResultOutput(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  const text = content
    .map((item) =>
      item !== null && typeof item === "object" && "text" in item
        ? (item as { text?: unknown }).text
        : undefined
    )
    .filter((item): item is string => typeof item === "string")
    .join("\n");
  return text || content;
}

/** Create a Claude Code adapter bound to a resolved CLI command and optional argv prefix. */
export function createClaudeCodeAdapter({
  command = "claude",
  commandArgsPrefix = []
}: {
  command?: string;
  commandArgsPrefix?: string[];
} = {}) {
  const responders = new Map<string, AcpApprovalBridge>();
  const nativeResponders = new Map<string, NativeInteractionBridge>();
  return defineAdapter({
    metadata: {
      mcp: true,
      protocolSupport: {
        protocol: "claude.stream-json",
        modes: ["native", "canonical"],
        nativeMethods: ["managed-turn", "can_use_tool", "control_response", "cancel"]
      },
      type: "claude-code",
      agentSources: ["provisioned"],
      processModel: "subprocess-per-invocation",
      transport: "ndjson/stdio"
    },
    probe: () => probeCommand(command),
    async respondNative(invocationId: string, response: NativeInteractionResponse): Promise<void> {
      const bridge = nativeResponders.get(invocationId);
      if (!bridge) throw protocolError("INTERACTION_NOT_ACTIVE");
      await bridge.respond(response);
    },
    async respondInteraction(invocationId: string, response: InteractionResponse): Promise<void> {
      const bridge = responders.get(invocationId);
      if (!bridge) throw new Error("INTERACTION_NOT_ACTIVE");
      await bridge.respond(response);
    },
    async *invoke(
      request: InvokeRequest,
      context?: AdapterInvocationContext
    ): AsyncGenerator<AdapterOutput> {
      if (context?.protocolMode === "native") {
        if (nativeResponders.has(request.invocationId))
          throw new Error("INVOCATION_ALREADY_ACTIVE");
        const bridge = new NativeInteractionBridge(context?.streamLimits);
        nativeResponders.set(request.invocationId, bridge);
        try {
          yield* bridge.stream(execute(request, bridge, context));
        } finally {
          bridge.close();
          nativeResponders.delete(request.invocationId);
        }
        return;
      }
      if (responders.has(request.invocationId)) throw new Error("INVOCATION_ALREADY_ACTIVE");
      const permissions = new AcpApprovalBridge(request);
      responders.set(request.invocationId, permissions);
      try {
        yield* permissions.stream(canonicalSource());
        async function* canonicalSource(): AsyncGenerator<CanonicalEvent> {
          for await (const output of execute(request, permissions, context)) {
            if ("kind" in output) throw protocolError("EXECUTION_PROTOCOL_MISMATCH");
            yield output;
          }
        }
      } finally {
        permissions.close("execution_lost");
        responders.delete(request.invocationId);
      }
    }
  });

  async function* execute(
    request: InvokeRequest,
    permissions: AcpApprovalBridge | NativeInteractionBridge,
    context?: AdapterInvocationContext
  ): AsyncGenerator<AdapterOutput> {
    const spec = await buildClaudeCommand(request, command, commandArgsPrefix);
    // The normalizer must not be hoisted to an adapter singleton: one adapter may run several invocations concurrently.
    const normalizer =
      permissions instanceof NativeInteractionBridge ? undefined : new ClaudeEventNormalizer();
    const requestedMode = contextActmode(request.context);
    let modeReported = false;
    try {
      if (normalizer)
        yield {
          protocolVersion: 2,
          type: "message.create",
          payload: { role: "assistant", status: "streaming", channel: "final" }
        };
      for await (const native of spawnJsonLines<ClaudeNativeEvent>({
        ...spec,
        cwd: request.workdir,
        env: invocationEnvironment(request),
        signal: request.signal,
        rawMessageMaxBytes: context?.streamLimits?.rawMessageMaxBytes,
        onSpawn: (close) => permissions.bindTransport(close),
        endInputWhen: (native) => native.type === "result",
        controlHandler: async (native, write) => {
          if (native.type !== "control_request") return;
          if (!native.request_id || native.request?.subtype !== "can_use_tool") {
            if (native.request_id)
              await write({
                type: "control_response",
                response: {
                  subtype: "error",
                  request_id: native.request_id,
                  error: "Unsupported control request"
                }
              });
            throw new Error("CLAUDE_CONTROL_REQUEST_UNSUPPORTED");
          }
          if (permissions instanceof NativeInteractionBridge) {
            const requestId = native.request_id;
            const validate = (payload: Record<string, unknown>): void => {
              const response = payload.response as Record<string, unknown> | undefined;
              const decision = response?.response as Record<string, unknown> | undefined;
              if (
                payload.type !== "control_response" ||
                response?.subtype !== "success" ||
                response.request_id !== requestId ||
                !decision ||
                !["allow", "deny"].includes(String(decision.behavior)) ||
                Object.keys(payload).some((key) => !["type", "response"].includes(key)) ||
                Object.keys(response).some(
                  (key) => !["subtype", "request_id", "response"].includes(key)
                ) ||
                Object.keys(decision).some(
                  (key) => !["behavior", "updatedInput", "message", "interrupt"].includes(key)
                ) ||
                (decision.behavior === "allow" &&
                  JSON.stringify(decision.updatedInput) !==
                    JSON.stringify(native.request?.input ?? {})) ||
                (decision.behavior === "deny" &&
                  decision.interrupt !== undefined &&
                  decision.interrupt !== false)
              )
                throw protocolError("NATIVE_RESPONSE_INVALID");
            };
            permissions.request(
              requestId,
              native,
              write,
              validate,
              request.approvalMode === "full_access"
                ? {
                    type: "control_response",
                    response: {
                      subtype: "success",
                      request_id: requestId,
                      response: { behavior: "allow", updatedInput: native.request.input ?? {} }
                    }
                  }
                : undefined
            );
            return;
          }
          const params = {
            toolCall: {
              toolCallId: native.request.tool_use_id,
              title: native.request.tool_name ?? "Claude tool"
            },
            providerDetails: {
              provider: "claude-code",
              method: "can_use_tool",
              title: native.request.tool_name,
              ...(typeof native.request.input?.command === "string"
                ? { command: native.request.input.command }
                : {}),
              ...(typeof native.request.input?.file_path === "string"
                ? { files: [native.request.input.file_path] }
                : {})
            },
            options: [
              { kind: "allow_once", optionId: "allow" },
              { kind: "reject_once", optionId: "deny" }
            ]
          };
          try {
            const decision = await permissions.requestPermission(params);
            const allowed = (decision.outcome as { optionId?: string })?.optionId === "allow";
            await write({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: native.request_id,
                response: allowed
                  ? { behavior: "allow", updatedInput: native.request.input ?? {} }
                  : { behavior: "deny", message: "User declined tool execution", interrupt: false }
              }
            });
            permissions.responseWritten(params);
          } catch (error) {
            permissions.responseFailed(
              params,
              error instanceof Error ? error : new Error(String(error))
            );
            throw error;
          }
        },
        parseLine: parseJsonLine
      })) {
        if (
          requestedMode !== undefined &&
          !modeReported &&
          native.type === "system" &&
          native.subtype === "init"
        ) {
          modeReported = true;
          const nativeMode =
            typeof native.permissionMode === "string" ? native.permissionMode : undefined;
          const effective =
            nativeMode === "plan"
              ? "plan"
              : nativeMode &&
                  ["default", "auto", "bypassPermissions", "acceptEdits", "dontAsk"].includes(
                    nativeMode
                  )
                ? "default"
                : null;
          yield actmodeEvidence(
            {
              requested: requestedMode,
              effective,
              status: effective === requestedMode ? "applied" : "unknown",
              ...(nativeMode ? { nativeMode } : {}),
              ...(effective !== requestedMode
                ? { effective: null, reason: "provider_unconfirmed" as const }
                : {})
            },
            context?.protocolMode
          );
        }
        if (native.type === "system" && native.subtype === "init")
          context?.reportActivity?.({ kind: "turn_started", method: "turn_start" });
        if (native.type === "stream_event") {
          const event = native.event;
          if (event?.type === "message_start")
            context?.reportActivity?.({ kind: "turn_started", method: "turn_start" });
          else if (
            event?.type === "content_block_start" &&
            event.content_block?.type === "tool_use" &&
            event.content_block.id
          )
            context?.reportActivity?.({
              kind: "turn_progress",
              method: "item_lifecycle",
              toolCallId: event.content_block.id,
              toolState: "started"
            });
          else if (
            event?.type === "content_block_delta" &&
            (event.delta?.text || event.delta?.thinking || event.delta?.partial_json)
          )
            context?.reportActivity?.({
              kind: "turn_progress",
              method: event.delta.partial_json ? "tool_delta" : "text_delta"
            });
        }
        for (const block of native.message?.content ?? []) {
          if (block.type === "tool_result" && block.tool_use_id)
            context?.reportActivity?.({
              kind: "turn_progress",
              method: "item_lifecycle",
              toolCallId: block.tool_use_id,
              toolState: "completed"
            });
        }
        if (!normalizer) {
          if (native.type === "control_request") continue;
          yield { kind: "native", messageKind: "message", payload: native };
          if (native.type === "result") {
            (permissions as NativeInteractionBridge).close();
            yield {
              kind: "control",
              control: { type: "state", state: native.is_error ? "failed" : "completed" }
            };
            return;
          }
          continue;
        }
        context?.reportConversion?.();
        const events = normalizer.normalize(native);
        yield* events;
        if (
          events.some((event) =>
            ["run.completed", "run.failed", "run.cancelled"].includes(event.type)
          )
        )
          return;
      }
    } finally {
      await spec.cleanup();
    }
  }
}

export const claudeCodeAdapter = createClaudeCodeAdapter();
export default claudeCodeAdapter;

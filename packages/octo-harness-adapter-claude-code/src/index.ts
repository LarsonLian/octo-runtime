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
  defineAdapter,
  parseJsonLine,
  probeCommand,
  providerInputText,
  spawnJsonLines,
  type CanonicalEvent,
  type InvokeRequest,
  type MessageExposure
} from "@mininglamp-oss/octo-harness-adapter-sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  };
}

interface ClaudeNativeEvent {
  type?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  event?: ClaudeStreamEvent;
  message?: { content?: ClaudeContentBlock[] };
  usage?: Record<string, unknown>;
  is_error?: boolean;
  result?: string;
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
  const directory = await mkdtemp(join(tmpdir(), "octo-harness-claude-"));
  const promptFile = join(directory, "system-prompt.txt");
  // The control prompt goes through Claude's dedicated file argument while the
  // user prompt is still fed via stdin, so the two never get conflated.
  await writeFile(promptFile, req.appendInstructions, { mode: 0o600 });
  // Only --include-partial-messages produces thinking/text/input_json deltas;
  // plain stream-json still delivers whole assistant blocks, which cannot
  // satisfy the local Chat's real-time streaming requirement.
  const args = [
    ...commandArgsPrefix,
    "--print",
    "--input-format", "text",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--append-system-prompt-file", promptFile
  ];
  if (req.providerSession?.sessionId) args.push("--resume", req.providerSession.sessionId);
  if (req.agentConfig?.model) args.push("--model", req.agentConfig.model);
  if (req.agentConfig?.thinking) {
    args.push("--effort", req.agentConfig.thinking === "disabled" ? "low" : req.agentConfig.thinking);
  }
  const mode = req.agentConfig?.dangerouslyBypassPermissions === true
    ? "bypassPermissions"
    : req.agentConfig?.permissionMode ?? "bypassPermissions";
  args.push("--permission-mode", mode);
  if (mode === "bypassPermissions") args.push("--dangerously-skip-permissions");
  args.push("-");
  return { command, args, input: providerInputText(req), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

/**
 * Translates Claude's native stream into canonical events for one invocation.
 *
 * In the partial stream a tool-args delta carries only its block index, not a
 * repeated tool_use id, so the normalizer must map index -> id per invocation;
 * sharing one instance globally would cross-wire concurrent Runs.
 */
export class ClaudeEventNormalizer {
  /** Once a partial arrives, later assistant snapshots and result text are treated as duplicate snapshots. */
  #sawPartialMessages = false;
  /** Claude repeats system/status on every tool turn; publish the session id to Core only once per session. */
  #publishedSessionId?: string;
  /** parent tool scope -> content block index -> tool_use id, so concurrent sub-tasks cannot collide on index. */
  readonly #toolBlocks = new Map<string, Map<number, string>>();

  /** Return canonical events in stdout arrival order; this method neither buffers a whole turn nor reorders events. */
  normalize(native: ClaudeNativeEvent): CanonicalEvent[] {
    if (native.type === "system" && native.session_id) {
      if (native.session_id === this.#publishedSessionId) return [];
      this.#publishedSessionId = native.session_id;
      return [{
        type: "session.update",
        payload: { providerSession: { sessionId: native.session_id, resumable: true } }
      }];
    }

    if (native.type === "stream_event") {
      this.#sawPartialMessages = true;
      return this.#normalizePartial(native);
    }

    if (native.type === "assistant") {
      // --include-partial-messages replays the complete block after the delta; do not emit it again.
      if (this.#sawPartialMessages) return [];
      const events: CanonicalEvent[] = [];
      for (const block of native.message?.content ?? []) {
        if (block.type === "text" && block.text) {
          events.push({ type: "message.delta", payload: { text: block.text, channel: "final" } });
        }
        if (block.type === "thinking" && block.thinking) {
          events.push({
            type: "message.delta",
            payload: {
              text: block.thinking,
              ...claudeAnalysisMetadata("private_reasoning", "assistant.content.thinking")
            }
          });
        }
        if (block.type === "tool_use" && block.id && block.name) {
          events.push({
            type: "tool_call.create",
            payload: { id: block.id, name: block.name, args: block.input ?? {} }
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
        events.push({
          type: "tool_call.update",
          payload: {
            id: block.tool_use_id,
            status: block.is_error ? "error" : "completed",
            ...(output === undefined ? {} : { output }),
            ...(block.is_error ? { error: { message: typeof output === "string" ? output : "Claude tool call failed" } } : {})
          }
        });
      }
      return events;
    }

    if (native.type === "result") {
      return [
        { type: "usage.update", payload: native.usage ?? {} },
        {
          type: "message.update",
          payload: {
            role: "assistant",
            status: native.is_error ? "failed" : "completed",
            channel: "final",
            // Partial mode already delivered all visible text incrementally; overwriting here would drop pre-tool progress in the UI.
            ...(!this.#sawPartialMessages && typeof native.result === "string" ? { text: native.result } : {})
          }
        },
        {
          type: native.is_error ? "run.error" : "run.finished",
          payload: native.is_error ? { message: native.result ?? "Claude Code failed" } : {}
        }
      ];
    }
    return [];
  }

  #normalizePartial(native: ClaudeNativeEvent): CanonicalEvent[] {
    const event = native.event;
    if (!event) return [];
    const scope = native.parent_tool_use_id ?? "root";

    if (event.type === "message_start") {
      // A block index is only stable within one provider message, so a new message must clear the current scope.
      this.#toolBlocks.set(scope, new Map());
      return [];
    }

    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (block?.type !== "tool_use" || typeof event.index !== "number" || !block.id || !block.name) return [];
      let blocks = this.#toolBlocks.get(scope);
      if (!blocks) {
        blocks = new Map();
        this.#toolBlocks.set(scope, blocks);
      }
      blocks.set(event.index, block.id);
      return [{
        type: "tool_call.create",
        payload: { id: block.id, name: block.name, args: block.input ?? {} }
      }];
    }

    if (event.type !== "content_block_delta") return [];
    const delta = event.delta;
    if (delta?.type === "text_delta" && delta.text) {
      return [{ type: "message.delta", payload: { text: delta.text, channel: "final" } }];
    }
    if (delta?.type === "thinking_delta" && delta.thinking) {
      return [{
        type: "message.delta",
        payload: {
          text: delta.thinking,
          ...claudeAnalysisMetadata("private_reasoning", "stream_event.thinking_delta")
        }
      }];
    }
    if (delta?.type === "input_json_delta" && delta.partial_json && typeof event.index === "number") {
      const id = this.#toolBlocks.get(scope)?.get(event.index);
      return id ? [{
        type: "tool_call.delta",
        payload: { id, argsDelta: delta.partial_json }
      }] : [];
    }
    return [];
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
    .map(item => item !== null && typeof item === "object" && "text" in item ? (item as { text?: unknown }).text : undefined)
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
  return defineAdapter({
    metadata: {
      type: "claude-code",
      capabilities: ["session.serialize", "tool.canonical"],
      processModel: "subprocess-per-invocation",
      transport: "ndjson/stdio"
    },
    probe: () => probeCommand(command),
    async *invoke(request: InvokeRequest): AsyncGenerator<CanonicalEvent> {
      const spec = await buildClaudeCommand(request, command, commandArgsPrefix);
      // The normalizer must not be hoisted to an adapter singleton: one adapter may run several invocations concurrently.
      const normalizer = new ClaudeEventNormalizer();
      try {
        yield {
          type: "message.create",
          payload: { role: "assistant", status: "streaming", channel: "final" }
        };
        for await (const native of spawnJsonLines<ClaudeNativeEvent>({
          ...spec,
          cwd: request.workdir,
          signal: request.signal,
          parseLine: parseJsonLine
        })) {
          yield* normalizer.normalize(native);
        }
      } finally {
        await spec.cleanup();
      }
    }
  });
}

export const claudeCodeAdapter = createClaudeCodeAdapter();
export default claudeCodeAdapter;

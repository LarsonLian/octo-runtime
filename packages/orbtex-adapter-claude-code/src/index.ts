/**
 * Claude Code 本地 CLI transport 与事件归一化层。
 *
 * 生产调用固定启用 stream-json partial messages。Claude 会先发送 content block 的
 * start/delta，随后再重放同一 block 的完整 assistant snapshot；adapter 只发布前者，
 * 否则 Chat 会看到重复文本和重复 tool call。tool args delta 本身没有 tool_use id，
 * 所以每个 invocation 必须拥有独立的 ClaudeEventNormalizer 状态。
 */
import {
  defineAdapter,
  parseJsonLine,
  probeCommand,
  spawnJsonLines,
  type CanonicalEvent,
  type InvokeRequest
} from "@orbtex-ai/orbtex-adapter-sdk";
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

export async function buildClaudeCommand(
  req: InvokeRequest,
  command = "claude",
  commandArgsPrefix: string[] = []
) {
  const directory = await mkdtemp(join(tmpdir(), "orbtex-claude-"));
  const promptFile = join(directory, "system-prompt.txt");
  // 控制提示词走 Claude 的专用文件参数，用户 prompt 仍从 stdin 输入，二者不会混淆。
  await writeFile(promptFile, req.appendInstructions, { mode: 0o600 });
  // include-partial-messages 才会产生 thinking/text/input_json delta；单独的 stream-json
  // 仍以完整 assistant block 为主，不能满足本地 Chat 的实时展示需求。
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
  return { command, args, input: req.prompt, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

/**
 * Claude partial stream 中 tool 参数 delta 只携带 block index，不重复 tool_use id。
 * normalizer 因此必须按 invocation 保存 index -> id；全局复用会让并发 Run 串流。
 */
export class ClaudeEventNormalizer {
  /** 一旦收到 partial，后续 assistant snapshot 与 result text 都只能作为重复快照处理。 */
  #sawPartialMessages = false;
  /** Claude 每个工具轮次都会重复 system/status；同一 session 只向 Core 发布一次。 */
  #publishedSessionId?: string;
  /** parent tool scope -> content block index -> tool_use id，防止并发子任务 index 冲突。 */
  readonly #toolBlocks = new Map<string, Map<number, string>>();

  /** 按 stdout 到达顺序返回 canonical events；此方法不缓冲整轮，也不重排事件。 */
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
      // --include-partial-messages 会在 delta 后重放完整 block；不能再次输出。
      if (this.#sawPartialMessages) return [];
      const events: CanonicalEvent[] = [];
      for (const block of native.message?.content ?? []) {
        if (block.type === "text" && block.text) {
          events.push({ type: "message.delta", payload: { text: block.text, channel: "final" } });
        }
        if (block.type === "thinking" && block.thinking) {
          events.push({ type: "message.delta", payload: { text: block.thinking, channel: "analysis" } });
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
            // partial 模式已经逐段交付了全部可见文本；这里覆盖会让 UI 丢失工具前进度。
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
      // block index 只在一条 provider message 内稳定，新 message 必须清空当前 scope。
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
      return [{ type: "message.delta", payload: { text: delta.thinking, channel: "analysis" } }];
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

/** 单条完整事件的兼容入口；partial 序列应复用同一个 ClaudeEventNormalizer。 */
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
      // normalizer 不能提升到 adapter 单例：同一 adapter 可以并发执行多个 invocation。
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

import {
  initialControlInstructions,
  defineAdapter,
  hasImageInput,
  invocationEnvironment,
  mapReasoningEffort,
  parseJsonLine,
  probeCommand,
  providerInputText,
  spawnJsonLines,
  type CanonicalEvent,
  type CommandSpec,
  type AdapterInvocationContext,
  type InvokeRequest
} from "@mininglamp-oss/octo-runtime-adapter-sdk";
import { isStreamCapacityReason } from "@mininglamp-oss/octo-runtime-protocol";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface NativeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

interface NativeStep {
  conversation_id?: string;
  step_index?: number;
  step_type?: string;
  state?: string;
  text_delta?: string;
  usage?: NativeUsage;
  tool_name?: string;
  tool_info?: {
    name?: string;
    parameters?: Record<string, unknown>;
    output?: unknown;
    error?: Record<string, unknown>;
  };
}

export interface AntigravityNativeEvent {
  event?: string;
  conversation_id?: string;
  step_update?: NativeStep;
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    error?: string;
    usage?: NativeUsage;
  };
}

interface MessageState {
  id: string;
  text: string;
  done: boolean;
}
interface ToolState {
  id: string;
  name: string;
  args: Record<string, unknown>;
  done: boolean;
}

export class AntigravityEventNormalizer {
  readonly #messages = new Map<number, MessageState>();
  readonly #tools = new Map<number, ToolState>();
  readonly #usage = new Map<number, NativeUsage>();
  #sessionId = "";
  #result: AntigravityNativeEvent["result"];
  #finished = false;

  constructor(
    readonly invocationId: string,
    readonly resumed = false
  ) {}

  get hasResult(): boolean {
    return this.#result !== undefined;
  }

  normalize(native: AntigravityNativeEvent): CanonicalEvent[] {
    if (this.#result || this.#finished) return [];
    const events: CanonicalEvent[] = [];
    const sessionId =
      native.conversation_id ??
      native.step_update?.conversation_id ??
      native.result?.conversation_id;
    if (sessionId && sessionId !== this.#sessionId) {
      this.#sessionId = sessionId;
      events.push({
        protocolVersion: 2,
        type: "session.update",
        payload: { providerSession: { sessionId, resumable: true } }
      });
    }
    if (native.event === "result") {
      if (
        !native.result ||
        typeof native.result.status !== "string" ||
        (native.result.response !== undefined && typeof native.result.response !== "string") ||
        (native.result.error !== undefined && typeof native.result.error !== "string")
      )
        throw new Error("ANTIGRAVITY_RESULT_INVALID");
      this.#result = native.result;
      const response = native.result.response;
      if (typeof response === "string" && response) {
        const messages = [...this.#messages.values()];
        const last = messages.at(-1);
        if (!last) {
          const message = this.#message(-1, events);
          message.text = response;
          events.push(this.#snapshot(message, "streaming"));
        } else if (
          messages.map((message) => message.text).join("") !== response &&
          last.text !== response
        ) {
          const prefix = messages
            .slice(0, -1)
            .map((message) => message.text)
            .join("");
          last.text =
            prefix && response.startsWith(prefix) ? response.slice(prefix.length) : response;
          last.done = false;
          events.push(this.#snapshot(last, "streaming"));
        }
      }
      return events;
    }
    if (native.event !== "step_update" || !native.step_update) return events;
    const step = native.step_update;
    const index = step.step_index;
    if (!Number.isSafeInteger(index) || index === undefined || index < 0) return events;
    const done = step.state?.toUpperCase() === "DONE";
    if (done && step.usage) this.#usage.set(index, step.usage);
    if (step.step_type === "agent_response") {
      const known = this.#messages.get(index);
      if (known?.done) return events;
      if (typeof step.text_delta === "string" && step.text_delta) {
        const message = this.#message(index, events);
        message.text += step.text_delta;
        events.push({
          protocolVersion: 2,
          type: "message.delta",
          payload: { messageId: message.id, channel: "final", text: step.text_delta }
        });
      }
      if (done) {
        const message = this.#messages.get(index);
        if (message) {
          message.done = true;
          events.push(this.#snapshot(message, "completed"));
        }
      }
    } else if (step.step_type === "tool" && (done || step.state?.toUpperCase() === "ACTIVE")) {
      let tool = this.#tools.get(index);
      if (tool?.done) return events;
      if (!tool) {
        const name = step.tool_name ?? step.tool_info?.name;
        if (!name) return events;
        tool = {
          id: `antigravity:${this.invocationId}:tool:${index}`,
          name,
          args: normalizeToolInput(step.tool_info?.parameters ?? {}),
          done: false
        };
        this.#tools.set(index, tool);
        events.push({
          protocolVersion: 2,
          type: "tool_call.create",
          payload: { id: tool.id, name, args: tool.args, status: "running" }
        });
      }
      if (done) {
        tool.done = true;
        events.push({
          protocolVersion: 2,
          type: "tool_call.update",
          payload: {
            id: tool.id,
            status: step.tool_info?.error ? "failed" : "completed",
            ...(step.tool_info?.output !== undefined ? { output: step.tool_info.output } : {}),
            ...(step.tool_info?.error ? { error: step.tool_info.error } : {})
          }
        });
      } else if (step.tool_info?.output !== undefined) {
        events.push({
          protocolVersion: 2,
          type: "tool_call.delta",
          payload: {
            id: tool.id,
            outputSnapshot:
              typeof step.tool_info.output === "string"
                ? step.tool_info.output
                : JSON.stringify(step.tool_info.output)
          }
        });
      }
    }
    return events;
  }

  finish(error?: unknown, cancelled = false): CanonicalEvent[] {
    if (this.#finished) return [];
    this.#finished = true;
    const result = this.#result;
    const status = result?.status?.toUpperCase();
    const isCancelled =
      cancelled || status === "CANCELED" || status === "CANCELLED" || status === "INTERRUPTED";
    const response = [...this.#messages.values()].map((message) => message.text).join("");
    const succeeded =
      !error &&
      !isCancelled &&
      status === "SUCCESS" &&
      !result?.error &&
      !!result?.response?.trim();
    const events: CanonicalEvent[] = [];
    for (const message of this.#messages.values()) {
      if (!message.done)
        events.push(
          this.#snapshot(message, succeeded ? "completed" : isCancelled ? "cancelled" : "failed")
        );
    }
    for (const tool of this.#tools.values()) {
      if (!tool.done)
        events.push({
          protocolVersion: 2,
          type: "tool_call.update",
          payload: { id: tool.id, status: isCancelled ? "cancelled" : "failed" }
        });
    }
    // Result usage is cumulative on resumed sessions; only DONE steps belong to this invocation.
    const usages = this.#usage.size
      ? [...this.#usage.values()]
      : !this.resumed && result?.usage
        ? [result.usage]
        : [];
    if (usages.length) {
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      for (const native of usages) {
        usage.inputTokens += tokens(native.input_tokens);
        usage.outputTokens += tokens(native.output_tokens);
        usage.cacheReadTokens += tokens(native.cache_read_tokens);
        usage.cacheWriteTokens += tokens(native.cache_write_tokens);
      }
      events.push({ protocolVersion: 2, type: "usage.update", payload: usage });
    }
    events.push(
      isCancelled
        ? { protocolVersion: 2, type: "run.cancelled", payload: {} }
        : succeeded
          ? { protocolVersion: 2, type: "run.completed", payload: {} }
          : {
              protocolVersion: 2,
              type: "run.failed",
              payload: {
                code: "ANTIGRAVITY_EXECUTION_FAILED",
                message:
                  error instanceof Error
                    ? error.message
                    : result?.error ||
                      (result
                        ? `Antigravity returned ${status ?? "INVALID"}${response.trim() ? "" : " without an answer"}`
                        : "Antigravity exited without a result event")
              }
            }
    );
    return events;
  }

  #message(index: number, events: CanonicalEvent[]): MessageState {
    let message = this.#messages.get(index);
    if (!message) {
      message = { id: `antigravity:${this.invocationId}:message:${index}`, text: "", done: false };
      this.#messages.set(index, message);
      events.push({
        protocolVersion: 2,
        type: "message.create",
        payload: { messageId: message.id, role: "assistant", channel: "final", status: "streaming" }
      });
    }
    return message;
  }

  #snapshot(
    message: MessageState,
    status: "streaming" | "completed" | "failed" | "cancelled"
  ): CanonicalEvent {
    return {
      protocolVersion: 2,
      type: "message.update",
      payload: {
        messageId: message.id,
        role: "assistant",
        channel: "final",
        status,
        text: message.text
      }
    };
  }
}

function tokens(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeToolInput(parameters: Record<string, unknown>): Record<string, unknown> {
  const input = { ...parameters };
  for (const [from, to] of [
    ["CommandLine", "command"],
    ["AbsolutePath", "file_path"],
    ["TargetFile", "file_path"],
    ["CodeContent", "content"],
    ["TargetContent", "old_string"],
    ["ReplacementContent", "new_string"]
  ]) {
    if (!(to in input) && from in input) {
      input[to] = input[from];
      delete input[from];
    }
  }
  return input;
}

const managedFlags = new Set([
  "-p",
  "--print",
  "--prompt",
  "-i",
  "--prompt-interactive",
  "-c",
  "--continue",
  "--conversation",
  "--model",
  "--effort",
  "--agent",
  "--input-format",
  "--output-format",
  "--dangerously-skip-permissions",
  "--mode",
  "--print-timeout",
  "--log-file",
  "--add-dir",
  "--project",
  "--new-project",
  "--sandbox"
]);

export function buildAntigravityCommand(
  request: InvokeRequest,
  command = "agy",
  commandArgsPrefix: string[] = [],
  logPath?: string
): CommandSpec {
  if (request.approvalMode !== "full_access")
    throw new Error("APPROVAL_MODE_UNSUPPORTED: antigravity only supports full_access");
  if (request.signal?.aborted) throw new Error("ANTIGRAVITY_CANCELLED_BEFORE_START");
  if (hasImageInput(request)) throw new Error("ANTIGRAVITY_IMAGE_INPUT_UNSUPPORTED");
  for (const arg of commandArgsPrefix) {
    if (managedFlags.has(arg.split("=")[0]) || /^-[pic].+/.test(arg))
      throw new Error(`ANTIGRAVITY_MANAGED_ARGUMENT: ${arg.split("=")[0]}`);
  }
  const effort = mapReasoningEffort("antigravity", request.agentConfig.effort);
  const args = [
    ...commandArgsPrefix,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--mode",
    "accept-edits",
    "--print-timeout",
    "0"
  ];
  if (logPath) args.push("--log-file", logPath);
  if (request.providerSession?.sessionId)
    args.push("--conversation", request.providerSession.sessionId);
  if (request.agentConfig.model) args.push("--model", request.agentConfig.model);
  if (effort) args.push("--effort", effort);
  // agy has no system-prompt flag. Keep the documented user-channel degradation explicit and never rewrite AGENTS.md.
  const content = initialControlInstructions(request)
    ? [
        {
          type: "text",
          text: `Runtime control instructions (apply throughout this session):\n${initialControlInstructions(request)}`
        },
        { type: "text", text: `User input:\n${providerInputText(request)}` }
      ]
    : providerInputText(request);
  const input = `${JSON.stringify({ event: "user", message: { content } })}\n`;
  return { command, args, input, cwd: request.workdir };
}

export function antigravityLogError(log: string): string | undefined {
  if (/timed out waiting for response/i.test(log))
    return "ANTIGRAVITY_TIMEOUT: CLI timed out waiting for the response";
  const match = /exiting agent loop due to error:\s*([^\r\n]+)/i.exec(log);
  if (match && /not logged|authentication required/i.test(match[1]))
    return "ANTIGRAVITY_AUTH_REQUIRED: agy could not read the signed-in account; open agy in your terminal and check the active account";
  return match ? `ANTIGRAVITY_PROVIDER_ERROR: ${match[1].slice(0, 1000)}` : undefined;
}

export function createAntigravityAdapter({
  command = "agy",
  commandArgsPrefix = []
}: { command?: string; commandArgsPrefix?: string[] } = {}) {
  return defineAdapter({
    metadata: {
      type: "antigravity",
      agentSources: ["provisioned"],
      processModel: "subprocess-per-invocation",
      transport: "ndjson/stdio"
    },
    probe: async () => {
      const result = await probeCommand(command);
      if (result.available && (!result.version || compareVersion(result.version, "1.3.3") < 0))
        return { ...result, available: false, reason: "provider_version_unsupported" };
      return result;
    },
    async *invoke(
      request: InvokeRequest,
      context?: AdapterInvocationContext
    ): AsyncGenerator<CanonicalEvent> {
      buildAntigravityCommand(request, command, commandArgsPrefix);
      const directory = await mkdtemp(join(tmpdir(), "octo-runtime-antigravity-"));
      const logPath = join(directory, "cli.log");
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.signal?.addEventListener("abort", abort, { once: true });
      if (request.signal?.aborted) abort();
      const normalizer = new AntigravityEventNormalizer(
        request.invocationId,
        !!request.providerSession?.sessionId
      );
      let providerError: Error | undefined;
      let pendingLogCheck: Promise<void> | undefined;
      const checkLog = async () => {
        if (pendingLogCheck) return pendingLogCheck;
        if (controller.signal.aborted || normalizer.hasResult) return;
        pendingLogCheck = (async () => {
          try {
            const error = antigravityLogError(await readFile(logPath, "utf8"));
            if (error && !normalizer.hasResult) {
              providerError = new Error(error);
              controller.abort();
            }
          } catch {
            /* The CLI has not created its log yet. */
          }
        })();
        try {
          await pendingLogCheck;
        } finally {
          pendingLogCheck = undefined;
        }
      };
      const timer = setInterval(() => {
        void checkLog();
      }, 250);
      timer.unref();
      const spec = buildAntigravityCommand(request, command, commandArgsPrefix, logPath);
      try {
        for await (const native of spawnJsonLines({
          ...spec,
          env: invocationEnvironment(request, spec.env),
          signal: controller.signal,
          rawMessageMaxBytes: context?.streamLimits?.rawMessageMaxBytes,
          parseLine: (line): AntigravityNativeEvent | null => {
            if (!line.trim()) return null;
            const value = parseJsonLine(line);
            if (!value || typeof value.event !== "string")
              throw new Error("ANTIGRAVITY_OUTPUT_INVALID: expected an NDJSON event");
            return value;
          }
        })) {
          const events = normalizer.normalize(native);
          for (const event of events) yield event;
          if (normalizer.hasResult) break;
        }
      } catch (error) {
        if (error instanceof Error && isStreamCapacityReason(Reflect.get(error, "code")))
          throw error;
        providerError ??= error instanceof Error ? error : new Error(String(error));
      } finally {
        clearInterval(timer);
        request.signal?.removeEventListener("abort", abort);
        await checkLog();
        await rm(directory, { recursive: true, force: true });
      }
      const terminalEvents = normalizer.finish(providerError, request.signal?.aborted);
      for (const event of terminalEvents) yield event;
    }
  });
}

function compareVersion(version: string, minimum: string): number {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[A-Za-z0-9.-]+)?$/.exec(version);
  if (!match) return -1;
  const current = match.slice(1).map(Number);
  const expected = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (current[i] !== expected[i]) return current[i] - expected[i];
  }
  return 0;
}

export const antigravityAdapter = createAntigravityAdapter();
export default antigravityAdapter;

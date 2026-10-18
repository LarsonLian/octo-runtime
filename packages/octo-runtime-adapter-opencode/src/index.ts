import {
  initialControlInstructions,
  hasImageInput,
  mapReasoningEffort,
  invocationEnvironment,
  invocationMcpServers,
  assertMcpOptions
} from "@mininglamp-oss/octo-runtime-adapter-sdk";
import { canonicalTerminalStatus } from "@mininglamp-oss/octo-runtime-protocol";
/**
 * OpenCode adapter: wraps the OpenCode CLI (`opencode run --format json
 * --thinking --auto`) for full access and ACP for interactive approval.
 * Both transports normalize provider output into canonical events.
 */
import { createAcpAdapter } from "@mininglamp-oss/octo-runtime-adapter-acp";
import {
  createJsonCliAdapter,
  probeCommand,
  providerInputText,
  type AdapterInvocationContext,
  type CanonicalEvent,
  type InvokeRequest
} from "@mininglamp-oss/octo-runtime-adapter-sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A single OpenCode stream part; tool lifecycle is carried in `state.status` (running -> completed/error). */
interface OpenCodePart {
  sessionID?: string;
  messageID?: string;
  type?: string;
  text?: string;
  reason?: string;
  callID?: string;
  id?: string;
  tool?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    time?: { start?: unknown; end?: unknown };
  };
  tokens?: Record<string, unknown>;
  cost?: unknown;
  time?: { start?: unknown; end?: unknown };
}

/** A top-level OpenCode event, which may wrap a part and carries session/usage/error at the envelope level. */
interface OpenCodeNativeEvent extends OpenCodePart {
  sessionID?: string;
  sessionId?: string;
  part?: OpenCodePart;
  timestamp?: unknown;
  usage?: Record<string, unknown>;
  error?: { data?: { message?: string }; message?: string };
}

/**
 * Build the OpenCode CLI argv/env for one invocation.
 *
 * Runtime context is injected as an extra entry in OpenCode's `instructions`
 * config (a temp markdown file) delivered through OPENCODE_CONFIG_CONTENT,
 * merged onto any inline config so the user's existing OpenCode config is not
 * overwritten. Returns a `cleanup` that removes the temp directory.
 *
 */
export async function buildOpenCodeCommand(req: InvokeRequest, command = "opencode") {
  if (hasImageInput(req))
    throw new Error("UNSUPPORTED_INPUT_MODALITY: opencode does not encode image input");
  if (req.approvalMode !== "full_access")
    throw new Error("APPROVAL_MODE_UNSUPPORTED: opencode permission transport is not qualified");
  const runEnv = invocationEnvironment(req);
  const servers = invocationMcpServers(req, runEnv);
  assertMcpOptions(servers, "opencode", ["toolTimeoutMs"]);
  const directory = await mkdtemp(join(tmpdir(), "octo-runtime-opencode-"));
  const instructions = join(directory, "instructions.md");
  await writeFile(instructions, initialControlInstructions(req), { mode: 0o600 });
  let inline: Record<string, unknown> = {};
  if (runEnv.OPENCODE_CONFIG_CONTENT)
    inline = JSON.parse(runEnv.OPENCODE_CONFIG_CONTENT) as Record<string, unknown>;
  const configuredInstructions = Array.isArray(inline.instructions)
    ? inline.instructions.filter((value): value is string => typeof value === "string")
    : [];
  // Inject harness context via a temporary instructions file, without rewriting the user's existing OpenCode config.
  if (initialControlInstructions(req))
    inline.instructions = [...configuredInstructions, instructions];
  if (Object.keys(servers).length) {
    inline.mcp = {
      ...(isRecord(inline.mcp) ? inline.mcp : {}),
      ...Object.fromEntries(
        Object.entries(servers).map(([name, server]) => [
          name,
          {
            ...(server.type === "stdio"
              ? {
                  type: "local",
                  command: [server.command, ...(server.args ?? [])],
                  environment: server.env ?? {}
                }
              : { type: "remote", url: server.url, headers: server.headers ?? {} }),
            enabled: true,
            ...(server.toolTimeoutMs !== undefined ? { timeout: server.toolTimeoutMs } : {})
          }
        ])
      )
    };
  }
  // Reasoning output and non-interactive tool approval are mandatory parts of
  // this adapter's provider contract.
  const args = ["run", "--format", "json", "--thinking", "--auto"];
  if (req.providerSession?.sessionId) args.push("--session", req.providerSession.sessionId);
  if (req.agentConfig?.model) args.push("--model", req.agentConfig.model);
  const variant = mapReasoningEffort("opencode", req.agentConfig?.effort);
  if (variant && variant !== "enabled" && variant !== "disabled") args.push("--variant", variant);
  args.push(providerInputText(req));
  return {
    command,
    args,
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(inline), OPENCODE_CLIENT: "octo-runtime" },
    rpcMethod: "process.argv",
    providerSessionId: req.providerSession?.sessionId,
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

/** Translate one OpenCode native event/part into canonical events; unrelated events yield an empty list. */
export function normalizeOpenCodeEvent(native: OpenCodeNativeEvent): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  const part: OpenCodePart = native.part ?? native;
  const sessionId = native.sessionID ?? native.sessionId ?? native.part?.sessionID;
  if ((native.type === "step_start" || native.type === "session.created") && sessionId) {
    events.push({
      protocolVersion: 2,
      type: "session.update",
      payload: { providerSession: { sessionId, resumable: true } }
    });
  }
  const stepId = part.messageID;
  const timestamp = providerTimestamp(native.timestamp);
  if ((native.type === "step_start" || part.type === "step-start") && stepId) {
    events.push({
      protocolVersion: 2,
      type: "model_step.started",
      payload: { stepId, ...(timestamp === undefined ? {} : { startedAtMs: timestamp }) }
    });
  }
  const toolState = part.state;
  const toolId = part.callID ?? part.id;
  if ((native.type === "text" || part.type === "text") && typeof part.text === "string") {
    events.push({
      protocolVersion: 2,
      type: "message.delta",
      payload: {
        text: part.text,
        ...(stepId
          ? { stepId, messageId: `opencode:${part.id ?? `${stepId}:answer`}` }
          : part.id
            ? { messageId: `opencode:${part.id}` }
            : {})
      }
    });
  }
  if ((native.type === "reasoning" || part.type === "reasoning") && typeof part.text === "string") {
    events.push({
      protocolVersion: 2,
      type: "message.delta",
      payload: {
        text: part.text,
        ...(stepId ? { stepId, messageId: `opencode:${part.id ?? `${stepId}:reasoning`}` } : {}),
        channel: "analysis",
        exposure: "public_reasoning",
        provenance: { provider: "opencode", nativeEvent: "reasoning" }
      }
    });
  }
  if (part.type === "tool" && toolState?.status === "running" && toolId && part.tool) {
    const args = isRecord(toolState.input)
      ? toolState.input
      : toolState.input == null
        ? {}
        : { value: toolState.input };
    events.push({
      protocolVersion: 2,
      type: "tool_call.create",
      payload: {
        status: "running",
        id: toolId,
        name: part.tool,
        args,
        ...(stepId ? { stepId } : {})
      }
    });
  }
  if (
    part.type === "tool" &&
    toolId &&
    toolState?.status &&
    ["completed", "error"].includes(toolState.status)
  ) {
    const args = isRecord(toolState.input)
      ? toolState.input
      : toolState.input == null
        ? {}
        : { value: toolState.input };
    const durationMs = toolDurationMs(toolState.time);
    // A terminal-only OpenCode frame carries enough identity to let the
    // projector create the item without inventing a duplicate start event.
    events.push({
      protocolVersion: 2,
      type: "tool_call.update",
      payload: {
        id: toolId,
        ...(part.tool ? { name: part.tool, args } : {}),
        status: canonicalTerminalStatus(toolState.status === "error" ? "failed" : toolState.status),
        output: toolState.output ?? toolState.error,
        ...(stepId ? { stepId } : {}),
        ...(durationMs === undefined ? {} : { durationMs })
      }
    });
  }
  if ((native.type === "step_finish" || part.type === "step-finish") && stepId) {
    events.push({
      protocolVersion: 2,
      type: "model_step.finished",
      payload: {
        stepId,
        status: canonicalTerminalStatus("completed"),
        ...(typeof part.reason === "string" ? { finishReason: part.reason } : {}),
        ...(timestamp === undefined ? {} : { endedAtMs: timestamp })
      }
    });
  }
  if (native.type === "step_finish" || part.type === "step-finish") {
    events.push({
      protocolVersion: 2,
      type: "usage.update",
      payload: {
        ...(part.tokens ?? native.usage ?? {}),
        cost: part.cost,
        ...(stepId ? { stepId } : {})
      }
    });
    if (part.reason === "stop")
      events.push({ protocolVersion: 2, type: "run.completed", payload: {} });
  }
  if (native.type === "error")
    events.push({
      protocolVersion: 2,
      type: "run.failed",
      payload: {
        message: native.error?.data?.message ?? native.error?.message ?? "OpenCode failed",
        providerError: native.error
      }
    });
  return events;
}

/** Narrow an unknown value to a plain object (excluding arrays), used to guard tool input before spreading it. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Return OpenCode's provider-measured whole-millisecond tool duration. */
function toolDurationMs(time: { start?: unknown; end?: unknown } | undefined): number | undefined {
  if (typeof time?.start !== "number" || typeof time.end !== "number") return undefined;
  if (!Number.isSafeInteger(time.start) || !Number.isSafeInteger(time.end) || time.end < time.start)
    return undefined;
  return time.end - time.start;
}

/** Preserve a provider event clock only when it is a valid Unix-millisecond value. */
function providerTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Create an OpenCode adapter over the JSON CLI helper. OpenCode's stream ends
 * without an explicit terminal, so `onSuccess` synthesizes the closing
 * message.update/run.completed; run.failed is emitted inline by the normalizer.
 */
export class OpenCodeEventNormalizer {
  readonly #text = new Map<string, string>();
  readonly #tools = new Set<string>();

  normalize(native: OpenCodeNativeEvent): CanonicalEvent[] {
    return normalizeOpenCodeEvent(native).flatMap((event) => {
      if (
        event.type === "message.delta" &&
        typeof event.payload.messageId === "string" &&
        typeof event.payload.text === "string"
      ) {
        const id = event.payload.messageId;
        const previous = this.#text.get(id);
        const text = event.payload.text;
        this.#text.set(id, text);
        if (previous === undefined) return [event];
        if (previous === text) return [];
        if (text.startsWith(previous))
          return [{ ...event, payload: { ...event.payload, text: text.slice(previous.length) } }];
        return [
          {
            protocolVersion: 2,
            type: "message.update",
            payload: { ...event.payload, status: "streaming" }
          }
        ];
      }
      if (event.type === "tool_call.create") {
        const id = event.payload.id;
        if (this.#tools.has(id)) {
          const output = (native.part ?? native).state?.output;
          return output === undefined
            ? []
            : [
                {
                  protocolVersion: 2,
                  type: "tool_call.delta",
                  payload: {
                    id,
                    outputSnapshot: typeof output === "string" ? output : JSON.stringify(output)
                  }
                }
              ];
        }
        this.#tools.add(id);
      }
      return [event];
    });
  }
}

export function createOpenCodeAdapter({ command = "opencode" }: { command?: string } = {}) {
  const interactive = createAcpAdapter({
    type: "opencode",
    provider: "opencode",
    command,
    args: ["acp"],
    env: () => ({
      OPENCODE_CLIENT: "octo-runtime",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...(process.env.OPENCODE_CONFIG_CONTENT
          ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)
          : {}),
        permission: "ask"
      })
    })
  });
  const options: Parameters<typeof createJsonCliAdapter<OpenCodeNativeEvent>>[0] = {
    metadata: {
      mcp: true,
      type: "opencode",
      agentSources: ["provisioned"]
    },
    probe: () => probeCommand(command),
    buildCommand: (req: InvokeRequest) => buildOpenCodeCommand(req, command),
    normalize: normalizeOpenCodeEvent,
    onSuccess: (): CanonicalEvent[] => [
      {
        protocolVersion: 2,
        type: "message.update",
        payload: { role: "assistant", status: "completed" }
      },
      { protocolVersion: 2, type: "run.completed", payload: {} }
    ]
  };
  const adapter = createJsonCliAdapter<OpenCodeNativeEvent>(options);
  return {
    ...adapter,
    respondInteraction: interactive.respondInteraction,
    async *invoke(
      request: InvokeRequest,
      context?: AdapterInvocationContext
    ): AsyncGenerator<CanonicalEvent> {
      if (hasImageInput(request))
        throw new Error("UNSUPPORTED_INPUT_MODALITY: opencode does not encode image input");
      if (request.approvalMode === "assisted")
        throw new Error("APPROVAL_MODE_UNSUPPORTED: opencode has no qualified assisted policy");
      if (request.approvalMode === "ask") {
        yield* interactive.invoke(request, context);
        return;
      }
      const normalizer = new OpenCodeEventNormalizer();
      yield* createJsonCliAdapter<OpenCodeNativeEvent>({
        ...options,
        normalize: (native) => normalizer.normalize(native)
      }).invoke(request, context);
    }
  };
}

export const opencodeAdapter = createOpenCodeAdapter();
export default opencodeAdapter;

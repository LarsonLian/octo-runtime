/**
 * CodeBuddy adapter: wraps the CodeBuddy CLI spoken over ACP (Agent Client
 * Protocol) as JSON-RPC 2.0 on stdio, and normalizes its `session/update`
 * notifications into the harness canonical event stream.
 */
import {
  defineAdapter,
  observeBestEffort,
  observeProviderOutput,
  probeCommand,
  providerInputText,
  type AdapterInvocationContext,
  type CanonicalEvent,
  type InvokeRequest
} from "@mininglamp-oss/octo-harness-adapter-sdk";
import {
  acpLoadSessionParams,
  acpNewSessionParams,
  acpPromptParams,
  spawnAcpClient
} from "@mininglamp-oss/octo-harness-acp-client";
import type { AcpUpdate } from "@mininglamp-oss/octo-harness-acp-client";

/** One ACP `session/update` notification; fields are optional because their presence depends on `sessionUpdate`. */
interface CodeBuddyUpdate extends AcpUpdate {
  sessionUpdate?: string;
  content?: unknown;
  text?: string;
  toolCallId?: string;
  name?: string;
  title?: string;
  rawInput?: unknown;
  input?: unknown;
  status?: string;
  output?: unknown;
}

/** Translate one ACP update into canonical events; unrecognized update kinds yield nothing. */
export function normalizeCodeBuddyUpdate(update: CodeBuddyUpdate): CanonicalEvent[] {
  const type = update.sessionUpdate ?? update.type;
  if (type === "agent_message_chunk" || type === "agent_thought_chunk") {
    const text = isRecord(update.content) && typeof update.content.text === "string" ? update.content.text : update.text;
    if (typeof text !== "string") return [];
    return [{
      type: "message.delta",
      payload: type === "agent_thought_chunk"
        ? {
            // ACP does not declare whether thoughts are user-visible, so exposure stays "unknown".
            text,
            channel: "analysis",
            exposure: "unknown",
            provenance: { provider: "codebuddy", nativeEvent: "agent_thought_chunk" }
          }
        : { text, channel: "final" }
    }];
  }
  if (type === "tool_call") {
    if (!update.toolCallId) return [];
    const value = update.rawInput ?? update.input;
    const args = isRecord(value) ? value : value == null ? {} : { value };
    return [{
      type: "tool_call.create",
      payload: { id: update.toolCallId, name: update.name ?? update.title ?? "provider_tool", args }
    }];
  }
  if (type === "tool_call_update") {
    if (!update.toolCallId || !update.status) return [];
    return [{
      type: "tool_call.update",
      payload: { id: update.toolCallId, status: update.status, output: update.content ?? update.output }
    }];
  }
  if (type === "usage") return [{ type: "usage.update", payload: { ...update.usage, model: update.model } }];
  return [];
}

/**
 * Create a CodeBuddy adapter. Each invocation spawns an ACP client, initializes
 * the connection, then either loads the stored provider session or creates a
 * new one. The final `message.update`/`run.finished` terminals are synthesized
 * here because ACP prompt streams end silently rather than with a terminal.
 */
export function createCodeBuddyAdapter({ acpClientFactory = spawnAcpClient, command = "codebuddy" }: { acpClientFactory?: typeof spawnAcpClient; command?: string } = {}) {
  return defineAdapter({
    metadata: { type: "codebuddy", capabilities: ["session.serialize", "tool.canonical"] },
    probe: () => probeCommand(command),
    async *invoke(req: InvokeRequest, context?: AdapterInvocationContext): AsyncGenerator<CanonicalEvent> {
      const client = acpClientFactory({
        command, args: ["--acp", "--permission-mode", req.agentConfig?.permissionMode ?? "acceptEdits"],
        cwd: req.workdir, signal: req.signal
      });
      try {
        await client.initialize();
        // Reserve the real JSON-RPC id before capture so every observation for
        // this request matches the id subsequently written to the ACP process.
        const requestedSessionId = req.providerSession?.sessionId;
        const sessionMethod = requestedSessionId ? "session/load" : "session/new";
        const sessionParams = requestedSessionId
          ? acpLoadSessionParams(requestedSessionId, { cwd: req.workdir })
          : acpNewSessionParams({ cwd: req.workdir, model: req.agentConfig?.model });
        const sessionRequestId = client.reserveRequestId();
        await context?.observe({
          event: "provider.input",
          rpcMethod: sessionMethod,
          providerRequestId: String(sessionRequestId),
          ...(requestedSessionId ? { providerSessionId: requestedSessionId } : {}),
          carrier: { kind: "json_params", content: { method: sessionMethod, params: sessionParams } }
        });
        let session: { id: string };
        try {
          const requestOptions = {
            requestId: sessionRequestId,
            ...(requestedSessionId ? { timeoutMs: 600_000 } : {}),
            onWritten: () => observeBestEffort(context, {
              event: "provider.dispatch.written",
              rpcMethod: sessionMethod,
              providerRequestId: String(sessionRequestId),
              ...(requestedSessionId ? { providerSessionId: requestedSessionId } : {})
            })
          };
          const sessionResult = await client.request(sessionMethod, sessionParams, requestOptions);
          if (requestedSessionId) {
            session = { id: requestedSessionId };
          } else {
            const sessionId = isRecord(sessionResult) && typeof sessionResult.sessionId === "string"
              ? sessionResult.sessionId
              : undefined;
            if (!sessionId) throw new Error("ACP session/new returned no sessionId");
            session = { id: sessionId };
          }
          observeBestEffort(context, {
            event: "provider.dispatch.acknowledged",
            rpcMethod: sessionMethod,
            providerRequestId: String(sessionRequestId),
            providerSessionId: session.id
          });
        } catch (error) {
          observeBestEffort(context, {
            event: "provider.dispatch.failed",
            rpcMethod: sessionMethod,
            providerRequestId: String(sessionRequestId),
            ...(requestedSessionId ? { providerSessionId: requestedSessionId } : {}),
            data: { error: error instanceof Error ? error.message : String(error) }
          });
          throw error;
        }
        // The Octo Harness session stores only the provider sessionId; both the
        // new and resume paths converge on the same ACP prompt stream.
        yield { type: "session.update", payload: { providerSession: { sessionId: session.id, resumable: true, model: req.agentConfig?.model } } };
        yield { type: "message.create", payload: { role: "assistant", status: "streaming" } };
        // Build once and reuse for capture and dispatch. Reconstructing the
        // carrier separately risks evaluating content that was never sent.
        const prompt = `${providerInputText(req)}\n\n${req.appendInstructions}`;
        const promptParams = acpPromptParams(session.id, prompt);
        const promptRequestId = client.reserveRequestId();
        // The await is the strict-capture gate and occurs before session/prompt
        // is written to the ACP subprocess.
        await context?.observe({
          event: "provider.input",
          rpcMethod: "session/prompt",
          providerSessionId: session.id,
          providerRequestId: String(promptRequestId),
          carrier: {
            kind: "json_params",
            content: { method: "session/prompt", params: promptParams }
          }
        });
        try {
          let firstOutput = true;
          for await (const update of client.prompt(session.id, prompt, {
            requestId: promptRequestId,
            params: promptParams,
            onWritten: () => {
              // ACP's stdin callback establishes local write completion only.
              observeBestEffort(context, {
                event: "provider.dispatch.written",
                rpcMethod: "session/prompt",
                providerSessionId: session.id,
                providerRequestId: String(promptRequestId)
              });
            }
          })) {
            if (firstOutput) {
              firstOutput = false;
              // session/update may precede the final response and is therefore
              // an output milestone, not request acknowledgement.
              observeBestEffort(context, {
                event: "provider.output.first",
                rpcMethod: "session/update",
                providerSessionId: session.id,
                providerRequestId: String(promptRequestId)
              });
            }
            const events = normalizeCodeBuddyUpdate(update);
            const nativeType = typeof update.sessionUpdate === "string"
              ? update.sessionUpdate
              : update.type;
            observeProviderOutput(context, events, {
              rpcMethod: "session/update",
              providerSessionId: session.id,
              providerRequestId: String(promptRequestId),
              native: {
                type: nativeType,
                ...(update.model ? { model: update.model } : {})
              }
            });
            for (const event of events) yield event;
          }
          // AcpClient.prompt completes only after the session/prompt response;
          // this is the protocol acknowledgement boundary.
          observeBestEffort(context, {
            event: "provider.dispatch.acknowledged",
            rpcMethod: "session/prompt",
            providerSessionId: session.id,
            providerRequestId: String(promptRequestId)
          });
          const completed: CanonicalEvent = {
            type: "message.update",
            payload: { role: "assistant", status: "completed" }
          };
          observeProviderOutput(context, [completed], {
            rpcMethod: "session/prompt",
            providerSessionId: session.id,
            providerRequestId: String(promptRequestId),
            native: { type: "session/prompt.response" }
          });
          yield completed;
          yield { type: "run.finished", payload: {} };
        } catch (error) {
          observeBestEffort(context, {
            event: "provider.dispatch.failed",
            rpcMethod: "session/prompt",
            providerSessionId: session.id,
            providerRequestId: String(promptRequestId),
            data: { error: error instanceof Error ? error.message : String(error) }
          });
          throw error;
        }
      } finally { await client.close?.(); }
    }
  });
}

/** Narrow an unknown value to a plain object (excluding arrays), used to guard ACP payloads before indexing. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const codebuddyAdapter = createCodeBuddyAdapter();
export default codebuddyAdapter;

import {
  defineAdapter,
  providerInputText,
  type CanonicalEvent,
  type InvokeRequest
} from "@mininglamp-oss/octo-harness-adapter-sdk";
import { isTerminal } from "@mininglamp-oss/octo-harness-protocol";
import {
  DifyClient,
  DifyProtocolError,
  asRecord,
  optionalNumber,
  optionalRecord,
  optionalString,
  parseDifyEvent,
  parseSse,
  type DifyClientOptions,
  type JsonRecord
} from "@mininglamp-oss/octo-harness-dify-client";

export type DifyConversationMode = "auto" | "chatbot" | "chatflow";

export interface DifyChatflowAdapterOptions extends DifyClientOptions {
  type?: string;
  user?: string;
  applicationMode?: DifyConversationMode;
  defaultInputs?: JsonRecord;
  instructionInput?: string;
  workflowId?: string;
  autoGenerateName?: boolean;
  exposeWorkflowEvents?: boolean;
  maxFrameChars?: number;
}

export interface DifyChatState {
  runId: string;
  user: string;
  applicationMode: DifyConversationMode;
  exposeWorkflowEvents: boolean;
  workflowSeen: boolean;
  messageOpen: boolean;
  messageId?: string;
  sessionReported?: string;
  taskId?: string;
  workflowRunId?: string;
}

export interface DifyChatRequest {
  body: JsonRecord;
  user: string;
}

export function createDifyChatflowAdapter(options: DifyChatflowAdapterOptions = {}) {
  const client = new DifyClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    apiKeyEnv: options.apiKeyEnv ?? "DIFY_CHATFLOW_API_KEY",
    userPrefix: options.userPrefix,
    fetch: options.fetch
  });
  const adapterType = options.type ?? "dify-chatflow";

  return defineAdapter({
    metadata: {
      type: adapterType,
      capabilities: ["session.serialize"],
      processModel: "remote-api",
      transport: "https+sse"
    },
    probe: () => client.probe(),
    async *invoke(request: InvokeRequest): AsyncGenerator<CanonicalEvent> {
      const prepared = buildDifyChatRequest(request, options, client);
      const state: DifyChatState = {
        runId: request.runId,
        user: prepared.user,
        applicationMode: options.applicationMode ?? "auto",
        exposeWorkflowEvents: options.exposeWorkflowEvents !== false,
        workflowSeen: false,
        messageOpen: false,
        sessionReported: request.providerSession?.sessionId
      };
      let terminal = false;

      try {
        const response = await client.openSse("/chat-messages", prepared.body, request.signal);
        for await (const frame of parseSse(response.body!, { maxFrameChars: options.maxFrameChars })) {
          const native = parseDifyEvent(frame);
          if (!native) continue;
          const events = normalizeDifyChatEvent(native, state);
          for (const event of events) {
            terminal ||= isTerminal(event);
            yield event;
          }
          if (terminal) return;
        }
        throw new DifyProtocolError("Dify chat stream ended before a terminal event");
      } finally {
        if (request.signal?.aborted && state.taskId) {
          try {
            await client.stop(`/chat-messages/${encodeURIComponent(state.taskId)}/stop`, state.user);
          } catch {
            // Host still reports the requested cancellation; provider stop failure remains an operational concern.
          }
        }
      }
    }
  });
}

export function buildDifyChatRequest(
  request: InvokeRequest,
  options: DifyChatflowAdapterOptions,
  client = new DifyClient(options)
): DifyChatRequest {
  const providerOptions = optionalRecord(request.agentConfig.providerOptions) ?? {};
  const providerInputs = optionalRecord(providerOptions.inputs) ?? {};
  const turnInputs = optionalRecord(request.context.workflowInputs) ?? {};
  const inputs: JsonRecord = { ...(options.defaultInputs ?? {}), ...providerInputs, ...turnInputs };
  const instructionInput = optionalString(providerOptions.instructionInput) ?? options.instructionInput;
  if (instructionInput && request.appendInstructions) inputs[instructionInput] = request.appendInstructions;

  const providerSession = request.providerSession as JsonRecord | undefined;
  const user = client.userFor(request.sessionId, providerSession, optionalString(providerOptions.user) ?? options.user);
  const files = mapDifyFiles(request.context.attachments);
  const workflowId = optionalString(providerOptions.workflowId) ?? options.workflowId;
  const body: JsonRecord = {
    inputs,
    query: providerInputText(request),
    response_mode: "streaming",
    conversation_id: request.providerSession?.sessionId ?? "",
    user,
    auto_generate_name: options.autoGenerateName !== false
  };
  if (files.length > 0) body.files = files;
  if (workflowId) body.workflow_id = workflowId;
  return { body, user };
}

export function normalizeDifyChatEvent(native: JsonRecord, state: DifyChatState): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  const eventType = optionalString(native.event) ?? "";
  const data = optionalRecord(native.data) ?? {};
  state.taskId = optionalString(native.task_id) ?? state.taskId;
  state.workflowRunId = optionalString(native.workflow_run_id) ?? optionalString(data.id) ?? state.workflowRunId;

  const conversationId = optionalString(native.conversation_id);
  if (conversationId && conversationId !== state.sessionReported) {
    state.sessionReported = conversationId;
    events.push({
      type: "session.update",
      payload: {
        providerSession: {
          sessionId: conversationId,
          resumable: true,
          provider: "dify",
          user: state.user,
          mode: optionalString(native.mode) ?? (state.workflowSeen ? "advanced-chat" : "chat")
        }
      }
    });
  }

  if (eventType === "workflow_started") {
    state.workflowSeen = true;
    if (state.exposeWorkflowEvents) {
      events.push({
        type: "surface.create",
        payload: {
          id: workflowSurfaceId(state),
          kind: "workflow_progress",
          status: "running",
          provider: "dify",
          taskId: state.taskId,
          workflowRunId: state.workflowRunId
        }
      });
    }
    return events;
  }

  if (eventType === "node_started" || eventType === "node_finished" || eventType === "iteration_started" || eventType === "iteration_next" || eventType === "iteration_completed" || eventType === "loop_started" || eventType === "loop_next" || eventType === "loop_completed") {
    state.workflowSeen = true;
    if (state.exposeWorkflowEvents) {
      events.push({
        type: "surface.delta",
        payload: {
          id: workflowSurfaceId(state),
          kind: "workflow_progress",
          providerEvent: eventType,
          workflowRunId: state.workflowRunId,
          node: projectNode(data)
        }
      });
    }
    return events;
  }

  if (eventType === "message" || eventType === "agent_message") {
    const answer = typeof native.answer === "string" ? native.answer : "";
    const messageId = optionalString(native.message_id) ?? optionalString(native.id) ?? state.messageId ?? `${state.runId}:final`;
    state.messageId = messageId;
    if (!state.messageOpen) {
      state.messageOpen = true;
      events.push({ type: "message.create", payload: { role: "assistant", status: "streaming", channel: "final", messageId } });
    }
    if (answer) events.push({ type: "message.delta", payload: { channel: "final", messageId, text: answer } });
    return events;
  }

  if (eventType === "message_replace") {
    const answer = typeof native.answer === "string" ? native.answer : "";
    const messageId = state.messageId ?? optionalString(native.message_id) ?? `${state.runId}:final`;
    state.messageId = messageId;
    state.messageOpen = true;
    events.push({ type: "message.update", payload: { role: "assistant", status: "streaming", channel: "final", messageId, text: answer, replace: true } });
    return events;
  }

  if (eventType === "agent_thought" && state.exposeWorkflowEvents) {
    events.push({
      type: "surface.delta",
      payload: {
        id: workflowSurfaceId(state),
        kind: "workflow_progress",
        providerEvent: eventType,
        step: optionalNumber(native.position),
        tool: optionalString(native.tool),
        status: "running"
      }
    });
    return events;
  }

  if (eventType === "message_file") {
    events.push({
      type: "surface.create",
      payload: {
        id: optionalString(native.id) ?? `${state.runId}:file`,
        kind: "provider_file",
        status: "available",
        provider: "dify",
        messageId: optionalString(native.message_id) ?? state.messageId,
        url: optionalString(native.url),
        mimeType: optionalString(native.mime_type),
        filename: optionalString(native.name)
      }
    });
    return events;
  }

  if (eventType === "message_end") {
    const usage = usageEvent(native.metadata, data);
    if (usage) events.push(usage);
    closeMessage(events, state, "completed");
    const shouldFinish = state.applicationMode === "chatbot" || (state.applicationMode === "auto" && !state.workflowSeen);
    if (shouldFinish) events.push({ type: "run.finished", payload: { provider: "dify", taskId: state.taskId } });
    return events;
  }

  if (eventType === "human_input_required") {
    state.workflowSeen = true;
    if (state.exposeWorkflowEvents) {
      events.push({
        type: "surface.update",
        payload: {
          id: workflowSurfaceId(state),
          kind: "workflow_progress",
          status: "waiting_for_input",
          workflowRunId: state.workflowRunId,
          formToken: optionalString(native.form_token) ?? optionalString(data.form_token)
        }
      });
    }
    return events;
  }

  if (eventType === "workflow_paused") {
    closeMessage(events, state, "stopped");
    if (state.exposeWorkflowEvents) events.push(workflowSurfaceTerminal(state, "paused", data));
    events.push({
      type: "run.stopped",
      payload: {
        reason: "dify_workflow_paused",
        provider: "dify",
        workflowRunId: state.workflowRunId,
        resumable: true
      }
    });
    return events;
  }

  if (eventType === "workflow_finished") {
    state.workflowSeen = true;
    const status = optionalString(data.status) ?? optionalString(native.status) ?? "unknown";
    const usage = usageEvent(native.metadata, data);
    if (usage) events.push(usage);
    closeMessage(events, state, status === "succeeded" ? "completed" : status === "stopped" ? "stopped" : "failed");
    if (state.exposeWorkflowEvents) events.push(workflowSurfaceTerminal(state, status, data));
    if (status === "succeeded") {
      events.push({ type: "run.finished", payload: { provider: "dify", taskId: state.taskId, workflowRunId: state.workflowRunId } });
    } else if (status === "stopped") {
      events.push({ type: "run.stopped", payload: { reason: "dify_workflow_stopped", provider: "dify", taskId: state.taskId, workflowRunId: state.workflowRunId } });
    } else {
      events.push({
        type: "run.error",
        payload: {
          message: optionalString(data.error) ?? `Dify workflow finished with status ${status}`,
          code: "dify_workflow_failed",
          status,
          provider: "dify",
          taskId: state.taskId,
          workflowRunId: state.workflowRunId
        }
      });
    }
    return events;
  }

  if (eventType === "error") {
    closeMessage(events, state, "failed");
    events.push({
      type: "run.error",
      payload: {
        message: optionalString(native.message) ?? "Dify stream error",
        code: optionalString(native.code) ?? "dify_stream_error",
        status: "failed",
        providerStatus: native.status,
        provider: "dify",
        taskId: state.taskId,
        workflowRunId: state.workflowRunId
      }
    });
  }
  return events;
}

function mapDifyFiles(value: unknown): JsonRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("InvokeRequest.context.attachments must be an array");
  return value.map((item, index) => {
    const attachment = asRecord(item, `attachments[${index}]`);
    const type = optionalString(attachment.type) ?? mediaType(optionalString(attachment.mimeType));
    if (!type || !["document", "image", "audio", "video", "custom"].includes(type)) {
      throw new TypeError(`attachments[${index}].type must be document, image, audio, video, or custom`);
    }
    const url = optionalString(attachment.url);
    const uploadFileId = optionalString(attachment.uploadFileId) ?? optionalString(attachment.upload_file_id);
    if (url) return { type, transfer_method: "remote_url", url };
    if (uploadFileId) return { type, transfer_method: "local_file", upload_file_id: uploadFileId };
    throw new TypeError(`attachments[${index}] requires url or uploadFileId`);
  });
}

function mediaType(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

function closeMessage(events: CanonicalEvent[], state: DifyChatState, status: string): void {
  if (!state.messageOpen) return;
  events.push({
    type: "message.update",
    payload: { role: "assistant", status, channel: "final", messageId: state.messageId ?? `${state.runId}:final` }
  });
  state.messageOpen = false;
}

function usageEvent(metadataValue: unknown, data: JsonRecord): CanonicalEvent | undefined {
  const metadata = optionalRecord(metadataValue);
  const usage = optionalRecord(metadata?.usage);
  const inputTokens = optionalNumber(usage?.prompt_tokens);
  const outputTokens = optionalNumber(usage?.completion_tokens);
  const totalTokens = optionalNumber(usage?.total_tokens) ?? optionalNumber(data.total_tokens);
  const totalPrice = usage?.total_price;
  const currency = optionalString(usage?.currency);
  const latency = optionalNumber(usage?.latency) ?? optionalNumber(data.elapsed_time);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined && totalPrice === undefined && latency === undefined) return undefined;
  return {
    type: "usage.update",
    payload: {
      provider: "dify",
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(totalTokens === undefined ? {} : { totalTokens }),
      ...(totalPrice === undefined ? {} : { totalPrice }),
      ...(currency === undefined ? {} : { currency }),
      ...(latency === undefined ? {} : { latency })
    }
  };
}

function workflowSurfaceId(state: DifyChatState): string {
  return `${state.runId}:dify-workflow`;
}

function workflowSurfaceTerminal(state: DifyChatState, status: string, data: JsonRecord): CanonicalEvent {
  return {
    type: "surface.update",
    payload: {
      id: workflowSurfaceId(state),
      kind: "workflow_progress",
      status,
      provider: "dify",
      taskId: state.taskId,
      workflowRunId: state.workflowRunId,
      totalTokens: optionalNumber(data.total_tokens),
      totalSteps: optionalNumber(data.total_steps),
      elapsedTime: optionalNumber(data.elapsed_time),
      error: optionalString(data.error)
    }
  };
}

function projectNode(data: JsonRecord): JsonRecord {
  return {
    id: optionalString(data.node_id) ?? optionalString(data.id),
    type: optionalString(data.node_type),
    title: optionalString(data.title),
    status: optionalString(data.status),
    index: optionalNumber(data.index),
    elapsedTime: optionalNumber(data.elapsed_time),
    error: optionalString(data.error)
  };
}

export const difyChatflowAdapter = createDifyChatflowAdapter();
export default difyChatflowAdapter;

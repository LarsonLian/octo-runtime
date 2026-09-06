import { defineAdapter, providerInputText, type CanonicalEvent, type InvokeRequest } from "@mininglamp-oss/octo-harness-adapter-sdk";
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

export type DifyStatelessMode = "workflow" | "completion";

/**
 * Options for the stateless adapter. `applicationMode` selects the endpoint and
 * terminal contract: `workflow` hits `/workflows/run` and finishes on
 * `workflow_finished`, `completion` hits `/completion-messages` and finishes on
 * `message_end`. `promptInput`/`outputKey` name the workflow input/output fields
 * carrying the prompt text and the answer.
 */
export interface DifyWorkflowAdapterOptions extends DifyClientOptions {
  type?: string;
  user?: string;
  applicationMode?: DifyStatelessMode;
  defaultInputs?: JsonRecord;
  promptInput?: string;
  instructionInput?: string;
  outputKey?: string;
  exposeWorkflowEvents?: boolean;
  maxFrameChars?: number;
}

export interface DifyStatelessRequest {
  path: "/workflows/run" | "/completion-messages";
  body: JsonRecord;
  user: string;
}

/** Mutable per-invocation state for the stateless normalizer; `textEmitted` guards against duplicating the answer both streamed and from `workflow_finished` outputs. */
export interface DifyStatelessState {
  runId: string;
  user: string;
  mode: DifyStatelessMode;
  outputKey?: string;
  exposeWorkflowEvents: boolean;
  messageOpen: boolean;
  messageId?: string;
  textEmitted: boolean;
  taskId?: string;
  workflowRunId?: string;
}

/**
 * Build a Dify adapter for the two stateless (no conversation) app kinds:
 * workflow and completion. Unlike chatflow it never reports a provider session,
 * so `capabilities` is empty. The invocation opens one SSE stream, normalizes to
 * canonical events, and best-effort stops the provider task on abort in
 * `finally` (the stop path differs per mode).
 */
export function createDifyWorkflowAdapter(options: DifyWorkflowAdapterOptions = {}) {
  const mode = options.applicationMode ?? "workflow";
  const client = new DifyClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    apiKeyEnv: options.apiKeyEnv ?? (mode === "completion" ? "DIFY_COMPLETION_API_KEY" : "DIFY_WORKFLOW_API_KEY"),
    userPrefix: options.userPrefix,
    fetch: options.fetch
  });
  const adapterType = options.type ?? (mode === "completion" ? "dify-completion" : "dify-workflow");

  return defineAdapter({
    metadata: {
      type: adapterType,
      capabilities: [],
      processModel: "remote-api",
      transport: "https+sse"
    },
    probe: () => client.probe(),
    async *invoke(request: InvokeRequest): AsyncGenerator<CanonicalEvent> {
      const prepared = buildDifyStatelessRequest(request, options, client);
      const state: DifyStatelessState = {
        runId: request.runId,
        user: prepared.user,
        mode,
        outputKey: options.outputKey,
        exposeWorkflowEvents: options.exposeWorkflowEvents !== false,
        messageOpen: false,
        textEmitted: false
      };
      let terminal = false;

      try {
        const response = await client.openSse(prepared.path, prepared.body, request.signal);
        for await (const frame of parseSse(response.body!, { maxFrameChars: options.maxFrameChars })) {
          const native = parseDifyEvent(frame);
          if (!native) continue;
          const events = normalizeDifyStatelessEvent(native, state);
          for (const event of events) {
            terminal ||= isTerminal(event);
            yield event;
          }
          if (terminal) return;
        }
        throw new DifyProtocolError(`Dify ${mode} stream ended before a terminal event`);
      } finally {
        if (request.signal?.aborted && state.taskId) {
          const prefix = mode === "completion" ? "/completion-messages" : "/workflows/tasks";
          try {
            await client.stop(`${prefix}/${encodeURIComponent(state.taskId)}/stop`, state.user);
          } catch {
            // Host still reports the requested cancellation; provider stop failure is observed separately.
          }
        }
      }
    }
  });
}

/**
 * Assemble the endpoint path and request body for a stateless turn. Inputs layer
 * defaults < provider options, then the prompt text and append-only instructions
 * are placed into their named input fields, and per-turn `workflowInputs` are
 * applied last so they win. Completion mode additionally sends `query`.
 */
export function buildDifyStatelessRequest(
  request: InvokeRequest,
  options: DifyWorkflowAdapterOptions,
  client = new DifyClient(options)
): DifyStatelessRequest {
  const mode = options.applicationMode ?? "workflow";
  const providerOptions = optionalRecord(request.agentConfig.providerOptions) ?? {};
  const providerInputs = optionalRecord(providerOptions.inputs) ?? {};
  const turnInputs = optionalRecord(request.context.workflowInputs) ?? {};
  const inputs: JsonRecord = { ...(options.defaultInputs ?? {}), ...providerInputs };
  const promptInput = optionalString(providerOptions.promptInput) ?? options.promptInput;
  const instructionInput = optionalString(providerOptions.instructionInput) ?? options.instructionInput;
  if (promptInput) inputs[promptInput] = providerInputText(request);
  if (instructionInput && request.appendInstructions) inputs[instructionInput] = request.appendInstructions;
  Object.assign(inputs, turnInputs);

  const user = client.userFor(request.sessionId, undefined, optionalString(providerOptions.user) ?? options.user);
  const body: JsonRecord = { inputs, response_mode: "streaming", user };
  const files = mapDifyFiles(request.context.attachments);
  if (files.length > 0) body.files = files;
  if (mode === "completion") body.query = providerInputText(request);
  return {
    path: mode === "completion" ? "/completion-messages" : "/workflows/run",
    body,
    user
  };
}

/**
 * Translate one native stateless SSE event into canonical events, mutating
 * `state`. Text arrives either as streamed `message`/`text_chunk` deltas or, for
 * workflows that don't stream, once from `workflow_finished` outputs — the
 * `textEmitted` guard ensures the answer is surfaced exactly once. Non-string or
 * unmatched outputs are exposed as a `structured_output` surface instead.
 */
export function normalizeDifyStatelessEvent(native: JsonRecord, state: DifyStatelessState): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  const eventType = optionalString(native.event) ?? "";
  const data = optionalRecord(native.data) ?? {};
  state.taskId = optionalString(native.task_id) ?? state.taskId;
  state.workflowRunId = optionalString(native.workflow_run_id) ?? optionalString(data.id) ?? state.workflowRunId;

  if (eventType === "workflow_started") {
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

  if (isWorkflowProgressEvent(eventType)) {
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

  if (eventType === "message" || eventType === "text_chunk") {
    const text = eventType === "message"
      ? (typeof native.answer === "string" ? native.answer : "")
      : (typeof data.text === "string" ? data.text : "");
    if (text) appendText(events, state, text, optionalString(native.message_id) ?? optionalString(native.id));
    return events;
  }

  if (eventType === "message_replace") {
    const text = typeof native.answer === "string" ? native.answer : "";
    const messageId = state.messageId ?? optionalString(native.message_id) ?? `${state.runId}:final`;
    state.messageId = messageId;
    state.messageOpen = true;
    state.textEmitted = true;
    events.push({ type: "message.update", payload: { role: "assistant", status: "streaming", channel: "final", messageId, text, replace: true } });
    return events;
  }

  if (eventType === "message_end") {
    const usage = usageEvent(native.metadata, data);
    if (usage) events.push(usage);
    closeMessage(events, state, "completed");
    if (state.mode === "completion") events.push({ type: "run.finished", payload: { provider: "dify", taskId: state.taskId, applicationMode: "completion" } });
    return events;
  }

  if (eventType === "human_input_required") {
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
    events.push({ type: "run.stopped", payload: { reason: "dify_workflow_paused", provider: "dify", workflowRunId: state.workflowRunId, resumable: true } });
    return events;
  }

  if (eventType === "workflow_finished") {
    const status = optionalString(data.status) ?? optionalString(native.status) ?? "unknown";
    const outputs = optionalRecord(data.outputs);
    const output = outputs ? selectOutput(outputs, state.outputKey) : undefined;
    if (!state.textEmitted && output !== undefined) appendText(events, state, output, undefined);
    if (outputs && output === undefined) {
      events.push({
        type: "surface.create",
        payload: {
          id: `${state.runId}:dify-output`,
          kind: "structured_output",
          status: "available",
          provider: "dify",
          outputs
        }
      });
    }
    const usage = usageEvent(native.metadata, data);
    if (usage) events.push(usage);
    closeMessage(events, state, status === "succeeded" ? "completed" : status === "stopped" ? "stopped" : "failed");
    if (state.exposeWorkflowEvents) events.push(workflowSurfaceTerminal(state, status, data));
    if (status === "succeeded") {
      events.push({ type: "run.finished", payload: { provider: "dify", taskId: state.taskId, workflowRunId: state.workflowRunId, applicationMode: "workflow" } });
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

/** Emit `message.create` on first text then a `message.delta`, opening the assistant message lazily and marking `textEmitted`. */
function appendText(events: CanonicalEvent[], state: DifyStatelessState, text: string, nativeMessageId: string | undefined): void {
  const messageId = state.messageId ?? nativeMessageId ?? `${state.runId}:final`;
  state.messageId = messageId;
  if (!state.messageOpen) {
    state.messageOpen = true;
    events.push({ type: "message.create", payload: { role: "assistant", status: "streaming", channel: "final", messageId } });
  }
  state.textEmitted = true;
  events.push({ type: "message.delta", payload: { channel: "final", messageId, text } });
}

/** Emit the closing `message.update` for the open assistant message, if any, and mark it closed. */
function closeMessage(events: CanonicalEvent[], state: DifyStatelessState, status: string): void {
  if (!state.messageOpen) return;
  events.push({ type: "message.update", payload: { role: "assistant", status, channel: "final", messageId: state.messageId ?? `${state.runId}:final` } });
  state.messageOpen = false;
}

/**
 * Pick the answer string from a workflow's `outputs`. With an explicit
 * `outputKey`, non-string values are JSON-stringified; without one, try common
 * keys (text/answer/result/output), else fall back to the sole entry when the
 * output map has exactly one. Returns undefined when no single answer is clear.
 */
function selectOutput(outputs: JsonRecord, outputKey: string | undefined): string | undefined {
  const keys = outputKey ? [outputKey] : ["text", "answer", "result", "output"];
  for (const key of keys) {
    const value = outputs[key];
    if (typeof value === "string") return value;
    if (value !== undefined && outputKey) return JSON.stringify(value);
  }
  const entries = Object.entries(outputs);
  if (entries.length === 1) {
    const value = entries[0][1];
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  return undefined;
}

/** Map InvokeRequest attachments to Dify's file shape, resolving the file `type` from an explicit value or the MIME type, and choosing remote_url vs local_file transfer. */
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

/** Build a `usage.update` from Dify's `metadata.usage`, returning undefined when no token/price/latency field is present so no empty event is emitted. */
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

/** True for the node/iteration/loop lifecycle events surfaced as workflow-progress deltas. */
function isWorkflowProgressEvent(eventType: string): boolean {
  return [
    "node_started", "node_finished",
    "iteration_started", "iteration_next", "iteration_completed",
    "loop_started", "loop_next", "loop_completed"
  ].includes(eventType);
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

/** Stable per-run id for the single workflow-progress surface, so create/delta/update events all address the same surface. */
function workflowSurfaceId(state: DifyStatelessState): string {
  return `${state.runId}:dify-workflow`;
}

/** Final `surface.update` closing the workflow-progress surface with aggregate totals and any error. */
function workflowSurfaceTerminal(state: DifyStatelessState, status: string, data: JsonRecord): CanonicalEvent {
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

export const difyWorkflowAdapter = createDifyWorkflowAdapter();
export default difyWorkflowAdapter;

import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import {
  invocationInput,
  canonicalEvents,
  assertInvokeRequest
} from "@mininglamp-oss/octo-runtime-protocol";

export function preparedFrames(host, type, request, options = {}) {
  assertInvokeRequest(request);
  return host.invokeFrames(invocationInput(request, options.protocolMode ?? "native", type), {
    signal: request.signal,
    executionEnvOverrides: request.executionEnvOverrides,
    ...(options.streamLimits ? { streamLimits: options.streamLimits } : {})
  });
}

export function preparedSubmit(host, type, request, options = {}) {
  return host.submit(invocationInput(request, options.protocolMode ?? "native", type), {
    signal: request.signal,
    executionEnvOverrides: request.executionEnvOverrides,
    ...(options.streamLimits ? { streamLimits: options.streamLimits } : {})
  });
}

export function preparedTestInvoke(source) {
  return async function* (type, request, options = {}) {
    const frames = source(type, request, options);
    if (options.protocolMode === "canonical") yield* canonicalEvents(frames);
    else yield* frames;
  };
}

export function codexAppServerFixture({
  method = "item/commandExecution/requestApproval",
  holdResponseWrites = false,
  turnStartError,
  skills = [],
  config = {}
} = {}) {
  const child = new EventEmitter();
  const writes = [];
  const pendingWrites = [];
  const send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
  const requestInteraction = () =>
    send({
      id: "native-request-1",
      method,
      params: {
        threadId: "thread-fixture",
        turnId: "turn-fixture",
        itemId: "tool-fixture",
        command: "pnpm test",
        cwd: "/workspace",
        permissions: { network: { enabled: true } }
      }
    });
  const close = (code = 1, signal = null) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.signalCode = signal;
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code, signal);
  };
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const message = JSON.parse(chunk.toString());
      writes.push(message);
      if (message.method === "initialize") send({ id: message.id, result: {} });
      if (message.method === "config/read") send({ id: message.id, result: { config } });
      if (["thread/start", "thread/resume"].includes(message.method))
        send({ id: message.id, result: { thread: { id: "thread-fixture" } } });
      if (["skills/extraRoots/set", "skills/config/write"].includes(message.method))
        send({ id: message.id, result: {} });
      if (message.method === "skills/list")
        send({ id: message.id, result: { data: [{ skills }] } });
      if (message.method === "turn/start") {
        if (turnStartError)
          send({ id: message.id, error: { code: -32000, message: turnStartError } });
        else {
          send({ id: message.id, result: { turn: { id: "turn-fixture" } } });
          setImmediate(requestInteraction);
        }
      }
      if (message.method === "turn/interrupt") send({ id: message.id, result: {} });
      if (holdResponseWrites && message.id === "native-request-1" && !message.method)
        pendingWrites.push(callback);
      else callback();
    },
    final(callback) {
      close(0);
      callback();
    }
  });
  child.kill = (signal) => {
    close(null, signal);
    return true;
  };
  return {
    spawnFn: () => child,
    writes,
    close,
    requestInteraction,
    flushResponseWrites: () => {
      for (const callback of pendingWrites.splice(0)) callback();
    },
    complete: () =>
      send({
        method: "turn/completed",
        params: {
          threadId: "thread-fixture",
          turnId: "turn-fixture",
          turn: { id: "turn-fixture", status: "completed" }
        }
      })
  };
}

export function contextEnvelope(items = []) {
  return { schema: "octo.context-envelope/v3", items: structuredClone(items) };
}

export function resolvedRuntimeSelection(runtimeId = "runtime-1") {
  return {
    schema: "octo.runtime-selection/v2",
    selection_mode: "explicit",
    explicit_runtime_id: runtimeId,
    authorized_candidates: [
      { runtime_id: runtimeId, priority: 1, owner_subject_type: "user", owner_subject_id: "user-1" }
    ],
    offline_behavior: "wait",
    failover: "none"
  };
}

export function executionContext(plan, items = []) {
  return contextEnvelope([
    {
      namespace: "octo.execution",
      name: "adapter",
      payload: {
        type: plan.adapter_type,
        ...(plan.provider_agent_id ? { provider_agent_id: plan.provider_agent_id } : {})
      }
    },
    {
      namespace: "octo.execution",
      name: "workspace",
      payload: plan.workspace ?? { mode: "fixed", path: plan.workdir }
    },
    {
      namespace: "octo.execution",
      name: "model",
      payload: {
        selection: plan.model === undefined ? { use_provider_default: true } : { id: plan.model },
        reasoning:
          plan.effort === undefined ? { use_provider_default: true } : { effort: plan.effort }
      }
    },
    { namespace: "octo.security", name: "approval_policy", payload: { mode: plan.approval_mode } },
    ...(plan.runtime_limits === undefined
      ? []
      : [{ namespace: "octo.execution", name: "limits", payload: plan.runtime_limits }]),
    ...items
  ]);
}

export function withExecutionPlan(envelope, plan) {
  const items = envelope.effective_context.items.filter(
    (item) =>
      item.namespace !== "octo.execution" &&
      !(item.namespace === "octo.security" && item.name === "approval_policy")
  );
  return {
    ...envelope,
    resolved_execution_plan: structuredClone(plan),
    effective_context: executionContext(plan, items)
  };
}

export function continuityItem({
  sessionGeneration = 7,
  triggerMessageId = "message-current",
  triggerSeq = 2
} = {}) {
  return {
    namespace: "octo.content",
    name: "continuity",
    payload: {
      scope: {
        tenant_id: "tenant-1",
        endpoint_id: "endpoint-1",
        channel: "discord",
        account_id: null,
        bot_id: "bot-1",
        conversation_id: "conversation-1"
      },
      consumer_key: "consumer-1",
      session_generation: sessionGeneration,
      trigger_message_id: triggerMessageId,
      trigger_seq: triggerSeq,
      trigger_fact: {
        message_id: triggerMessageId,
        message_seq: triggerSeq,
        sender: { id: "member-1", kind: "member" },
        occurred_at_ms: 2,
        parts: [{ type: "text", text: "Fix the test" }]
      }
    }
  };
}

export function invokeRequest(overrides = {}) {
  return {
    protocolVersion: 2,
    invocationId: "invoke-test",
    agentSessionId: "session-test",
    runId: "run-test",
    prompt: "Display-safe input",
    modelInput: "Provider model input",
    controlInstructions: "Keep changes scoped.",
    context: contextEnvelope(),
    runMetadata: { namespace: "test", triggerOccurrenceId: "test/invoke" },
    approvalMode: "ask",
    workdir: process.cwd(),
    agentSource: "provisioned",
    agentConfig: {},
    ...overrides
  };
}

export function approvalPayload(invocationId, interactionId = "approval-1") {
  return {
    interactionId,
    kind: "approval",
    executionInstanceId: invocationId,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    request: {
      schema: "octo.approval-request/v1",
      policy: { mode: "ask", hash: `sha256:${"a".repeat(64)}` },
      operation: {
        kind: "command_execution",
        summary: "Run tests",
        details: { command: "pnpm test" }
      },
      requestedPermissions: [],
      allowedOutcomes: ["accepted", "declined", "cancelled"],
      grantScope: "request"
    }
  };
}

export function wire(type, payload) {
  return JSON.stringify({
    version: 2,
    id: `wire-${Math.random()}`,
    type,
    sent_at: new Date().toISOString(),
    payload
  });
}

export function terminalGrant(event) {
  return {
    context_commit_granted: true,
    authoritative_terminal_status: "completed",
    authoritative_terminal_event_id: event.event_id
  };
}

export function deferred() {
  let resolve;
  return {
    promise: new Promise((done) => {
      resolve = done;
    }),
    resolve
  };
}

export async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

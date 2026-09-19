import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import {
  DEFAULT_OBSERVABILITY_CONFIGURATION,
  LocalObservability
} from "@mininglamp-oss/octo-harness-observability";
import {
  AgentWorkRuntime,
  accumulateFinalText,
  clockChanged,
  connectionFailureReason,
  mapExecutionEnvelope,
  mapRuntimeEvent,
  reconnectDelayMs,
  reconnectDelayWithServerHintMs,
  renderDisplayExecutionInputPrompt,
  renderAgentRunInputPrompt
} from "../apps/daemon/dist/agent-work-runtime.js";
import { AgentWorkStore } from "../apps/daemon/dist/agent-work-store.js";
import { collectRuntimeDeviceInfo } from "../apps/daemon/dist/server.js";
import { deferred, waitFor, wire } from "./agent-work-runtime-fixture.js";

const envelope = {
  schema_version: 1,
  run_id: "run-1",
  agent_session_id: "chat-1",
  session_generation: 7,
  provider_epoch: 3,
  continuity_mode: "continue",
  provider_session: { sessionId: "thread-previous", resumable: true },
  agent_run_request: {
    namespace: "im",
    agent_id: "agent-1",
    agent_revision_id: "revision-1",
    session_key: "v1/octo/ep-1/group/group-1",
    trigger: { kind: "im.message", occurrence_id: "message/event-1" },
    input: {
      parts: [{ type: "text", text: "Fix the test" }],
      reply_to: { author_name: "Ada", text: "The failing case is reset." },
      context_refs: [{
        kind: "recent_group",
        messages: [{ author_name: "Lin", text: "Use the existing adapter." }]
      }]
    }
  },
  agent_revision: {
    definition: { instructions: "Keep changes scoped." },
    execution_profile: {
      default_adapter: "codex",
      workdir: "/workspace/project",
      agent_config: { sandbox: "workspace-write", model: "gpt-5" }
    }
  }
};

test("reconnect delay keeps one fast attempt before capped full-jitter backoff", () => {
  assert.equal(reconnectDelayMs(1, 20_000, 60_000, () => 0.5), 1_000);
  assert.equal(reconnectDelayMs(1, 20_000, 60_000, () => 0.5, 750), 750);
  assert.equal(reconnectDelayMs(2, 20_000, 60_000, () => 0), 20_000);
  assert.equal(reconnectDelayMs(2, 20_000, 60_000, () => 0.5), 30_000);
  assert.equal(reconnectDelayMs(2, 20_000, 60_000, () => 1), 39_999);
  assert.equal(reconnectDelayMs(3, 20_000, 60_000, () => 0.5), 40_000);
  assert.equal(reconnectDelayMs(20, 20_000, 60_000, () => 1), 59_999);
});

test("server reconnect hint is a jittered floor", () => {
  assert.equal(reconnectDelayWithServerHintMs(1_000, undefined, () => 0.5), 1_000);
  assert.equal(reconnectDelayWithServerHintMs(1_000, 5_000, () => 0), 5_000);
  assert.equal(reconnectDelayWithServerHintMs(1_000, 5_000, () => 0.5), 7_500);
  assert.equal(reconnectDelayWithServerHintMs(30_000, 5_000, () => 1), 34_999);
  assert.equal(reconnectDelayWithServerHintMs(1_000, 60_000, () => 1), 79_999);
});

test("connection failures retain stable bounded reasons", () => {
  assert.equal(connectionFailureReason(Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" })), "dns");
  assert.equal(connectionFailureReason(Object.assign(new Error("certificate rejected"), { code: "CERT_HAS_EXPIRED" })), "tls");
  assert.equal(connectionFailureReason(new Error("Agent Work WebSocket server receive timed out")), "receive_timeout");
  assert.equal(connectionFailureReason(new Error("socket closed")), "transport");
});

test("clock change detection compares wall and monotonic elapsed time", () => {
  assert.equal(clockChanged(5_000, 5_010, 1_000), false);
  assert.equal(clockChanged(65_000, 5_000, 10_000), true);
  assert.equal(clockChanged(Number.NaN, 5_000, 10_000), false);
});

test("process restart hello excludes stale non-terminal runs but retains pending terminal delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-runtime-restart-ownership-"));
  const storePath = join(directory, "agent-work.db");
  const persisted = AgentWorkStore.open(storePath);
  persisted.upsertRun({ runId: "run-stale", commandId: "command-stale", leaseId: "lease-stale", fencingToken: 1 });
  persisted.allocateAndAppend("run-stale", "run.started", {});
  persisted.upsertRun({ runId: "run-terminal", commandId: "command-terminal", leaseId: "lease-terminal", fencingToken: 2 });
  persisted.allocateAndAppend("run-terminal", "run.completed", { text: "done" });
  persisted.close();

  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const helloReceived = deferred();
  let runtime;
  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* Consume registration. */ }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { profile: "default", id: "runtime-restart-ownership", protocol_version: 1 } }));
  });
  httpServer.on("upgrade", (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", websocket => {
    websocket.on("message", data => {
      const frame = JSON.parse(data.toString("utf8"));
      if (frame.type !== "runtime.hello") return;
      helloReceived.resolve(frame.payload);
      websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 }));
    });
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    runtime = new AgentWorkRuntime({
      profile: "default",
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      runtimeName: "runtime-restart-ownership",
      storePath
    }, {
      list: async () => [],
      cancel: async () => ({ cancelled: true }),
      async *invoke() { yield { type: "run.finished", payload: {} }; }
    });
    await runtime.start();
    assert.deepEqual((await helloReceived.promise).active_run_ids, ["run-terminal"]);
  } finally {
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("Agent Work envelope maps to a local adapter invocation with fixed cwd and resume", () => {
  const mapped = mapExecutionEnvelope({
    ...envelope,
    agent_revision: {
      ...envelope.agent_revision,
      execution_profile: {
        ...envelope.agent_revision.execution_profile,
        runtime_limits: {
          first_frame_timeout_ms: 60_000,
          model_idle_timeout_ms: 120_000,
          tool_timeout_ms: 600_000,
          run_timeout_ms: 1_800_000,
          cancel_grace_ms: 1_000,
          enforcement: "enforce"
        }
      }
    }
  });
  assert.equal(mapped.adapterType, "codex");
  assert.equal(mapped.request.agentSessionId, "chat-1");
  assert.equal(mapped.request.sessionGeneration, 7);
  assert.equal(mapped.request.providerEpoch, 3);
  assert.equal(mapped.request.continuityMode, "continue");
  assert.equal(mapped.request.workdir, "/workspace/project");
  assert.equal(mapped.request.providerSession.sessionId, "thread-previous");
  assert.equal(mapped.request.agentConfig.sandbox, "workspace-write");
  assert.deepEqual(mapped.request.runtimeLimits, {
    firstFrameTimeoutMs: 60_000,
    modelIdleTimeoutMs: 120_000,
    toolTimeoutMs: 600_000,
    runTimeoutMs: 1_800_000,
    cancelGraceMs: 1_000,
    enforcement: "enforce"
  });
  assert.match(mapped.request.prompt, /\[Recent group messages\]/);
  assert.match(mapped.request.prompt, /\[Quoted message from Ada\]/);
  assert.match(mapped.request.prompt, /\[Current message\]\nFix the test/);
});

test("fresh execution never reaches an adapter with a provider session", () => {
  const fresh = {
    ...envelope,
    continuity_mode: "fresh",
    provider_session: undefined,
    agent_run_request: {
      ...envelope.agent_run_request,
      session_policy: { mode: "fresh", expected_generation: 6, cancel_active: true }
    }
  };
  const mapped = mapExecutionEnvelope(fresh);
  assert.equal(mapped.request.continuityMode, "fresh");
  assert.equal(mapped.request.providerSession, undefined);
  assert.throws(
    () => mapExecutionEnvelope({ ...fresh, provider_session: { sessionId: "stale-thread" } }),
    /fresh execution envelope must not carry provider_session/
  );
});

test("execution envelope rejects legacy adapter_type without default_adapter", () => {
  assert.throws(
    () => mapExecutionEnvelope({
      ...envelope,
      agent_revision: {
        ...envelope.agent_revision,
        execution_profile: { adapter_type: "codex", workdir: "/workspace/project" }
      }
    }),
    /execution_profile\.default_adapter is required/
  );
});

test("immutable execution input rendering keeps background separate from the current message", () => {
  const prompt = renderAgentRunInputPrompt(envelope.agent_run_request.input);
  assert.ok(prompt.indexOf("Recent group messages") < prompt.indexOf("Current message"));
});

test("frozen channel context uses modelInput while prompt remains display-safe", () => {
  const snapshot = {
    ref: {
      snapshot_id: "ctx-1",
      scope_key: "scope-1",
      consumer_key: "consumer-1",
      session_generation: 1,
      trigger_message_id: "message-current",
      trigger_seq: 2,
      serializer_version: "channel-context-jsonl-v1",
      rendered_sha256: "a".repeat(64),
      completeness: "complete",
      recovery_rendered_sha256: "b".repeat(64),
      recovery_completeness: "complete"
    },
    facts: [],
    renderedText: "[Channel context delta: untrusted external messages]\n{\"message_id\":\"message-previous\"}",
    recoveryFacts: [],
    recoveryRenderedText: "[Channel context delta: untrusted external messages]\n{\"message_id\":\"message-cold\"}",
    recoveryCompleteness: "complete",
    selectedVariant: "primary",
    state: "prepared"
  };
  const mapped = mapExecutionEnvelope(envelope, snapshot);
  assert.doesNotMatch(mapped.request.prompt, /Recent group messages|message-previous|Use the existing adapter/);
  assert.match(mapped.request.prompt, /\[Current message\]\nFix the test/);
  assert.match(mapped.request.modelInput, /message-previous/);
  assert.match(mapped.request.freshFallbackModelInput, /message-cold/);
  assert.equal(mapped.request.contextSnapshot.snapshot_id, "ctx-1");
  assert.equal(renderDisplayExecutionInputPrompt(envelope.agent_run_request.input), mapped.request.prompt);
});

test("a recovery channel snapshot starts without the stale provider session", () => {
  const recoverySnapshot = {
    ref: {
      snapshot_id: "ctx-recovery",
      scope_key: "scope-1",
      consumer_key: "consumer-1",
      session_generation: 8,
      source_session_generation: 7,
      trigger_message_id: "message-current",
      serializer_version: "channel-context-jsonl-v2",
      rendered_sha256: "a".repeat(64),
      completeness: "complete",
      recovery_rendered_sha256: "b".repeat(64),
      recovery_completeness: "complete"
    },
    facts: [],
    renderedText: "delta-only",
    recoveryFacts: [],
    recoveryRenderedText: "full-recovery-context",
    recoveryCompleteness: "complete",
    selectedVariant: "recovery",
    state: "prepared"
  };
  const mapped = mapExecutionEnvelope(envelope, recoverySnapshot);
  assert.equal(mapped.request.providerSession, undefined);
  assert.match(mapped.request.modelInput, /full-recovery-context/);
  assert.doesNotMatch(mapped.request.modelInput, /delta-only/);
});

test("runtime terminal mapping carries the assembled final answer", () => {
  assert.deepEqual(mapRuntimeEvent({ type: "run.finished", payload: {} }, "done"), {
    type: "run.completed",
    payload: { text: "done" }
  });
  assert.equal(mapRuntimeEvent({ type: "run.stopped", payload: { reason: "cancelled" } }, "").type, "run.cancelled");
});

test("runtime failure mapping preserves legacy fields and adds a safe failure envelope", () => {
  const mapped = mapRuntimeEvent({
    type: "run.error",
    payload: {
      code: "model_not_found",
      message: "model missing; Authorization: Bearer secret-canary",
      providerError: { status: 404, token: "secret-canary" },
      adapterType: "codex"
    }
  }, "partial answer");

  assert.equal(mapped.type, "run.failed");
  assert.equal(mapped.payload.code, "model_not_found");
  assert.equal(mapped.payload.text, "partial answer");
  assert.equal(mapped.payload.failure.code, "OH-PRV-4003");
  assert.equal(mapped.payload.failure.reasonCode, "PROVIDER_MODEL_NOT_FOUND");
  assert.equal(mapped.payload.failure.source.adapter, "codex");
  assert.doesNotMatch(JSON.stringify(mapped), /secret-canary|Authorization|providerError/);
});

test("final answer accumulator replaces snapshots and appends deltas", () => {
  let text = accumulateFinalText("", {
    type: "message.delta",
    payload: { channel: "final", text: "part" }
  });
  text = accumulateFinalText(text, {
    type: "message.update",
    payload: { channel: "final", text: "complete answer", replace: true }
  });
  text = accumulateFinalText(text, {
    type: "message.delta",
    payload: { channel: "analysis", text: "private reasoning" }
  });
  text = accumulateFinalText(text, {
    type: "message.update",
    payload: { channel: "commentary", text: "public progress update" }
  });
  assert.equal(text, "complete answer");
});

test("terminal mapping uses provider terminal text when no message frame carried final text", () => {
  assert.deepEqual(mapRuntimeEvent({ type: "run.finished", payload: { text: "provider answer" } }, ""), {
    type: "run.completed",
    payload: { text: "provider answer" }
  });
});

test("Agent Work observability correlates WSS, AgentRun, occurrence, invocation and adapter without logging credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-agent-work-logs-"));
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const terminal = deferred();
  const logger = new LocalObservability({
    directory: join(directory, "logs"),
    ...DEFAULT_OBSERVABILITY_CONFIGURATION,
    logLevel: "debug",
    component: "daemon"
  });
  let registrationBody;
  let registrationRequestId;
  let connectionRequestId;
  let runtime;
  let invokedRequest;

  httpServer.on("request", async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    registrationBody = JSON.parse(body);
    registrationRequestId = request.headers["x-request-id"];
    response.writeHead(200, { "Content-Type": "application/json", "X-Request-Id": registrationRequestId });
    response.end(JSON.stringify({ runtime: { profile: "work", id: "runtime-observed" } }));
  });
  httpServer.on("upgrade", (request, socket, head) => {
    connectionRequestId = request.headers["x-request-id"];
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", websocket => {
    websocket.on("message", data => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.type === "runtime.hello") {
        websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 }));
        websocket.send(wire("runtime.command", {
          server_seq: 1,
          command_id: "command-observed",
          run_id: "run-observed",
          type: "run.start",
          payload: {
            ...envelope,
            run_id: "run-observed",
            agent_session_id: "session-observed",
            agent_run_request: {
              ...envelope.agent_run_request,
              trigger: { kind: "im.message", occurrence_id: "message/observed" }
            },
            agent_revision: {
              ...envelope.agent_revision,
              execution_profile: {
                default_adapter: "codex",
                workdir: process.cwd(),
                agent_config: {}
              }
            }
          },
          lease_id: "lease-observed",
          fencing_token: 1
        }));
      }
      if (message.type === "run.event_batch" && message.payload.events.some(event => event.type === "run.completed")) {
        terminal.resolve();
      }
    });
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    const host = {
      list: async () => [{ type: "codex", capabilities: [], providerVersion: "1.2.3", providerPath: "/test/codex", available: true }],
      cancel: async () => ({ cancelled: true }),
      async *invoke(_adapterType, request) {
        invokedRequest = request;
        yield { type: "run.finished", payload: {} };
      }
    };
    runtime = new AgentWorkRuntime({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token-must-not-leak",
      tenantId: "tenant-observed",
      subjectId: "device-observed",
      runtimeName: "runtime-observed",
      profile: "work",
      storePath: join(directory, "agent-work.db")
    }, host, logger);
    await runtime.start();
    await Promise.race([
      terminal.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("terminal timeout")), 3_000))
    ]);
    assert.equal(registrationBody.runtime_version, "0.1.0");
    assert.deepEqual(registrationBody.device, collectRuntimeDeviceInfo());
    assert.equal(registrationBody.protocol_version_min, 1);
    assert.equal(registrationBody.protocol_version_max, 1);
    assert.match(registrationRequestId, /^req_[0-9a-f]{32}$/);
    assert.match(connectionRequestId, /^req_[0-9a-f]{32}$/);
    assert.notEqual(registrationRequestId, connectionRequestId);
    assert.deepEqual(registrationBody.capabilities.adapters, [{
      provider_type: "codex", provider_version: "1.2.3", provider_path: "/test/codex",
      available: true, unavailable_reason: null, capabilities: []
    }]);
    assert.equal(invokedRequest.context.profile, "work");
    assert.equal(invokedRequest.context.runtimeId, "runtime-observed");
    await runtime.close();
    runtime = undefined;
    const trace = await logger.query({ runId: "run-observed" });
    assert.ok(trace.some(record => record.event === "agent_run.received" && record.data.trigger_occurrence_id === "message/observed"));
    assert.ok(trace.some(record => record.event === "adapter.selected" && record.adapter_type === "codex"));
    assert.ok(trace.some(record => record.event === "adapter.invoke.started" && record.invocation_id));
    assert.ok(trace.some(record => record.event === "adapter.invoke.completed"
      && Number.isInteger(record.duration_ms)
      && record.duration_ms >= 0));
    assert.ok(trace.every(record => record.profile === "work"));
    assert.ok(trace.every(record => record.runtime_id === "runtime-observed"));
    assert.ok(trace.some(record => record.event === "transport.message.received" && record.data.frame_type === "runtime.command"));
    const all = await logger.query({ limit: 500 });
    const opened = all.find(record => record.event === "transport.connection.opened" && record.scope === "transport.wss");
    assert.equal(opened.request_id, connectionRequestId);
    assert.ok(all.some(record => record.event === "agent_work.registration.completed"
      && record.request_id === registrationRequestId));
    const registrationTrace = await logger.query({ requestId: registrationRequestId });
    assert.ok(registrationTrace.length >= 2);
    assert.ok(registrationTrace.every(record => record.request_id === registrationRequestId));
    assert.deepEqual(opened.data.endpoint, {
      scheme: "ws",
      host: "127.0.0.1",
      port: String(address.port),
      path: "/v1/runtime/connect"
    });
    const serialized = JSON.stringify(all);
    assert.doesNotMatch(serialized, /runtime-token-must-not-leak|Fix the test/);
  } finally {
    await runtime?.close();
    await logger.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a configured runtime ID still refreshes registration and rejects identity drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-runtime-identity-"));
  const httpServer = createServer();
  let registrationCount = 0;
  let runtime;
  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* Consume the registration body. */ }
    registrationCount += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { profile: "default", id: "runtime-actual" } }));
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    const host = {
      list: async () => [],
      cancel: async () => ({ cancelled: true }),
      async *invoke() { yield { type: "run.finished", payload: {} }; }
    };
    runtime = new AgentWorkRuntime({
      profile: "default",
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      tenantId: "tenant-identity",
      subjectId: "device-identity",
      runtimeId: "runtime-expected",
      runtimeName: "runtime-identity",
      storePath: join(directory, "agent-work.db")
    }, host);
    await assert.rejects(
      runtime.start(),
      /registration returned runtime-actual, expected configured runtime runtime-expected/
    );
    assert.equal(registrationCount, 1);
  } finally {
    await runtime?.close();
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup registration failure stays alive and every reconnect re-registers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-runtime-reconnect-"));
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  let registrations = 0;
  let connections = 0;
  let runtime;
  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* Consume registration. */ }
    registrations += 1;
    response.writeHead(registrations === 1 ? 503 : 200, { "Content-Type": "application/json" });
    response.end(registrations === 1
      ? JSON.stringify({ error: { message: "worker restarting" } })
      : JSON.stringify({ runtime: { profile: "default", id: "runtime-reconnect", protocol_version: 1 } }));
  });
  httpServer.on("upgrade", (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", websocket => {
    connections += 1;
    websocket.once("message", () => {
      websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 }));
      if (connections === 1) setTimeout(() => websocket.close(1012, "worker restart"), 10);
    });
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    runtime = new AgentWorkRuntime({
      profile: "default",
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      runtimeName: "runtime-reconnect",
      storePath: join(directory, "agent-work.db"),
      reconnectFirstMs: 5,
      reconnectMs: 5,
      reconnectMaxMs: 5
    }, {
      list: async () => [],
      cancel: async () => ({ cancelled: true }),
      async *invoke() { yield { type: "run.finished", payload: {} }; }
    });
    await runtime.start();
    await waitFor(() => registrations >= 3 && connections >= 2 && runtime.status.connected === true, 2_000);
  } finally {
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejected runtime credentials stop after the configured failure budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-runtime-auth-rejected-"));
  const httpServer = createServer();
  let registrations = 0;
  let runtime;
  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* Consume registration. */ }
    registrations += 1;
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "invalid runtime credential" } }));
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    runtime = new AgentWorkRuntime({
      profile: "default",
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "rejected-runtime-token",
      runtimeName: "runtime-auth-rejected",
      storePath: join(directory, "agent-work.db"),
      reconnectFirstMs: 5,
      reconnectMs: 5,
      reconnectMaxMs: 5,
      credentialFailureLimit: 3
    }, {
      list: async () => [],
      cancel: async () => ({ cancelled: true }),
      async *invoke() { yield { type: "run.finished", payload: {} }; }
    });
    await runtime.start();
    await waitFor(() => runtime.status.connectionState === "action_required", 2_000);
    assert.equal(registrations, 3);
    assert.equal(runtime.status.connectionReason, "auth");
    assert.equal(runtime.status.connected, false);
    assert.equal(runtime.status.actionRequired, true);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(registrations, 3);
  } finally {
    await runtime?.close();
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("connectivity notification interrupts a long reconnect backoff with bounded jitter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-runtime-fast-recovery-"));
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  let connections = 0;
  let runtime;
  let firstSocket;
  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* Consume registration. */ }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { profile: "default", id: "runtime-fast-recovery", protocol_version: 1 } }));
  });
  httpServer.on("upgrade", (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", websocket => {
    connections += 1;
    if (connections === 1) firstSocket = websocket;
    websocket.once("message", () => websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 })));
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    runtime = new AgentWorkRuntime({
      profile: "default",
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      runtimeName: "runtime-fast-recovery",
      storePath: join(directory, "agent-work.db"),
      reconnectFirstMs: 60_000,
      reconnectMs: 60_000,
      reconnectMaxMs: 60_000,
      recoveryJitterMaxMs: 5
    }, {
      list: async () => [],
      cancel: async () => ({ cancelled: true }),
      async *invoke() { yield { type: "run.finished", payload: {} }; }
    });
    await runtime.start();
    await waitFor(() => runtime.status.connectionState === "online", 2_000);
    firstSocket.close(1012, "network changed");
    await waitFor(() => runtime.status.connectionState === "backing_off", 2_000);
    runtime.notifyConnectivityChanged("network_change");
    await waitFor(() => connections === 2 && runtime.status.connectionState === "online", 2_000);
    assert.equal(runtime.status.lastRecoveryTrigger, "network_change");
    assert.equal(typeof runtime.status.lastRecoveryDurationMs, "number");
    assert.ok(runtime.status.lastRecoveryDurationMs >= 0);
  } finally {
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconnect terminal authority cancels local execution and discards its outbox", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-runtime-terminal-authority-"));
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const providerRelease = deferred();
  const cancelled = deferred();
  let connections = 0;
  let runtime;
  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* Consume registration. */ }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { profile: "default", id: "runtime-terminal-authority", protocol_version: 1 } }));
  });
  httpServer.on("upgrade", (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", websocket => {
    connections += 1;
    const connectionNumber = connections;
    websocket.on("message", data => {
      const frame = JSON.parse(data.toString("utf8"));
      if (frame.type === "runtime.hello" && connectionNumber === 1) {
        websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000, authoritative_terminal_runs: [] }));
        websocket.send(wire("runtime.command", runtimeCommand("authority", 1)));
      } else if (frame.type === "run.event_batch" && connectionNumber === 1) {
        websocket.close(1012, "worker restarted after committing terminal");
      } else if (frame.type === "runtime.hello" && connectionNumber === 2) {
        assert.ok(frame.payload.active_run_ids.includes("run-authority"));
        websocket.send(wire("runtime.welcome", {
          heartbeat_every_ms: 60_000,
          authoritative_terminal_runs: [{
            run_id: "run-authority",
            status: "failed",
            terminal_event_id: "event-server-terminal"
          }]
        }));
      }
    });
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    runtime = new AgentWorkRuntime({
      profile: "default",
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      runtimeName: "runtime-terminal-authority",
      storePath: join(directory, "agent-work.db"),
      reconnectFirstMs: 5,
      reconnectMs: 5,
      reconnectMaxMs: 5
    }, {
      list: async () => [],
      cancel: async (_invocationId, reason) => {
        assert.match(reason, /authoritative server terminal: failed/);
        providerRelease.resolve();
        cancelled.resolve();
        return { cancelled: true };
      },
      async *invoke() {
        yield { type: "message.delta", payload: { text: "partial local output" } };
        await providerRelease.promise;
      }
    });
    await runtime.start();
    await Promise.race([
      cancelled.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("authoritative cancellation timeout")), 2_000))
    ]);
    await waitFor(() => runtime.status.activeRuns === 0 && runtime.status.outboxPending === 0, 2_000);
    assert.equal(runtime.status.connectionState, "online");
  } finally {
    providerRelease.resolve();
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime goaway delays and spreads the next reconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-runtime-goaway-"));
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const reconnected = deferred();
  let connections = 0;
  let goawayAt = 0;
  let runtime;
  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* Consume registration. */ }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { profile: "default", id: "runtime-goaway", protocol_version: 1 } }));
  });
  httpServer.on("upgrade", (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", websocket => {
    connections += 1;
    websocket.once("message", () => {
      websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 }));
      if (connections === 1) {
        setTimeout(() => {
          goawayAt = Date.now();
          websocket.send(wire("runtime.goaway", { reason: "worker_draining", retry_after_ms: 80 }));
        }, 5);
      } else {
        reconnected.resolve(Date.now());
      }
    });
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    runtime = new AgentWorkRuntime({
      profile: "default",
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      runtimeName: "runtime-goaway",
      storePath: join(directory, "agent-work.db"),
      reconnectFirstMs: 1,
      reconnectMs: 1,
      reconnectMaxMs: 1
    }, {
      list: async () => [],
      cancel: async () => ({ cancelled: true }),
      async *invoke() { yield { type: "run.finished", payload: {} }; }
    });
    await runtime.start();
    const reconnectedAt = await Promise.race([
      reconnected.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("goaway reconnect timeout")), 2_000))
    ]);
    assert.ok(goawayAt > 0);
    assert.ok(reconnectedAt - goawayAt >= 80, `reconnected after ${reconnectedAt - goawayAt}ms`);
  } finally {
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("close cancels a pending reconnect backoff without late registration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-runtime-close-backoff-"));
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  let registrations = 0;
  let runtime;
  let socket;
  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* Consume registration. */ }
    registrations += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { profile: "default", id: "runtime-close-backoff", protocol_version: 1 } }));
  });
  httpServer.on("upgrade", (request, rawSocket, head) => {
    wsServer.handleUpgrade(request, rawSocket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", websocket => {
    socket = websocket;
    websocket.once("message", () => websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 })));
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    runtime = new AgentWorkRuntime({
      profile: "default",
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      runtimeName: "runtime-close-backoff",
      storePath: join(directory, "agent-work.db"),
      reconnectFirstMs: 60_000,
      reconnectMs: 60_000,
      reconnectMaxMs: 60_000
    }, {
      list: async () => [],
      cancel: async () => ({ cancelled: true }),
      async *invoke() { yield { type: "run.finished", payload: {} }; }
    });
    await runtime.start();
    await waitFor(() => runtime.status.connected === true, 2_000);
    socket.close(1012, "worker restart");
    await waitFor(() => runtime.status.connected === false, 2_000);
    const startedAt = Date.now();
    await runtime.close();
    assert.ok(Date.now() - startedAt < 500, "close waited for reconnect backoff");
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(registrations, 1);
  } finally {
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stalled WebSocket handshake times out and registration retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-runtime-handshake-timeout-"));
  const httpServer = createServer();
  const upgradedSockets = new Set();
  let registrations = 0;
  let runtime;
  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* Consume registration. */ }
    registrations += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { profile: "default", id: "runtime-handshake-timeout", protocol_version: 1 } }));
  });
  httpServer.on("upgrade", (_request, socket) => {
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
    // Deliberately leave the HTTP upgrade unanswered.
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    runtime = new AgentWorkRuntime({
      profile: "default",
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      runtimeName: "runtime-handshake-timeout",
      storePath: join(directory, "agent-work.db"),
      reconnectFirstMs: 5,
      reconnectMs: 5,
      reconnectMaxMs: 5,
      connectTimeoutMs: 10
    }, {
      list: async () => [],
      cancel: async () => ({ cancelled: true }),
      async *invoke() { yield { type: "run.finished", payload: {} }; }
    });
    await runtime.start();
    await waitFor(() => registrations >= 2, 2_000);
    assert.equal(runtime.status.connected, false);
  } finally {
    await runtime?.close();
    for (const socket of upgradedSockets) socket.destroy();
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("hard outbox watermark rejects new work with a durable command receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-runtime-hard-limit-"));
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const rejection = deferred();
  let runtime;
  let invocations = 0;
  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* Consume registration. */ }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { profile: "default", id: "runtime-hard-limit", protocol_version: 1 } }));
  });
  httpServer.on("upgrade", (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", websocket => {
    websocket.on("message", data => {
      const frame = JSON.parse(data.toString("utf8"));
      if (frame.type === "runtime.hello") {
        websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 }));
        websocket.send(wire("runtime.command", runtimeCommand("hard", 1)));
      } else if (frame.type === "command.ack" && frame.payload.command_id === "command-hard") {
        rejection.resolve(frame.payload);
      }
    });
  });
  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    runtime = new AgentWorkRuntime({
      profile: "default",
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      runtimeName: "runtime-hard-limit",
      storePath: join(directory, "agent-work.db"),
      hardWatermarkBytes: 0
    }, {
      list: async () => [],
      cancel: async () => ({ cancelled: true }),
      async *invoke() { invocations += 1; yield { type: "run.finished", payload: {} }; }
    });
    await runtime.start();
    const ack = await rejection.promise;
    assert.equal(ack.accepted, false);
    assert.equal(ack.error.code, "OUTBOX_HARD_LIMIT");
    assert.equal(ack.error.failure.code, "OH-RUN-2003");
    assert.equal(ack.error.failure.reasonCode, "OUTBOX_HARD_LIMIT");
    assert.equal(ack.error.failure.stage, "runtime.command.accept");
    assert.equal(invocations, 0);
  } finally {
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("low disk preflight stays connected, reports health and rejects new work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-runtime-low-disk-"));
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const helloReceived = deferred();
  const healthReceived = deferred();
  const rejection = deferred();
  let runtime;
  let commandSent = false;
  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* Consume registration. */ }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { profile: "default", id: "runtime-low-disk", protocol_version: 1 } }));
  });
  httpServer.on("upgrade", (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", websocket => {
    websocket.on("message", data => {
      const frame = JSON.parse(data.toString("utf8"));
      if (frame.type === "runtime.hello") {
        helloReceived.resolve(frame.payload);
        websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000, authoritative_terminal_runs: [] }));
      } else if (frame.type === "runtime.health") {
        healthReceived.resolve(frame.payload);
        if (!commandSent) {
          commandSent = true;
          websocket.send(wire("runtime.command", runtimeCommand("low-disk", 1)));
        }
      } else if (frame.type === "command.ack" && frame.payload.command_id === "command-low-disk") {
        rejection.resolve(frame.payload);
      }
    });
  });
  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    runtime = new AgentWorkRuntime({
      profile: "default",
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      runtimeName: "runtime-low-disk",
      storePath: join(directory, "agent-work.db"),
      minimumFreeBytes: Number.MAX_SAFE_INTEGER
    }, {
      list: async () => [],
      cancel: async () => ({ cancelled: true }),
      async *invoke() { throw new Error("low disk work must not start"); }
    });
    await runtime.start();
    const hello = await helloReceived.promise;
    const health = await healthReceived.promise;
    const ack = await rejection.promise;
    assert.equal(hello.store_health.state, "low_disk");
    assert.equal(hello.store_health.accepting_new_runs, false);
    assert.equal(health.state, "low_disk");
    assert.equal(health.accepting_new_runs, false);
    assert.equal(ack.accepted, false);
    assert.equal(ack.error.code, "LOCAL_STORE_FULL");
    assert.equal(ack.error.failure.code, "OH-RUN-2008");
    assert.equal(runtime.status.storeHealth.state, "low_disk");
    assert.equal(runtime.status.connected, true);
  } finally {
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("store open failure keeps the control plane online with migration_failed health", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-runtime-store-failed-"));
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const helloReceived = deferred();
  const healthReceived = deferred();
  let runtime;
  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* Consume registration. */ }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { profile: "default", id: "runtime-store-failed", protocol_version: 1 } }));
  });
  httpServer.on("upgrade", (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", websocket => {
    websocket.on("message", data => {
      const frame = JSON.parse(data.toString("utf8"));
      if (frame.type === "runtime.hello") {
        helloReceived.resolve(frame.payload);
        websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000, authoritative_terminal_runs: [] }));
      } else if (frame.type === "runtime.health") {
        healthReceived.resolve(frame.payload);
      }
    });
  });
  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    runtime = new AgentWorkRuntime({
      profile: "default",
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      runtimeName: "runtime-store-failed",
      storePath: directory
    }, {
      list: async () => [],
      cancel: async () => ({ cancelled: true }),
      async *invoke() { throw new Error("store unavailable work must not start"); }
    });
    await runtime.start();
    const hello = await helloReceived.promise;
    const health = await healthReceived.promise;
    assert.equal(hello.store_health.state, "migration_failed");
    assert.equal(hello.store_health.accepting_new_runs, false);
    assert.equal(health.state, "migration_failed");
    assert.equal(runtime.status.connected, true);
    assert.equal(runtime.status.storeHealth.state, "migration_failed");
  } finally {
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing provider configuration rejects work with a durable catalog failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-runtime-provider-missing-"));
  const storePath = join(directory, "agent-work.db");
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const rejection = deferred();
  let runtime;
  let invocations = 0;
  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* Consume registration. */ }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { profile: "default", id: "runtime-provider-missing", protocol_version: 1 } }));
  });
  httpServer.on("upgrade", (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", websocket => {
    websocket.on("message", data => {
      const frame = JSON.parse(data.toString("utf8"));
      if (frame.type === "runtime.hello") {
        websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 }));
        websocket.send(wire("runtime.command", runtimeCommand("provider-missing", 1)));
      } else if (frame.type === "command.ack" && frame.payload.command_id === "command-provider-missing") {
        rejection.resolve(frame.payload);
      }
    });
  });
  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    runtime = new AgentWorkRuntime({
      profile: "default",
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      runtimeName: "runtime-provider-missing",
      storePath
    }, {
      list: async () => [{ type: "other", capabilities: [], available: true }],
      cancel: async () => ({ cancelled: true }),
      async *invoke() { invocations += 1; yield { type: "run.finished", payload: {} }; }
    });
    await runtime.start();
    const ack = await rejection.promise;
    assert.equal(ack.accepted, false);
    assert.equal(ack.error.code, "PROVIDER_CONFIG_MISSING");
    assert.equal(ack.error.failure.code, "OH-PRV-4008");
    assert.equal(ack.error.failure.retryable, false);
    assert.equal(ack.error.failure.action.type, "change_model");
    assert.equal(invocations, 0);
    await runtime.close();
    runtime = undefined;
    const store = AgentWorkStore.open(storePath);
    assert.equal(store.getCommandReceipt("command-provider-missing")?.error?.failure?.code, "OH-PRV-4008");
    store.close();
  } finally {
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("event nack releases the send window and retries from the requested sequence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-runtime-event-nack-"));
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const retried = deferred();
  let runtime;
  let firstBatch;
  let connectionCount = 0;
  let batchCount = 0;
  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* Consume registration. */ }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { profile: "default", id: "runtime-event-nack", protocol_version: 1 } }));
  });
  httpServer.on("upgrade", (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", websocket => {
    connectionCount += 1;
    websocket.on("message", data => {
      const frame = JSON.parse(data.toString("utf8"));
      if (frame.type === "runtime.hello") {
        websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 }));
        websocket.send(wire("runtime.command", runtimeCommand("event-nack", 1)));
        return;
      }
      if (frame.type !== "run.event_batch") return;
      batchCount += 1;
      if (!firstBatch) {
        firstBatch = frame.payload;
        websocket.send(wire("event.nack", {
          run_id: frame.payload.run_id,
          code: "WORKER_BUFFER_SATURATED",
          resume_from_seq: frame.payload.first_seq,
          retry_after_ms: 25
        }));
        return;
      }
      websocket.send(wire("event.ack", {
        run_id: frame.payload.run_id,
        received_through_seq: frame.payload.last_seq,
        durable_through_seq: 0
      }));
      retried.resolve(frame.payload);
    });
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    runtime = new AgentWorkRuntime({
      profile: "default",
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      runtimeName: "runtime-event-nack",
      storePath: join(directory, "agent-work.db")
    }, {
      list: async () => [{ type: "codex", capabilities: [] }],
      cancel: async () => ({ cancelled: true }),
      async *invoke() { yield { type: "run.finished", payload: {} }; }
    });
    await runtime.start();
    const secondBatch = await Promise.race([
      retried.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("event batch retry timeout")), 2_000))
    ]);
    assert.equal(connectionCount, 1);
    assert.equal(batchCount, 2);
    assert.equal(secondBatch.first_seq, firstBatch.first_seq);
    assert.deepEqual(
      secondBatch.events.map(event => event.event_id),
      firstBatch.events.map(event => event.event_id)
    );
  } finally {
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("local runtime concurrency limit queues a second provider invocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-runtime-capacity-"));
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const firstAccepted = deferred();
  const secondAccepted = deferred();
  const secondStarted = deferred();
  let runtime;
  let socket;
  let invocations = 0;
  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* Consume registration. */ }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { profile: "default", id: "runtime-capacity", protocol_version: 1 } }));
  });
  httpServer.on("upgrade", (request, rawSocket, head) => {
    wsServer.handleUpgrade(request, rawSocket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", websocket => {
    socket = websocket;
    websocket.on("message", data => {
      const frame = JSON.parse(data.toString("utf8"));
      if (frame.type === "runtime.hello") {
        websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 }));
        websocket.send(wire("runtime.command", runtimeCommand("first", 1)));
      } else if (frame.type === "command.ack" && frame.payload.command_id === "command-first") {
        firstAccepted.resolve(frame.payload);
      } else if (frame.type === "command.ack" && frame.payload.command_id === "command-second") {
        secondAccepted.resolve(frame.payload);
      }
    });
  });
  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    runtime = new AgentWorkRuntime({
      profile: "default",
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      runtimeName: "runtime-capacity",
      storePath: join(directory, "agent-work.db"),
      maxConcurrentRuns: 1
    }, {
      list: async () => [{ type: "codex", capabilities: [] }],
      cancel: async () => ({ cancelled: true }),
      async *invoke() {
        invocations += 1;
        if (invocations === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        } else {
          secondStarted.resolve();
        }
        yield { type: "run.finished", payload: {} };
      }
    });
    await runtime.start();
    await firstStarted.promise;
    assert.equal((await firstAccepted.promise).accepted, true);
    socket.send(wire("runtime.command", runtimeCommand("second", 2)));
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(invocations, 1);
    // A control-plane retry must be acknowledged while the original handler
    // remains queued; otherwise long first Runs can make the server reject it.
    socket.send(wire("runtime.command", runtimeCommand("second", 2)));
    assert.equal((await secondAccepted.promise).accepted, true);
    assert.equal(invocations, 1);
    releaseFirst.resolve();
    await secondStarted.promise;
    assert.equal(invocations, 2);
  } finally {
    releaseFirst.resolve();
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

function runtimeCommand(suffix, serverSeq) {
  return {
    server_seq: serverSeq,
    command_id: `command-${suffix}`,
    run_id: `run-${suffix}`,
    type: "run.start",
    payload: { ...envelope, run_id: `run-${suffix}` },
    lease_id: `lease-${suffix}`,
    fencing_token: serverSeq
  };
}

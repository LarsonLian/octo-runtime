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
  mapExecutionEnvelope,
  mapRuntimeEvent,
  renderDisplayExecutionInputPrompt,
  renderImmutableExecutionInputPrompt
} from "../apps/daemon/dist/agent-work-runtime.js";
import { deferred, wire } from "./agent-work-runtime-fixture.js";

const envelope = {
  schema_version: 1,
  run_id: "run-1",
  harness_session_id: "chat-1",
  provider_session: { sessionId: "thread-previous", resumable: true },
  execution_request: {
    id: "exec-1",
    agent_id: "agent-1",
    agent_revision_id: "revision-1",
    source_type: "chat_turn",
    source_id: "turn-1"
  },
  agent_revision: {
    definition: { instructions: "Keep changes scoped." },
    execution_profile: {
      default_adapter: "codex-local",
      workdir: "/workspace/project",
      agent_config: { sandbox: "workspace-write", model: "gpt-5" }
    }
  },
  immutable_execution_input: {
    content: {
      parts: [{ type: "text", text: "Fix the test" }],
      reply_to: { author_name: "Ada", text: "The failing case is reset." },
      context_refs: [{
        kind: "recent_group",
        messages: [{ author_name: "Lin", text: "Use the existing adapter." }]
      }]
    }
  }
};

test("Agent Work envelope maps to a local adapter invocation with fixed cwd and resume", () => {
  const mapped = mapExecutionEnvelope(envelope);
  assert.equal(mapped.adapterType, "codex");
  assert.equal(mapped.request.sessionId, "chat-1");
  assert.equal(mapped.request.workdir, "/workspace/project");
  assert.equal(mapped.request.providerSession.sessionId, "thread-previous");
  assert.equal(mapped.request.agentConfig.sandbox, "workspace-write");
  assert.match(mapped.request.prompt, /\[Recent group messages\]/);
  assert.match(mapped.request.prompt, /\[Quoted message from Ada\]/);
  assert.match(mapped.request.prompt, /\[Current message\]\nFix the test/);
});

test("immutable execution input rendering keeps background separate from the current message", () => {
  const prompt = renderImmutableExecutionInputPrompt(envelope.immutable_execution_input.content);
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
  assert.equal(renderDisplayExecutionInputPrompt(envelope.immutable_execution_input.content), mapped.request.prompt);
});

test("runtime terminal mapping carries the assembled final answer", () => {
  assert.deepEqual(mapRuntimeEvent({ type: "run.finished", payload: {} }, "done"), {
    type: "run.completed",
    payload: { text: "done" }
  });
  assert.equal(mapRuntimeEvent({ type: "run.stopped", payload: { reason: "cancelled" } }, "").type, "run.cancelled");
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
  assert.equal(text, "complete answer");
});

test("terminal mapping uses provider terminal text when no message frame carried final text", () => {
  assert.deepEqual(mapRuntimeEvent({ type: "run.finished", payload: { text: "provider answer" } }, ""), {
    type: "run.completed",
    payload: { text: "provider answer" }
  });
});

test("Agent Work observability correlates WSS, ChatTurn, Run, invocation and adapter without logging credentials", async () => {
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
  let runtime;

  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* consume registration */ }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { id: "runtime-observed" } }));
  });
  httpServer.on("upgrade", (request, socket, head) => {
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
            harness_session_id: "session-observed",
            execution_request: {
              ...envelope.execution_request,
              id: "execution-observed",
              source_type: "chat_turn",
              source_id: "turn-observed"
            },
            agent_revision: {
              ...envelope.agent_revision,
              execution_profile: {
                adapter_type: "codex",
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
      list: async () => [{ type: "codex", capabilities: [] }],
      cancel: async () => ({ cancelled: true }),
      async *invoke() { yield { type: "run.finished", payload: {} }; }
    };
    runtime = new AgentWorkRuntime({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token-must-not-leak",
      tenantId: "tenant-observed",
      subjectId: "device-observed",
      runtimeName: "runtime-observed",
      fingerprint: "runtime:observed",
      storePath: join(directory, "agent-work.db")
    }, host, logger);
    await runtime.start();
    await Promise.race([
      terminal.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("terminal timeout")), 3_000))
    ]);
    await runtime.close();
    runtime = undefined;
    const trace = await logger.query({ runId: "run-observed" });
    assert.ok(trace.some(record => record.event === "chat_turn.received" && record.data.chat_turn_id === "turn-observed"));
    assert.ok(trace.some(record => record.event === "adapter.selected" && record.adapter_type === "codex"));
    assert.ok(trace.some(record => record.event === "adapter.invoke.started" && record.invocation_id));
    assert.ok(trace.some(record => record.event === "transport.message.received" && record.data.frame_type === "runtime.command"));
    const all = await logger.query({ limit: 500 });
    const opened = all.find(record => record.event === "transport.connection.opened" && record.scope === "transport.wss");
    assert.deepEqual(opened.data.endpoint, {
      scheme: "ws",
      host: "127.0.0.1",
      port: String(address.port),
      path: "/api/v1/runtimes/connect"
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
    response.end(JSON.stringify({ runtime: { id: "runtime-actual" } }));
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
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      tenantId: "tenant-identity",
      subjectId: "device-identity",
      runtimeId: "runtime-expected",
      runtimeName: "runtime-identity",
      fingerprint: "runtime:identity",
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

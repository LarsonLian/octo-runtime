import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { AgentWorkRuntime } from "../apps/daemon/dist/agent-work-runtime.js";
import { AgentWorkStore } from "../apps/daemon/dist/agent-work-store.js";
import { ChannelContextStore } from "../apps/daemon/dist/channel-context-store.js";

const now = Date.now();
const scope = {
  tenant_id: "tenant-e2e",
  endpoint_id: "endpoint-e2e",
  channel: "fake-im",
  account_id: null,
  bot_id: "bot-e2e",
  conversation_id: "conversation-e2e"
};
const fact = (seq, text) => ({
  message_id: `message-${seq}`,
  message_seq: seq,
  sender: { id: `member-${seq}`, label: `Member ${seq}`, kind: "member" },
  occurred_at_ms: now + seq,
  parts: [{ type: "text", text }]
});

test("Agent Work channel context sync becomes one provider turn and commits only after durable terminal ACK", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-channel-runtime-"));
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  let registration;
  let providerRequest;
  let runtime;
  const terminalSent = deferred();

  httpServer.on("request", (request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      registration = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ runtime: { id: "runtime-e2e" } }));
    })();
  });
  httpServer.on("upgrade", (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", websocket => {
    websocket.on("message", data => {
      const envelope = JSON.parse(data.toString("utf8"));
      if (envelope.type === "runtime.hello") {
        websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 }));
        websocket.send(wire("context.append", { scope, facts: [fact(2, "second background")] }));
        websocket.send(wire("runtime.command", {
          server_seq: 1,
          command_id: "command-e2e",
          run_id: "run-e2e",
          type: "run.start",
          payload: executionEnvelope(),
          lease_id: "lease-e2e",
          fencing_token: 1
        }));
        return;
      }
      if (envelope.type === "context.sync_request") {
        assert.equal(envelope.payload.limit, 40);
        websocket.send(wire("context.sync_result", {
          request_id: envelope.payload.request_id,
          scope,
          facts: [fact(1, "first background"), fact(2, "second background")],
          completeness: "complete",
          through_seq: 2
        }));
        return;
      }
      if (envelope.type === "run.event_batch") {
        const terminal = envelope.payload.events.find(event => event.type === "run.completed");
        websocket.send(wire("event.ack", {
          run_id: envelope.payload.run_id,
          received_through_seq: envelope.payload.last_seq,
          durable_through_seq: envelope.payload.last_seq
        }));
        if (terminal) terminalSent.resolve();
      }
    });
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    const host = {
      list: async () => [{ type: "fake" }],
      cancel: async () => ({ cancelled: true }),
      async *invoke(_adapterType, request) {
        providerRequest = request;
        yield { type: "message.delta", payload: { channel: "final", text: "done" } };
        yield { type: "run.finished", payload: {} };
      }
    };
    runtime = new AgentWorkRuntime({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      tenantId: "tenant-e2e",
      subjectId: "device-e2e",
      runtimeName: "runtime-e2e",
      fingerprint: "runtime:e2e",
      storePath: join(directory, "agent-work.db"),
      channelContext: {
        store: "sqlite",
        projection: "delta",
        providerPersistence: "append_only",
        storePath: join(directory, "channel-context.db"),
        syncTimeoutMs: 1_000
      }
    }, host);
    await runtime.start();
    await withTimeout(terminalSent.promise, 3_000, "terminal event timeout");
    await waitFor(() => runtime.status.channelContext.activeSnapshots === 0);

    assert.equal(registration.capabilities.channel_context.store, "sqlite");
    assert.equal(providerRequest.prompt.includes("first background"), false);
    assert.match(providerRequest.modelInput, /first background/);
    assert.match(providerRequest.modelInput, /second background/);
    assert.doesNotMatch(providerRequest.modelInput, /trigger current.*trigger current/s);
    assert.equal(providerRequest.contextSnapshot.completeness, "complete");

    await runtime.close();
    runtime = undefined;
    const store = ChannelContextStore.open(join(directory, "channel-context.db"));
    assert.equal(store.getSnapshot("run-e2e").state, "committed");
    store.close();
  } finally {
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid or late sync results do not pollute context and a rejected cursor commit retains terminal outbox", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-channel-runtime-reject-"));
  const contextPath = join(directory, "channel-context.db");
  const outboxPath = join(directory, "agent-work.db");
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const terminalAckSent = deferred();
  const lateResultSent = deferred();
  const mismatchedScope = { ...scope, conversation_id: "wrong-conversation" };
  let runtime;
  let terminalHandled = false;

  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* consume registration body */ }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { id: "runtime-reject" } }));
  });
  httpServer.on("upgrade", (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", websocket => {
    websocket.on("message", data => {
      const envelope = JSON.parse(data.toString("utf8"));
      if (envelope.type === "runtime.hello") {
        websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 }));
        // No request with this ID exists: accepting it would make the scope look warm.
        websocket.send(wire("context.sync_result", {
          request_id: "unsolicited-sync",
          scope,
          facts: [fact(80, "unsolicited")],
          completeness: "complete",
          through_seq: 80
        }));
        websocket.send(wire("runtime.command", {
          server_seq: 1,
          command_id: "command-reject",
          run_id: "run-reject",
          type: "run.start",
          payload: executionEnvelope("run-reject"),
          lease_id: "lease-reject",
          fencing_token: 1
        }));
        return;
      }
      if (envelope.type === "context.sync_request") {
        // Same request ID but wrong scope must neither write nor resolve the pending request.
        websocket.send(wire("context.sync_result", {
          request_id: envelope.payload.request_id,
          scope: mismatchedScope,
          facts: [fact(1, "wrong scope")],
          completeness: "complete",
          through_seq: 1
        }));
        setTimeout(() => {
          // This matches, but arrives after the bounded request timed out.
          websocket.send(wire("context.sync_result", {
            request_id: envelope.payload.request_id,
            scope,
            facts: [fact(1, "late")],
            completeness: "complete",
            through_seq: 1
          }));
          lateResultSent.resolve();
        }, 60);
        return;
      }
      if (envelope.type === "run.event_batch") {
        const terminal = envelope.payload.events.find(event => event.type === "run.completed");
        if (terminal && !terminalHandled) {
          terminalHandled = true;
          const contextStore = ChannelContextStore.open(contextPath);
          contextStore.markFailed("run-reject");
          contextStore.close();
        }
        websocket.send(wire("event.ack", {
          run_id: envelope.payload.run_id,
          received_through_seq: envelope.payload.last_seq,
          durable_through_seq: envelope.payload.last_seq
        }));
        if (terminal) terminalAckSent.resolve();
      }
    });
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    const host = {
      list: async () => [{ type: "fake" }],
      cancel: async () => ({ cancelled: true }),
      async *invoke() {
        yield { type: "run.finished", payload: {} };
      }
    };
    runtime = new AgentWorkRuntime({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      tenantId: "tenant-e2e",
      subjectId: "device-e2e",
      runtimeName: "runtime-reject",
      fingerprint: "runtime:reject",
      storePath: outboxPath,
      channelContext: {
        store: "sqlite",
        projection: "delta",
        providerPersistence: "append_only",
        storePath: contextPath,
        syncTimeoutMs: 15
      }
    }, host);
    await runtime.start();
    await withTimeout(terminalAckSent.promise, 3_000, "rejected terminal ACK timeout");
    await withTimeout(lateResultSent.promise, 3_000, "late context result timeout");
    await new Promise(resolve => setTimeout(resolve, 50));
    await runtime.close();
    runtime = undefined;

    const contextStore = ChannelContextStore.open(contextPath);
    assert.equal(contextStore.messageCount(scope), 1, "only the reliable trigger is retained");
    assert.equal(contextStore.messageCount(mismatchedScope), 0);
    assert.equal(contextStore.getSnapshot("run-reject").state, "failed");
    contextStore.close();

    const outboxStore = AgentWorkStore.open(outboxPath);
    assert.ok(outboxStore.pendingCount() > 0, "terminal outbox must remain when cursor commit is rejected");
    const inspection = outboxStore.inspectDurableAck("run-reject", 2);
    assert.equal(inspection.advanced, true);
    assert.equal(inspection.terminal?.type, "run.completed");
    outboxStore.close();
  } finally {
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

function executionEnvelope(runId = "run-e2e") {
  const trigger = fact(3, "trigger current");
  return {
    schema_version: 1,
    run_id: runId,
    harness_session_id: "session-e2e",
    execution_request: {
      id: "execution-e2e",
      agent_id: "agent-e2e",
      agent_revision_id: "revision-e2e",
      source_type: "channel_message",
      source_id: "message-3"
    },
    agent_revision: {
      definition: { instructions: "Answer briefly." },
      execution_profile: { adapter_type: "fake", workdir: process.cwd(), agent_config: {} }
    },
    immutable_execution_input: {
      content: {
        parts: [{ type: "text", text: "trigger current" }],
        channel_context: {
          scope,
          consumer_key: "agent-e2e/provider-e2e",
          session_generation: 1,
          trigger_message_id: trigger.message_id,
          trigger_seq: trigger.message_seq,
          trigger_fact: trigger
        }
      }
    }
  };
}

function wire(type, payload) {
  return JSON.stringify({
    version: 1,
    id: `wire-${Math.random()}`,
    type,
    sent_at: new Date().toISOString(),
    payload
  });
}

function deferred() {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timeout");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

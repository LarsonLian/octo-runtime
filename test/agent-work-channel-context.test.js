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
import { deferred, terminalGrant, waitFor, wire, withTimeout } from "./agent-work-runtime-fixture.js";

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
		websocket.send(wire("context.append", { agent_id: "agent-1", scope, facts: [fact(2, "second background")] }));
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
        assert.equal(envelope.payload.agent_run_id, "run-e2e");
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
          durable_through_seq: envelope.payload.last_seq,
          ...(terminal ? terminalGrant(terminal) : {})
        }));
        if (terminal) terminalSent.resolve();
      }
    });
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    const host = {
      list: async () => [{ type: "fake", capabilities: ["session.serialize", "session.resume_recovery"] }],
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
      runtimeId: "runtime-e2e",
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
    assert.equal(registration.capabilities.channel_context.serializer_version, "channel-context-jsonl-v2");
    assert.equal(registration.capabilities.channel_context.message_retention_ms, 24 * 60 * 60 * 1000);
    assert.equal(registration.capabilities.channel_context.active_snapshot_timeout_ms, 24 * 60 * 60 * 1000);
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
          durable_through_seq: envelope.payload.last_seq,
          ...(terminal ? terminalGrant(terminal) : {})
        }));
        if (terminal) terminalAckSent.resolve();
      }
    });
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    const host = {
      list: async () => [{ type: "fake", capabilities: ["session.serialize", "session.resume_recovery"] }],
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

test("context cursor fails closed when the durable ACK lacks matching terminal authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-channel-runtime-authority-"));
  const contextPath = join(directory, "channel-context.db");
  const outboxPath = join(directory, "agent-work.db");
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const allAcked = deferred();
  let runtime;

  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* consume registration body */ }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { id: "runtime-authority" } }));
  });
  httpServer.on("upgrade", (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", websocket => {
    const sendStart = index => websocket.send(wire("runtime.command", {
      server_seq: index,
      command_id: `command-authority-${index}`,
      run_id: `run-authority-${index}`,
      type: "run.start",
      payload: executionEnvelope(`run-authority-${index}`, index + 2, `trigger authority ${index}`),
      lease_id: `lease-authority-${index}`,
      fencing_token: index
    }));
    websocket.on("message", data => {
      const envelope = JSON.parse(data.toString("utf8"));
      if (envelope.type === "runtime.hello") {
        websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 }));
		websocket.send(wire("context.append", { agent_id: "agent-1", scope, facts: [fact(1, "first"), fact(2, "second")] }));
        sendStart(1);
        return;
      }
      if (envelope.type === "context.sync_request") {
        websocket.send(wire("context.sync_result", {
          request_id: envelope.payload.request_id,
          scope,
          facts: [fact(1, "first"), fact(2, "second")],
          completeness: "complete",
          through_seq: 2
        }));
        return;
      }
      if (envelope.type !== "run.event_batch") return;
      const terminal = envelope.payload.events.find(event => event.type === "run.completed");
      const index = Number(envelope.payload.run_id.split("-").at(-1));
      const authority = terminal && index === 1
        ? { context_commit_granted: true }
        : terminal && index === 2
          ? {
              context_commit_granted: true,
              authoritative_terminal_status: "completed",
              authoritative_terminal_event_id: "event-wrong"
            }
          : terminal
            ? {
                context_commit_granted: false,
                authoritative_terminal_status: "failed",
                authoritative_terminal_event_id: terminal.event_id
              }
            : {};
      websocket.send(wire("event.ack", {
        run_id: envelope.payload.run_id,
        received_through_seq: envelope.payload.last_seq,
        durable_through_seq: envelope.payload.last_seq,
        ...authority
      }));
      if (!terminal) return;
      if (index < 3) setTimeout(() => sendStart(index + 1), 30);
      else allAcked.resolve();
    });
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    const host = {
      list: async () => [{ type: "fake", capabilities: ["session.serialize", "session.resume_recovery"] }],
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
      runtimeName: "runtime-authority",
      fingerprint: "runtime:authority",
      storePath: outboxPath,
      channelContext: {
        store: "sqlite",
        projection: "delta",
        providerPersistence: "append_only",
        storePath: contextPath,
        syncTimeoutMs: 1_000
      }
    }, host);
    await runtime.start();
    await withTimeout(allAcked.promise, 3_000, "authority ACK sequence timeout");
    await waitFor(() => runtime.status.outboxPending === 0 && runtime.status.channelContext.activeSnapshots === 0);
    await runtime.close();
    runtime = undefined;

    const contextStore = ChannelContextStore.open(contextPath);
    for (let index = 1; index <= 3; index += 1) {
      assert.equal(contextStore.getSnapshot(`run-authority-${index}`).state, "failed");
    }
    const probe = contextStore.prepareSnapshot("run-authority-probe", executionEnvelope(
      "run-authority-probe", 6, "probe"
    ).agent_run_request.input.channel_context);
    assert.deepEqual(probe.facts.map(item => item.message_seq), [1, 2, 3, 4, 5]);
    contextStore.close();

    const outboxStore = AgentWorkStore.open(outboxPath);
    assert.equal(outboxStore.pendingCount(), 0, "authoritatively rejected terminals are still durably received");
    outboxStore.close();
  } finally {
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a later run waits for the prior durable cursor commit and then freezes from the advanced cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-channel-runtime-ordered-"));
  const contextPath = join(directory, "channel-context.db");
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const priorAckReleased = deferred();
  const secondCommandAcked = deferred();
  const secondTerminalAcked = deferred();
  const thirdTerminalAcked = deferred();
  const providerRequests = [];
  let runtime;
  let secondAckSeen = false;
  let secondAckCount = 0;
  let secondInvokeSeen = false;
  let secondSent = false;
  let thirdSent = false;
  let observedBeforePriorAck;
  let nextStarted;

  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* consume registration body */ }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { id: "runtime-ordered" } }));
  });
  httpServer.on("upgrade", (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", websocket => {
    websocket.on("message", data => {
      const envelope = JSON.parse(data.toString("utf8"));
      if (envelope.type === "runtime.hello") {
        websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 }));
        websocket.send(wire("context.append", {
		  agent_id: "agent-1",
          scope,
          facts: [fact(1, "first background"), fact(2, "second background")]
        }));
        websocket.send(wire("runtime.command", {
          server_seq: 1,
          command_id: "command-prior",
          run_id: "run-prior",
          type: "run.start",
          payload: executionEnvelope("run-prior", 3, "prior trigger"),
          lease_id: "lease-prior",
          fencing_token: 1
        }));
        return;
      }
      if (envelope.type === "context.sync_request") {
        websocket.send(wire("context.sync_result", {
          request_id: envelope.payload.request_id,
          scope,
          facts: [fact(1, "first background"), fact(2, "second background")],
          completeness: "complete",
          through_seq: 2
        }));
        return;
      }
      if (envelope.type === "command.ack" && envelope.payload.command_id === "command-next") {
        secondAckSeen = true;
        secondAckCount += 1;
        secondCommandAcked.resolve();
        return;
      }
      if (envelope.type !== "run.event_batch") return;

      const terminal = envelope.payload.events.find(event => event.type === "run.completed");
      if (envelope.payload.run_id === "run-next") {
        nextStarted ??= envelope.payload.events.find(event => event.type === "run.started");
      }
      if (envelope.payload.run_id === "run-prior" && terminal && !secondSent) {
        secondSent = true;
		websocket.send(wire("context.append", { agent_id: "agent-1", scope, facts: [fact(4, "fourth background")] }));
        const nextCommand = {
          server_seq: 2,
          command_id: "command-next",
          run_id: "run-next",
          type: "run.start",
          payload: executionEnvelope("run-next", 5, "next trigger"),
          lease_id: "lease-next",
          fencing_token: 2
        };
        websocket.send(wire("runtime.command", nextCommand));
        setTimeout(() => websocket.send(wire("runtime.command", nextCommand)), 30);
        setTimeout(() => {
          observedBeforePriorAck = { secondAckSeen, secondInvokeSeen };
          websocket.send(wire("event.ack", {
            run_id: "run-prior",
            received_through_seq: envelope.payload.last_seq,
            durable_through_seq: envelope.payload.last_seq,
            ...terminalGrant(terminal)
          }));
          priorAckReleased.resolve();
        }, 80);
        return;
      }

      websocket.send(wire("event.ack", {
        run_id: envelope.payload.run_id,
        received_through_seq: envelope.payload.last_seq,
        durable_through_seq: envelope.payload.last_seq,
        ...(terminal ? terminalGrant(terminal) : {})
      }));
      if (envelope.payload.run_id === "run-next" && terminal) {
        secondTerminalAcked.resolve();
        if (!thirdSent) {
          thirdSent = true;
          setTimeout(() => {
			websocket.send(wire("context.append", { agent_id: "agent-1", scope, facts: [fact(6, "sixth background")] }));
            websocket.send(wire("runtime.command", {
              server_seq: 3,
              command_id: "command-third",
              run_id: "run-third",
              type: "run.start",
              payload: executionEnvelope("run-third", 7, "third trigger", 2),
              lease_id: "lease-third",
              fencing_token: 3
            }));
          }, 30);
        }
      }
      if (envelope.payload.run_id === "run-third" && terminal) thirdTerminalAcked.resolve();
    });
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    const host = {
      list: async () => [{ type: "fake", capabilities: ["session.serialize", "session.resume_recovery"] }],
      cancel: async () => ({ cancelled: true }),
      async *invoke(_adapterType, request) {
        providerRequests.push(request);
        if (request.runId === "run-next") secondInvokeSeen = true;
        if (request.runId === "run-next") {
          yield {
            type: "session.update",
            payload: {
              providerSession: {
                sessionId: "fresh-provider-session",
                resumeOutcome: "fresh_fallback",
                contextInputVariant: "recovery"
              }
            }
          };
        }
        yield { type: "run.finished", payload: {} };
      }
    };
    runtime = new AgentWorkRuntime({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      tenantId: "tenant-e2e",
      subjectId: "device-e2e",
      runtimeName: "runtime-ordered",
      fingerprint: "runtime:ordered",
      storePath: join(directory, "agent-work.db"),
      channelContext: {
        store: "sqlite",
        projection: "delta",
        providerPersistence: "append_only",
        storePath: contextPath,
        syncTimeoutMs: 1_000
      }
    }, host);
    await runtime.start();
    await withTimeout(priorAckReleased.promise, 3_000, "prior ACK release timeout");
    assert.deepEqual(observedBeforePriorAck, { secondAckSeen: false, secondInvokeSeen: false });
    await withTimeout(secondCommandAcked.promise, 3_000, "second command ACK timeout");
    await withTimeout(secondTerminalAcked.promise, 3_000, "second terminal timeout");
    await withTimeout(thirdTerminalAcked.promise, 3_000, "third terminal timeout");
    await waitFor(() => runtime.status.channelContext.activeSnapshots === 0);
    assert.equal(secondAckCount, 1);
    assert.equal(providerRequests.filter(request => request.runId === "run-next").length, 1);

    const nextRequest = providerRequests.find(request => request.runId === "run-next");
    assert.match(nextRequest.modelInput, /fourth background/);
    assert.doesNotMatch(nextRequest.modelInput, /first background|second background|prior trigger/);
    assert.match(nextRequest.freshFallbackModelInput, /first background/);
    assert.match(nextRequest.freshFallbackModelInput, /second background/);
    assert.match(nextRequest.freshFallbackModelInput, /prior trigger/);
    assert.equal(nextStarted.payload.context_input_variant, "recovery");
    assert.equal(nextStarted.payload.context_session_generation, 2);
    assert.equal(nextStarted.payload.context_snapshot_sha256, nextRequest.contextSnapshot.recovery_rendered_sha256);
    const thirdRequest = providerRequests.find(request => request.runId === "run-third");
    assert.match(thirdRequest.modelInput, /sixth background/);
    assert.doesNotMatch(thirdRequest.modelInput, /first background|second background|prior trigger|fourth background/);

    await runtime.close();
    runtime = undefined;
    const contextStore = ChannelContextStore.open(contextPath);
    assert.equal(contextStore.getSnapshot("run-prior").state, "committed");
    assert.equal(contextStore.getSnapshot("run-next").state, "committed");
    assert.deepEqual(contextStore.getSnapshot("run-next").facts.map(item => item.message_seq), [4]);
    assert.equal(contextStore.getSnapshot("run-next").selectedVariant, "recovery");
    assert.equal(contextStore.getSnapshot("run-next").ref.session_generation, 2);
    assert.equal(contextStore.getSnapshot("run-third").state, "committed");
    assert.deepEqual(contextStore.getSnapshot("run-third").facts.map(item => item.message_seq), [6]);
    contextStore.close();
  } finally {
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime rejects a queued source generation after recovery advanced the effective generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-channel-runtime-stale-generation-"));
  const contextPath = join(directory, "channel-context.db");
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const rejected = deferred();
  let runtime;
  let invocationCount = 0;

  const contextStore = ChannelContextStore.open(contextPath);
  contextStore.applySyncResult({
    request_id: "sync-recovery-blocker",
    scope,
    facts: [fact(1, "background")],
    completeness: "complete",
    through_seq: 1
  });
  const blocker = executionEnvelope("run-recovery-blocker", 2, "recovery trigger")
    .agent_run_request.input.channel_context;
  contextStore.prepareSnapshot("run-recovery-blocker", blocker);
  contextStore.selectRecovery("run-recovery-blocker");
  contextStore.markSubmitted("run-recovery-blocker");
  contextStore.close();

  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* consume registration body */ }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { id: "runtime-stale-generation" } }));
  });
  httpServer.on("upgrade", (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", websocket => {
    websocket.on("message", data => {
      const envelope = JSON.parse(data.toString("utf8"));
      if (envelope.type === "runtime.hello") {
        websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 }));
        websocket.send(wire("runtime.command", {
          server_seq: 1,
          command_id: "command-stale-generation",
          run_id: "run-stale-generation",
          type: "run.start",
          payload: executionEnvelope("run-stale-generation", 3, "queued trigger"),
          lease_id: "lease-stale-generation",
          fencing_token: 1
        }));
      }
      if (envelope.type === "command.ack" && envelope.payload.command_id === "command-stale-generation") {
        rejected.resolve(envelope.payload);
      }
    });
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    const host = {
      list: async () => [{ type: "fake", capabilities: ["session.serialize", "session.resume_recovery"] }],
      cancel: async () => ({ cancelled: true }),
      async *invoke() {
        invocationCount += 1;
        yield { type: "run.finished", payload: {} };
      }
    };
    runtime = new AgentWorkRuntime({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      tenantId: "tenant-e2e",
      subjectId: "device-e2e",
      runtimeName: "runtime-stale-generation",
      fingerprint: "runtime:stale-generation",
      storePath: join(directory, "agent-work.db"),
      channelContext: {
        store: "sqlite",
        projection: "delta",
        providerPersistence: "append_only",
        storePath: contextPath
      }
    }, host);
    await runtime.start();
    const ack = await withTimeout(rejected.promise, 3_000, "stale generation rejection timeout");
    assert.equal(ack.accepted, false);
    assert.deepEqual(ack.error, {
      code: "STALE_CONTEXT_GENERATION",
      message: "channel context generation 1 is stale; latest generation is 2",
      requested_generation: 1,
      latest_generation: 2
    });
    assert.equal(invocationCount, 0);
    assert.equal(runtime.status.channelContext.activeSnapshots, 1);
  } finally {
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime close joins a waiting command before immediate restart and replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-channel-runtime-close-wait-"));
  const contextPath = join(directory, "channel-context.db");
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const commandDispatched = deferred();
  const replayTerminal = deferred();
  let runtime;
  let commandAcked = false;
  let invocationCount = 0;
  let helloCount = 0;

  const contextStore = ChannelContextStore.open(contextPath);
  contextStore.applySyncResult({
    request_id: "sync-blocker",
    scope,
    facts: [fact(1, "background")],
    completeness: "complete",
    through_seq: 1
  });
  const blocker = executionEnvelope("run-blocker", 2, "blocker trigger")
    .agent_run_request.input.channel_context;
  contextStore.prepareSnapshot("run-blocker", blocker);
  contextStore.markSubmitted("run-blocker");
  contextStore.close();

  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* consume registration body */ }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { id: "runtime-close-wait" } }));
  });
  httpServer.on("upgrade", (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", websocket => {
    websocket.on("message", data => {
      const envelope = JSON.parse(data.toString("utf8"));
      if (envelope.type === "runtime.hello") {
        helloCount += 1;
        websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 }));
        websocket.send(wire("runtime.command", {
          server_seq: 1,
          command_id: "command-waiting",
          run_id: "run-waiting",
          type: "run.start",
          payload: executionEnvelope("run-waiting", 3, "waiting trigger"),
          lease_id: "lease-waiting",
          fencing_token: 1
        }));
        commandDispatched.resolve();
      }
      if (envelope.type === "command.ack" && envelope.payload.command_id === "command-waiting") {
        commandAcked = true;
      }
      if (envelope.type === "run.event_batch") {
        const terminal = envelope.payload.events.find(event => event.type === "run.completed");
        websocket.send(wire("event.ack", {
          run_id: envelope.payload.run_id,
          received_through_seq: envelope.payload.last_seq,
          durable_through_seq: envelope.payload.last_seq,
          ...(terminal ? terminalGrant(terminal) : {})
        }));
        if (terminal) replayTerminal.resolve();
      }
    });
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    const host = {
      list: async () => [{ type: "fake", capabilities: ["session.serialize", "session.resume_recovery"] }],
      cancel: async () => ({ cancelled: true }),
      async *invoke() {
        invocationCount += 1;
        yield { type: "run.finished", payload: {} };
      }
    };
    runtime = new AgentWorkRuntime({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      tenantId: "tenant-e2e",
      subjectId: "device-e2e",
      runtimeName: "runtime-close-wait",
      fingerprint: "runtime:close-wait",
      storePath: join(directory, "agent-work.db"),
      channelContext: {
        store: "sqlite",
        projection: "delta",
        providerPersistence: "append_only",
        storePath: contextPath,
        syncTimeoutMs: 1_000
      }
    }, host);
    await runtime.start();
    await withTimeout(commandDispatched.promise, 3_000, "waiting command dispatch timeout");
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(commandAcked, false);
    assert.equal(invocationCount, 0);
    await withTimeout(runtime.close(), 1_000, "runtime close while waiting timeout");
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(invocationCount, 0);

    const reopened = ChannelContextStore.open(contextPath);
    assert.equal(reopened.getSnapshot("run-waiting"), undefined);
    reopened.markFailed("run-blocker");
    reopened.close();

    await runtime.start();
    await withTimeout(replayTerminal.promise, 3_000, "replayed run terminal timeout");
    await waitFor(() => runtime.status.outboxPending === 0);
    assert.equal(helloCount, 2);
    assert.equal(commandAcked, true);
    assert.equal(invocationCount, 1);
    await runtime.close();
    runtime = undefined;

    const completed = ChannelContextStore.open(contextPath);
    assert.equal(completed.getSnapshot("run-waiting").state, "committed");
    completed.close();
  } finally {
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("run.cancel tombstones a busy accepting run and replay cannot invoke it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-channel-runtime-cancel-wait-"));
  const contextPath = join(directory, "channel-context.db");
  const outboxPath = join(directory, "agent-work.db");
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const cancelled = deferred();
  const replayed = deferred();
  let runtime;
  let invocationCount = 0;
  let startAckCount = 0;
  let beforeCancelAck;

  const contextStore = ChannelContextStore.open(contextPath);
  contextStore.applySyncResult({
    request_id: "sync-cancel-blocker",
    scope,
    facts: [fact(1, "background")],
    completeness: "complete",
    through_seq: 1
  });
  const blocker = executionEnvelope("run-cancel-blocker", 2, "blocker trigger")
    .agent_run_request.input.channel_context;
  contextStore.prepareSnapshot("run-cancel-blocker", blocker);
  contextStore.markSubmitted("run-cancel-blocker");
  contextStore.close();

  const startCommand = {
    server_seq: 1,
    command_id: "command-cancel-waiting",
    run_id: "run-cancel-waiting",
    type: "run.start",
    payload: executionEnvelope("run-cancel-waiting", 3, "waiting trigger"),
    lease_id: "lease-cancel-waiting",
    fencing_token: 1
  };
  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* consume registration body */ }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { id: "runtime-cancel-wait" } }));
  });
  httpServer.on("upgrade", (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", websocket => {
    websocket.on("message", data => {
      const envelope = JSON.parse(data.toString("utf8"));
      if (envelope.type === "runtime.hello") {
        websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 }));
        websocket.send(wire("runtime.command", startCommand));
        setTimeout(() => {
          beforeCancelAck = startAckCount;
          websocket.send(wire("runtime.command", {
            server_seq: 2,
            command_id: "command-cancel-accepting",
            run_id: "run-cancel-waiting",
            type: "run.cancel",
            payload: {},
            lease_id: "lease-cancel-waiting",
            fencing_token: 1
          }));
        }, 60);
        return;
      }
      if (envelope.type !== "command.ack") return;
      if (envelope.payload.command_id === "command-cancel-accepting") {
        assert.equal(envelope.payload.accepted, true);
        cancelled.resolve();
      }
      if (envelope.payload.command_id === startCommand.command_id) {
        startAckCount += 1;
        assert.equal(envelope.payload.accepted, false);
        assert.equal(envelope.payload.error.code, "RUN_CANCELLED_BEFORE_START");
        if (startAckCount === 1) websocket.send(wire("runtime.command", startCommand));
        if (startAckCount === 2) replayed.resolve();
      }
    });
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    const host = {
      list: async () => [{ type: "fake", capabilities: ["session.serialize", "session.resume_recovery"] }],
      cancel: async () => ({ cancelled: true }),
      async *invoke() {
        invocationCount += 1;
        yield { type: "run.finished", payload: {} };
      }
    };
    runtime = new AgentWorkRuntime({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      tenantId: "tenant-e2e",
      subjectId: "device-e2e",
      runtimeName: "runtime-cancel-wait",
      fingerprint: "runtime:cancel-wait",
      storePath: outboxPath,
      channelContext: {
        store: "sqlite",
        projection: "delta",
        providerPersistence: "append_only",
        storePath: contextPath,
        syncTimeoutMs: 1_000
      }
    }, host);
    await runtime.start();
    await withTimeout(cancelled.promise, 3_000, "accepting cancel ACK timeout");
    await withTimeout(replayed.promise, 3_000, "cancelled start replay ACK timeout");
    assert.equal(beforeCancelAck, 0);
    assert.equal(invocationCount, 0);
    assert.equal(startAckCount, 2);
    await runtime.close();
    runtime = undefined;

    const reopened = AgentWorkStore.open(outboxPath);
    assert.equal(reopened.getCommandReceipt(startCommand.command_id).accepted, false);
    reopened.close();
  } finally {
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("append-only channel context cold-starts an adapter without continuity recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-channel-runtime-capability-"));
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const accepted = deferred();
  const completed = deferred();
  const emitted = [];
  let runtime;
  let providerRequest;

  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* consume registration body */ }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { id: "runtime-capability" } }));
  });
  httpServer.on("upgrade", (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, websocket => wsServer.emit("connection", websocket, request));
  });
  wsServer.on("connection", websocket => {
    websocket.on("message", data => {
      const envelope = JSON.parse(data.toString("utf8"));
      if (envelope.type === "runtime.hello") {
        websocket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 }));
        const payload = executionEnvelope("run-stateless", 2, "current message");
        payload.provider_session = { sessionId: "stale-provider-session", resumable: true };
        websocket.send(wire("runtime.command", {
          server_seq: 1,
          command_id: "command-stateless",
          run_id: "run-stateless",
          type: "run.start",
          payload,
          lease_id: "lease-stateless",
          fencing_token: 1
        }));
      }
      if (envelope.type === "context.sync_request") {
        websocket.send(wire("context.sync_result", {
          request_id: envelope.payload.request_id,
          scope,
          facts: [fact(1, "background message")],
          completeness: "complete",
          through_seq: 1
        }));
      }
      if (envelope.type === "command.ack" && envelope.payload.command_id === "command-stateless") {
        accepted.resolve(envelope.payload);
      }
      if (envelope.type === "run.event_batch") {
        emitted.push(...envelope.payload.events);
        const terminal = envelope.payload.events.find(event => event.type === "run.completed");
        websocket.send(wire("event.ack", {
          run_id: envelope.payload.run_id,
          received_through_seq: envelope.payload.last_seq,
          durable_through_seq: envelope.payload.last_seq,
          ...(terminal ? terminalGrant(terminal) : {})
        }));
        if (terminal) completed.resolve();
      }
    });
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    const host = {
      list: async () => [{ type: "fake", capabilities: ["session.serialize"] }],
      cancel: async () => ({ cancelled: true }),
      async *invoke(_adapterType, request) {
        providerRequest = request;
        yield { type: "session.update", payload: { providerSession: { sessionId: "new-provider-session", resumable: true } } };
        yield { type: "message.delta", payload: { channel: "final", text: "done" } };
        yield { type: "run.finished", payload: {} };
      }
    };
    runtime = new AgentWorkRuntime({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      tenantId: "tenant-e2e",
      subjectId: "device-e2e",
      runtimeName: "runtime-capability",
      fingerprint: "runtime:capability",
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
    const ack = await withTimeout(accepted.promise, 3_000, "cold-start adapter acceptance timeout");
    await withTimeout(completed.promise, 3_000, "cold-start adapter completion timeout");
    assert.equal(ack.accepted, true);
    assert.equal(providerRequest.providerSession, undefined);
    assert.match(providerRequest.modelInput, /background message/);
    const session = emitted.find(event => event.type === "session.update");
    assert.equal(session.payload.providerSession.resumeOutcome, "fresh_fallback");
    assert.equal(session.payload.providerSession.contextInputVariant, "recovery");
    const terminal = emitted.find(event => event.type === "run.completed");
    assert.equal(terminal.payload.context_input_variant, "recovery");
    assert.equal(terminal.payload.context_source_session_generation, 1);
    assert.equal(terminal.payload.context_session_generation, 2);
  } finally {
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

function executionEnvelope(runId = "run-e2e", triggerSeq = 3, currentText = "trigger current", generation = 1) {
  const trigger = fact(triggerSeq, currentText);
  return {
    schema_version: 1,
    run_id: runId,
    agent_session_id: "session-e2e",
    agent_run_request: {
      namespace: "im",
      agent_id: "agent-e2e",
      agent_revision_id: "revision-e2e",
      session_key: "v1/octo/endpoint-e2e/group/group-e2e",
      trigger: { kind: "im.message", occurrence_id: `message/${trigger.message_id}` },
      input: {
        parts: [{ type: "text", text: currentText }],
        channel_context: {
          scope,
          consumer_key: "agent-e2e/provider-e2e",
          session_generation: generation,
          trigger_message_id: trigger.message_id,
          trigger_seq: trigger.message_seq,
          trigger_fact: trigger
        }
      }
    },
    agent_revision: {
      definition: { instructions: "Answer briefly." },
      execution_profile: { default_adapter: "fake", workdir: process.cwd(), agent_config: {} }
    }
  };
}

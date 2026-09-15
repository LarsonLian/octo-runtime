import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { AgentWorkRuntime } from "../apps/daemon/dist/agent-work-runtime.js";
import { ChannelContextStore } from "../apps/daemon/dist/channel-context-store.js";
import { deferred, terminalGrant, waitFor, wire, withTimeout } from "./agent-work-runtime-fixture.js";

const occurredAt = Date.now();

test("two Agents isolate group deltas while idle recovery and two-round DM preserve causality", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-channel-multi-agent-"));
  const contextPath = join(directory, "channel-context.db");
  const httpServer = createServer();
  const wsServer = new WebSocketServer({ noServer: true });
  const providerRequests = new Map();
  const completedRuns = new Set();
  const allCompleted = deferred();
  const scopes = { a: groupScope("a"), b: groupScope("b") };
  let runtime;
  let secondRoundSent = false;
  let recoveryRoundSent = false;

  httpServer.on("request", async (request, response) => {
    for await (const _chunk of request) { /* Consume the registration body. */ }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { profile: "default", id: "runtime-multi-agent" } }));
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
		  agent_id: "agent-a",
          scope: scopes.a,
          facts: [groupFact("a", 1, "A background ABCDE")]
        }));
        websocket.send(wire("context.append", {
		  agent_id: "agent-b",
          scope: scopes.b,
          facts: [groupFact("b", 1, "B background ABCDE")]
        }));
        websocket.send(startCommand(1, "group-a-1", groupEnvelope("a", 1, "U1 for A")));
        websocket.send(startCommand(2, "group-b-1", groupEnvelope("b", 1, "U1 for B")));
        websocket.send(startCommand(3, "dm-a-1", dmEnvelope(1)));
        return;
      }
      if (envelope.type === "context.sync_request") {
        const agent = envelope.payload.scope.bot_id === "bot-a" ? "a" : "b";
        websocket.send(wire("context.sync_result", {
          request_id: envelope.payload.request_id,
          scope: scopes[agent],
          facts: [groupFact(agent, 1, `${agent.toUpperCase()} background ABCDE`)],
          completeness: "complete",
          through_seq: 1
        }));
        return;
      }
      if (envelope.type !== "run.event_batch") return;
      const terminal = envelope.payload.events.find(event => event.type === "run.completed");
      websocket.send(wire("event.ack", {
        run_id: envelope.payload.run_id,
        received_through_seq: envelope.payload.last_seq,
        durable_through_seq: envelope.payload.last_seq,
        ...(terminal ? terminalGrant(terminal) : {})
      }));
      if (!terminal) return;

      completedRuns.add(envelope.payload.run_id);
      if (!secondRoundSent && ["run-group-a-1", "run-group-b-1", "run-dm-a-1"].every(id => completedRuns.has(id))) {
        secondRoundSent = true;
        websocket.send(wire("context.append", {
		  agent_id: "agent-a",
          scope: scopes.a,
          facts: [groupFact("a", 3, "F after R1 for A")]
        }));
        websocket.send(wire("context.append", {
		  agent_id: "agent-b",
          scope: scopes.b,
          facts: [groupFact("b", 3, "F after R1 for B")]
        }));
        websocket.send(startCommand(4, "group-a-2", groupEnvelope("a", 2, "U2 for A")));
        websocket.send(startCommand(5, "group-b-2", groupEnvelope("b", 2, "U2 for B")));
        websocket.send(startCommand(6, "dm-a-2", dmEnvelope(2)));
      }
      if (!recoveryRoundSent && ["run-group-a-2", "run-group-b-2", "run-dm-a-2"].every(id => completedRuns.has(id))) {
        recoveryRoundSent = true;
        websocket.send(wire("context.append", {
		  agent_id: "agent-a",
          scope: scopes.a,
          facts: [groupFact("a", 5, "G before idle recovery for A")]
        }));
        websocket.send(startCommand(7, "group-a-3", groupEnvelope("a", 3, "U3 after idle recovery for A")));
      }
      if (completedRuns.size === 7) allCompleted.resolve();
    });
  });

  try {
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    const host = {
      list: async () => [{ type: "fake", capabilities: ["session.serialize", "session.resume_recovery"] }],
      cancel: async () => ({ cancelled: true }),
      async *invoke(_adapterType, request) {
        providerRequests.set(request.runId, request);
        yield {
          type: "session.update",
          payload: { providerSession: { sessionId: providerSessionFor(request.runId), resumable: true } }
        };
        yield { type: "message.delta", payload: { channel: "final", text: `R1 ${request.runId}` } };
        yield { type: "run.finished", payload: {} };
      }
    };
    runtime = new AgentWorkRuntime({
      profile: "default",
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "runtime-token",
      tenantId: "tenant-e2e",
      subjectId: "device-e2e",
      runtimeName: "runtime-multi-agent",
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
    await withTimeout(allCompleted.promise, 4_000, "multi-Agent terminal ACK timeout");
    await waitFor(() => runtime.status.outboxPending === 0 && runtime.status.channelContext.activeSnapshots === 0);

    const a1 = providerRequests.get("run-group-a-1");
    const b1 = providerRequests.get("run-group-b-1");
    const a2 = providerRequests.get("run-group-a-2");
    const b2 = providerRequests.get("run-group-b-2");
    const a3 = providerRequests.get("run-group-a-3");
    const dm1 = providerRequests.get("run-dm-a-1");
    const dm2 = providerRequests.get("run-dm-a-2");
    assert.match(a1.modelInput, /A background ABCDE/);
    assert.doesNotMatch(a1.modelInput, /B background ABCDE/);
    assert.match(b1.modelInput, /B background ABCDE/);
    assert.doesNotMatch(b1.modelInput, /A background ABCDE/);
    assert.equal(a2.providerSession.sessionId, "provider-group-a");
    assert.match(a2.modelInput, /F after R1 for A/);
    assert.match(a2.modelInput, /U2 for A/);
    assert.doesNotMatch(a2.modelInput, /background ABCDE|F after R1 for B|U2 for B/);
    assert.equal(b2.providerSession.sessionId, "provider-group-b");
    assert.match(b2.modelInput, /F after R1 for B/);
    assert.match(b2.modelInput, /U2 for B/);
    assert.doesNotMatch(b2.modelInput, /background ABCDE|F after R1 for A|U2 for A/);
    assert.equal(a3.providerSession, undefined);
    assert.match(a3.modelInput, /A background ABCDE/);
    assert.match(a3.modelInput, /F after R1 for A/);
    assert.match(a3.modelInput, /G before idle recovery for A/);
    assert.match(a3.modelInput, /U3 after idle recovery for A/);
    assert.doesNotMatch(a3.modelInput, /B background ABCDE|F after R1 for B/);
    assert.equal(dm1.providerSession, undefined);
    assert.equal(dm1.contextSnapshot, undefined);
    assert.equal(dm1.modelInput, undefined);
    assert.match(dm1.prompt, /DM U1 for A/);
    assert.equal(dm2.providerSession.sessionId, "provider-dm-a");
    assert.equal(dm2.contextSnapshot, undefined);
    assert.equal(dm2.modelInput, undefined);
    assert.match(dm2.prompt, /DM U2 for A/);
    assert.doesNotMatch(dm2.prompt, /background ABCDE|F after R1|idle recovery/);

    await runtime.close();
    runtime = undefined;
    const store = ChannelContextStore.open(contextPath);
    for (const runId of ["run-group-a-1", "run-group-b-1", "run-group-a-2", "run-group-b-2", "run-group-a-3"]) {
      assert.equal(store.getSnapshot(runId).state, "committed");
    }
    assert.deepEqual(store.getSnapshot("run-group-a-2").facts.map(item => item.message_seq), [3]);
    assert.deepEqual(store.getSnapshot("run-group-b-2").facts.map(item => item.message_seq), [3]);
    assert.deepEqual(store.getSnapshot("run-group-a-3").facts.map(item => item.message_seq), [1, 2, 3, 4, 5]);
    assert.equal(store.getSnapshot("run-dm-a-1"), undefined);
    assert.equal(store.getSnapshot("run-dm-a-2"), undefined);
    store.close();
  } finally {
    await runtime?.close();
    for (const client of wsServer.clients) client.terminate();
    await new Promise(resolve => wsServer.close(() => resolve()));
    await new Promise(resolve => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

function groupScope(agent) {
  return {
    tenant_id: "tenant-e2e",
    endpoint_id: `endpoint-${agent}`,
    channel: "fake-im",
    account_id: null,
    bot_id: `bot-${agent}`,
    conversation_id: "shared-group"
  };
}

function groupFact(agent, seq, text) {
  return {
    message_id: `group-message-${seq}`,
    message_seq: seq,
    sender: { id: `member-${seq}`, label: `Member ${seq}`, kind: "member" },
    occurred_at_ms: occurredAt + seq,
    parts: [{ type: "text", text }],
    flags: { addressed_to_this_bot: text.startsWith("U") }
  };
}

function groupEnvelope(agent, round, text) {
  const triggerSeq = round * 2;
  const trigger = groupFact(agent, triggerSeq, text);
  return {
    schema_version: 1,
    run_id: `run-group-${agent}-${round}`,
    agent_session_id: `harness-group-${agent}`,
    ...(round === 2 ? { provider_session: { sessionId: `provider-group-${agent}`, resumable: true } } : {}),
    agent_run_request: {
      namespace: "im",
      agent_id: `agent-${agent}`,
      agent_revision_id: `revision-${agent}`,
      session_key: `v1/octo/endpoint-${agent}/group/group-${agent}`,
      trigger: { kind: "im.message", occurrence_id: `message/${trigger.message_id}` },
      input: {
        parts: [{ type: "text", text }],
        channel_context: {
          scope: groupScope(agent),
          consumer_key: `agent-${agent}/provider-group-${agent}`,
          session_generation: round === 3 ? 2 : 1,
          trigger_message_id: trigger.message_id,
          trigger_seq: trigger.message_seq,
          trigger_fact: trigger
        }
      }
    },
    agent_revision: {
      definition: { instructions: `Answer as Agent ${agent.toUpperCase()}.` },
      execution_profile: { default_adapter: "fake", workdir: process.cwd(), agent_config: {} }
    }
  };
}

function dmEnvelope(round) {
  return {
    schema_version: 1,
    run_id: `run-dm-a-${round}`,
    agent_session_id: "harness-dm-a",
    ...(round === 2 ? { provider_session: { sessionId: "provider-dm-a", resumable: true } } : {}),
    agent_run_request: {
      namespace: "im",
      agent_id: "agent-a",
      agent_revision_id: "revision-a",
      session_key: "v1/octo/endpoint-a/dm/user-a",
      trigger: { kind: "im.message", occurrence_id: `message/dm-message-${round}` },
      input: { parts: [{ type: "text", text: `DM U${round} for A` }] }
    },
    agent_revision: {
      definition: { instructions: "Answer as Agent A." },
      execution_profile: { default_adapter: "fake", workdir: process.cwd(), agent_config: {} }
    }
  };
}

function startCommand(serverSeq, key, payload) {
  return wire("runtime.command", {
    server_seq: serverSeq,
    command_id: `command-${key}`,
    run_id: payload.run_id,
    type: "run.start",
    payload,
    lease_id: `lease-${key}`,
    fencing_token: serverSeq
  });
}

function providerSessionFor(runId) {
  if (runId.includes("run-dm-a")) return "provider-dm-a";
  return runId.includes("group-a") ? "provider-group-a" : "provider-group-b";
}

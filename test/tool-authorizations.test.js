import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { AgentWorkRuntime } from "../packages/octo-harness-daemon/dist/agent-work-runtime.js";
import { businessServiceConnections, resolveToolAuthorizations, unconsumedToolAuthorizations } from "../packages/octo-harness-daemon/dist/tool-authorizations.js";
import { contextEnvelope, executionContext, resolvedRuntimeSelection, waitFor, wire } from "./agent-work-runtime-fixture.js";
import { issuedGrant, toolIntent } from "./tool-authorizations-fixture.js";

test("independent authorization resolves only Run identity and matches the frozen business scope", async t => {
  let grants = [issuedGrant()];
  let supplied;
  const server = createServer(async (request, response) => {
    supplied = { path: request.url, body: JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString()) };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: { authorizations: grants } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = { baseUrl: `http://127.0.0.1:${server.address().port}`, headers: {}, runId: "run-1", leaseId: "lease-1", fencingToken: 9, signal: new AbortController().signal };
  const resolved = await resolveToolAuthorizations([toolIntent], options);
  assert.deepEqual(supplied, { path: "/v1/runtime/context/authorizations/resolve", body: { run_id: "run-1", lease_id: "lease-1", fencing_token: 9 } });
  assert.deepEqual(resolved, grants);
  for (const patch of [{ url: "https://cloud-selected.test/mcp" }, { command: "npm" }, { headers: {} }, { expires_at: "2000-01-01T00:00:00Z" }, { allowed_tools: ["extra-tool"] }, { resource_refs: ["task:other"] }]) {
    grants = [{ ...issuedGrant(), ...patch }];
    await assert.rejects(resolveToolAuthorizations([toolIntent], options), /TOOL_AUTHORIZATION_(INVALID|SCOPE_MISMATCH)/);
  }
});

test("local business bindings determine endpoints without a cloud installation definition", () => {
  const grant = issuedGrant();
  assert.deepEqual(businessServiceConnections([grant]), {});
  const services = businessServiceConnections([grant], { task: { serviceSubjectId: "loop", url: "https://user-configured.test/mcp/task" } });
  assert.equal(services.task.url, "https://user-configured.test/mcp/task");
  assert.equal(services.task.headers.Authorization, `Bearer ${grant.token}`);
  assert.deepEqual(businessServiceConnections([grant], { task: { serviceSubjectId: "different-service", url: "https://user-configured.test/mcp" } }), {});
  assert.throws(() => businessServiceConnections([grant], { task: { serviceSubjectId: "loop", url: "https://user:password@invalid.test/mcp" } }), /BUSINESS_SERVICE_BINDING_INVALID/);
});

test("ordinary Runs do not fetch grants and malformed tool intents fail before network access", async () => {
  const options = { baseUrl: "http://127.0.0.1:1", headers: {}, runId: "r", leaseId: "l", fencingToken: 1, signal: new AbortController().signal };
  assert.deepEqual(await resolveToolAuthorizations([], options), []);
  await assert.rejects(resolveToolAuthorizations([{ ...toolIntent, command: "install" }], options), /TOOL_AUTHORIZATION_INVALID/);
});

test("same-recipient grants retain native operations after framework scopes are consumed", () => {
  const grant = { ...issuedGrant(), allowed_tools: [...toolIntent.allowed_tools, "knowledge_query", "task_apply_action"] };
  const bindings = { task: { serviceSubjectId: "loop", url: "https://local.test/task" }, discussion: { serviceSubjectId: "loop", url: "https://local.test/discussion" } };
  const [residual] = unconsumedToolAuthorizations([grant], bindings);
  assert.deepEqual(residual.allowed_tools, ["knowledge_query", "task_apply_action"]);
  assert.deepEqual(residual.resource_refs, grant.resource_refs);
  assert.equal(residual.token, grant.token);
  assert.deepEqual(unconsumedToolAuthorizations([issuedGrant()], bindings), []);
  assert.deepEqual(unconsumedToolAuthorizations([grant]), [grant]);
  assert.deepEqual(grant.allowed_tools, [...toolIntent.allowed_tools, "knowledge_query", "task_apply_action"]);
});

for (const hasReceiver of [false, true]) test(`Runtime mixed Loop scopes ${hasReceiver ? "deliver residual authorization to native receiver" : "reject without native receiver"}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "octo-grant-admission-"));
  const intent = { ...toolIntent, allowed_tools: ["task_get_materials", "knowledge_query", "task_apply_action"] };
  const grant = { ...issuedGrant(), ...intent };
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain Runtime identity. */ }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url === "/v1/runtime/context/authorizations/resolve"
      ? { data: { authorizations: [grant] } } : { runtime: { profile: "default", runtime_id: "runtime-1", protocol_version: 2 } }));
  });
  const ws = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, raw, head) => ws.handleUpgrade(request, raw, head, client => ws.emit("connection", client, request)));
  const acks = [], received = [], invoked = [];
  let socket;
  ws.on("connection", client => {
    socket = client;
    client.on("message", data => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "runtime.hello") client.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 }));
      if (frame.type === "command.ack") acks.push(frame.payload);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const runtime = new AgentWorkRuntime({ profile: "default", baseUrl, token: "fixture", runtimeName: "fixture", storePath: join(directory, "runtime.db"),
    businessServiceBindings: { task: { serviceSubjectId: "loop", url: `${baseUrl}/locally-configured-task` } },
    ...(hasReceiver ? { receiveToolAuthorizations: async (grants, identity) => received.push({ grants, identity }) } : {})
  }, {
    list: async () => [{ type: "codex", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: [] }],
    cancel: async () => ({ cancelled: true }),
    async *invoke(_adapter, request) { invoked.push(request); yield { protocolVersion: 2, type: "run.completed", payload: {} }; }
  });
  t.after(async () => {
    await runtime.close();
    for (const client of ws.clients) client.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await runtime.start();
  await waitFor(() => socket?.readyState === 1);
  const plan = { agent_source: "provisioned", adapter_type: "codex", workdir: directory, approval_mode: "ask" };
  socket.send(wire("runtime.command", { server_seq: 1, command_id: "command-1", run_id: "run-1", type: "run.start", lease_id: "lease-1", fencing_token: 1,
    payload: { schema_version: 7, run_id: "run-1", agent_session_id: "session-1", effective_context: executionContext(plan),
      resolved_execution_plan: plan, resolved_runtime_selection: resolvedRuntimeSelection(), context_configuration_version: 1,
      agent_run_request: { namespace: "task", agent_id: "agent-1", agent_revision_id: "revision-1", session_affinity_key: "session-1", context: contextEnvelope(),
        trigger: { kind: "message", occurrence_id: "message-1" }, input: { text: "native tool" }, tool_authorizations: [intent] }, agent_revision: {} }
  }));
  await waitFor(() => acks.length);
  assert.equal(acks[0].accepted, hasReceiver, JSON.stringify(acks));
  if (!hasReceiver) { assert.match(acks[0].error.message, /TOOL_AUTHORIZATION_RECEIVER_UNSUPPORTED/); assert.equal(invoked.length, 0); }
  else {
    await waitFor(() => invoked.length === 1);
    assert.deepEqual(received[0].grants, [{ ...grant, allowed_tools: ["knowledge_query", "task_apply_action"] }]);
    assert.equal(received[0].identity.runId, "run-1");
    assert.equal(JSON.stringify(invoked[0]).includes(grant.token), false);
  }
});

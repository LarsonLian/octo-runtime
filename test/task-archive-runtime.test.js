import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { AgentWorkRuntime } from "../packages/octo-harness-daemon/dist/agent-work-runtime.js";
import { taskOutputManifestPath, TASK_OUTPUT_SCHEMA } from "../packages/octo-harness-daemon/dist/task-outputs.js";
import { contextEnvelope, executionContext, resolvedRuntimeSelection, waitFor, wire } from "./agent-work-runtime-fixture.js";

test("real Runtime uploads a declared deliverable before durable terminal and reports upload failure independently", async t => {
  const directory = await mkdtemp(join(tmpdir(), "oh-task-archive-runtime-"));
  await mkdir(join(directory, ".octo/task-outputs"), { recursive: true });
  const uploaded = [];
  const events = [];
  const commits = [];
  let socket;
  let runtime;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url?.startsWith("/upload/")) {
      uploaded.push({ path: request.url, body: Buffer.concat(chunks) });
      response.writeHead(request.url === "/upload/run-2" ? 503 : 200); response.end(); return;
    }
    response.setHeader("Content-Type", "application/json");
    if (request.url !== "/mcp/team") {
      response.end(JSON.stringify({ runtime: { profile: "default", id: "runtime-1", protocol_version: 2 } })); return;
    }
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    if (rpc.method === "notifications/initialized") { response.writeHead(202); response.end(); return; }
    let result;
    if (rpc.method === "initialize") result = { protocolVersion: "2025-03-26" };
    else if (rpc.params.name === "task_get_materials") result = { structuredContent: {
      task: { id: "task-1", row_version: 7, handler_epoch: 2, title: "任务" }, attachments: [], timeline: []
    } };
    else if (rpc.params.name === "task_prepare_output") result = { structuredContent: {
      ticket_id: rpc.params.arguments.manifest.output_id, upload_url: `http://127.0.0.1:${server.address().port}/upload/${rpc.params.arguments.manifest.output_id}`,
      upload_method: "PUT"
    } };
    else {
      assert.equal(rpc.params.name, "task_commit_output");
      const id = rpc.params.arguments.manifest.output_id;
      commits.push(id);
      assert.equal(events.some(event => event.type === "run.completed" && event.run_id === id), false);
      result = { structuredContent: { status: "saved", attachment_id: `attachment-${id}`, file_id: `file-${id}`, file_version_id: `version-${id}` } };
    }
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  const ws = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, raw, head) => ws.handleUpgrade(request, raw, head, client => ws.emit("connection", client, request)));
  ws.on("connection", client => {
    socket = client;
    client.on("message", data => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "runtime.hello") client.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 }));
      if (frame.type === "run.event_batch") {
        for (const event of frame.payload.events) if (!events.some(previous => previous.event_id === event.event_id)) events.push(event);
        client.send(wire("event.ack", { run_id: frame.payload.run_id, received_through_seq: frame.payload.last_seq, durable_through_seq: frame.payload.last_seq }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await runtime?.close();
    for (const client of ws.clients) client.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  runtime = new AgentWorkRuntime({ profile: "default", baseUrl, token: "runtime-grant", runtimeName: "archive-fixture", storePath: join(directory, "runtime.db") }, {
    list: async () => [{ type: "codex", capabilities: [] }], cancel: async () => ({ cancelled: true }),
    async *invoke(_adapter, request) {
      assert.match(request.controlInstructions, /task-output-manifest/);
      const bytes = Buffer.from(`<title>${request.runId}</title>`);
      await writeFile(join(directory, `${request.runId}.html`), bytes);
      await writeFile(join(directory, taskOutputManifestPath(request.runId)), JSON.stringify({ schema: TASK_OUTPUT_SCHEMA, outputs: [{
        output_id: request.runId, relative_path: `${request.runId}.html`, name: `${request.runId}.html`, media_type: "text/html",
        size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), role: "output"
      }] }));
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    }
  });
  await runtime.start();
  await waitFor(() => socket?.readyState === 1);
  for (const number of [1, 2]) {
    const resource = { namespace: "octo.content", name: "resources", payload: { entries: [{
      resource_ref: "task:task-1/materials", resolver: "mcp", locator: { server_ref: "octo_task", tool: "task_get_materials" }, params: { task_id: "task-1", handler_epoch: 2 }
    }] } };
    const plan = { adapter_type: "codex", workdir: directory, approval_mode: "ask", mcp_servers: { octo_task: {
      type: "streamable_http", url: `${baseUrl}/mcp/team`, headers: { Authorization: "Bearer run-grant" }
    } } };
    socket.send(wire("runtime.command", { server_seq: number, command_id: `command-${number}`, run_id: `run-${number}`, type: "run.start", lease_id: `lease-${number}`, fencing_token: number,
      payload: { schema_version: 3, effective_context: executionContext(plan, [resource]), context_defaults_version: 1,
        resolved_execution_plan: plan, resolved_runtime_selection: resolvedRuntimeSelection(), run_id: `run-${number}`, agent_session_id: "conversation-1",
        agent_run_request: { context: contextEnvelope([resource]), namespace: "task", agent_id: "agent-1", agent_revision_id: "revision-1", session_key: "conversation-1",
          trigger: { kind: "message", occurrence_id: `message-${number}` }, input: { prompt: "生成页面" } }, agent_revision: {} } }));
    await waitFor(() => events.some(event => event.type === "run.completed" && event.run_id === `run-${number}`));
  }
  const saved = events.find(event => event.run_id === "run-1" && event.type === "run.completed");
  assert.equal(saved.payload.task_output_receipts[0].status, "saved");
  assert.equal(saved.payload.task_output_receipts[0].attachment_id, "attachment-run-1");
  assert.deepEqual(uploaded.map(upload => upload.body.toString()), ["<title>run-1</title>", "<title>run-2</title>"]);
  assert.deepEqual(commits, ["run-1"]);
  const failed = events.find(event => event.run_id === "run-2" && event.type === "run.completed");
  assert.equal(failed.payload.task_output_receipts[0].status, "failed");
  assert.equal(failed.payload.task_output_receipts[0].error_code, "TASK_OUTPUT_UPLOAD_FAILED");
  assert.ok(events.some(event => event.run_id === "run-2" && event.type === "run.notice"));
});

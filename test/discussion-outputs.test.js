import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { archiveDiscussionOutputs, DISCUSSION_OUTPUT_SCHEMA, discussionOutputManifestPath } from "../packages/octo-harness-daemon/dist/discussion-outputs.js";
import { TaskMcpClient } from "../packages/octo-harness-daemon/dist/task-materials.js";

test("trusted output errors retain only bounded business codes", async t => {
  let failure = "TASK_DRIVE_OWNER_MISMATCH";
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    response.setHeader("Content-Type", "application/json");
    if (rpc.method === "notifications/initialized") { response.writeHead(202); response.end(); return; }
    const result = rpc.method === "initialize" ? { protocolVersion: "2025-03-26" } : { isError: true, structuredContent: { error: { code: failure, detail: "private detail must not be retained" } } };
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new TaskMcpClient({ type: "streamable_http", url: `http://127.0.0.1:${server.address().port}/mcp` }, new AbortController().signal);
  await client.initialize();
  await assert.rejects(client.call("discussion_prepare_output", {}), /^TypeError: TASK_DRIVE_OWNER_MISMATCH$/);
  failure = "https://private.example/credential";
  await assert.rejects(client.call("discussion_prepare_output", {}), /^TypeError: TASK_MCP_TOOL_FAILED$/);
});

test("Discussion text-only result needs no manifest or business binding", async t => {
  const workdir = await mkdtemp(join(tmpdir(), "oh-discussion-text-"));
  t.after(() => rm(workdir, { recursive: true, force: true }));
  assert.deepEqual(await archiveDiscussionOutputs({ workdir }, "run-1", new AbortController().signal), []);
});

test("Discussion declared outputs require trusted business binding and use independent tools", async t => {
  const workdir = await mkdtemp(join(tmpdir(), "oh-discussion-file-"));
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const bytes = Buffer.from("shared output");
  const output = { output_id: "file", relative_path: "result.txt", name: "result.txt", media_type: "text/plain", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), role: "output" };
  await mkdir(join(workdir, ".octo/discussion-outputs"), { recursive: true });
  await writeFile(join(workdir, "result.txt"), bytes);
  await writeFile(join(workdir, discussionOutputManifestPath("run-1")), JSON.stringify({ schema: DISCUSSION_OUTPUT_SCHEMA, outputs: [output] }));
  await assert.rejects(archiveDiscussionOutputs({ workdir }, "run-1", new AbortController().signal), /BUSINESS_SERVICE_BINDING_REQUIRED/);
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === "/upload") {
      assert.equal(request.headers.authorization, undefined);
      assert.deepEqual(Buffer.concat(chunks), bytes);
      response.writeHead(200); response.end(); return;
    }
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    response.setHeader("Content-Type", "application/json");
    if (rpc.method === "notifications/initialized") { response.writeHead(202); response.end(); return; }
    let result = { protocolVersion: "2025-03-26" };
    if (rpc.method === "tools/call") {
      calls.push(rpc.params.name);
      assert.equal(rpc.params.arguments.task_id, undefined);
      assert.equal(rpc.params.arguments.discussion_id, undefined);
      assert.deepEqual(rpc.params.arguments.manifest, output);
      result = { structuredContent: rpc.params.name === "discussion_prepare_output"
        ? { ticket_id: "ticket", upload_url: `http://127.0.0.1:${server.address().port}/upload`, upload_method: "PUT" }
        : { status: "saved", attachment_id: "att", file_id: "42", file_version_id: `sha256:${output.sha256}` } };
    }
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const plan = { workdir, mcp_servers: { p_012345abcdef_octo_discussion: { type: "streamable_http", url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: "Bearer test-run-grant" } } } };
  const receipts = await archiveDiscussionOutputs({ workdir: plan.workdir }, "run-1", new AbortController().signal, plan.mcp_servers.p_012345abcdef_octo_discussion);
  assert.deepEqual(calls, ["discussion_prepare_output", "discussion_commit_output"]);
  assert.equal(receipts[0].status, "saved");
});

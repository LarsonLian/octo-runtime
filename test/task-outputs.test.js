import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { archiveTaskOutputs, assertTaskOutputManifest, loadTaskOutputs, readTaskOutput, TASK_OUTPUT_SCHEMA, taskOutputManifestPath } from "../packages/octo-harness-daemon/dist/task-outputs.js";

const bytes = Buffer.from("<!doctype html><title>活动页面</title>");
const entry = { output_id: "page-1", relative_path: "output/page.html", name: "活动.html", media_type: "text/html", size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"), role: "output" };

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), "oh-task-output-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "output"));
  await mkdir(join(directory, ".octo/task-outputs"), { recursive: true });
  await writeFile(join(directory, "output/page.html"), bytes);
  await writeFile(join(directory, taskOutputManifestPath("run-1")), JSON.stringify({ schema: TASK_OUTPUT_SCHEMA, outputs: [entry] }));
  return directory;
}

test("manifest requires stable IDs, bounded files, relative paths and exact checksum metadata", () => {
  assert.doesNotThrow(() => assertTaskOutputManifest({ schema: TASK_OUTPUT_SCHEMA, outputs: [entry] }));
  for (const relative_path of ["../outside", "/tmp/outside", "C:/outside", "output\\..\\outside", "output/../outside", "output//file", "./output/file", "output/\0file"]) {
    assert.throws(() => assertTaskOutputManifest({ schema: TASK_OUTPUT_SCHEMA, outputs: [{ ...entry, relative_path }] }), /TASK_OUTPUT_PATH_INVALID/);
  }
  for (const overrides of [{ size: -1 }, { size: 0 }, { size: 101 * 1024 * 1024 }, { sha256: "pretend" }, { name: "../credentials" }, { name: "a".repeat(201) }, { output_id: "../id" }, { role: "reference" }]) {
    assert.throws(() => assertTaskOutputManifest({ schema: TASK_OUTPUT_SCHEMA, outputs: [{ ...entry, ...overrides }] }), /TASK_OUTPUT_MANIFEST_INVALID/);
  }
  assert.throws(() => assertTaskOutputManifest({ schema: TASK_OUTPUT_SCHEMA, outputs: [entry, entry] }), /TASK_OUTPUT_MANIFEST_INVALID/);
});

test("text-only delivery supports review classification and rejects unknown verdicts", async t => {
  const directory = await workspace(t);
  const delivery = { output_kind: "code_review_report", review_verdict: "changes_requested" };
  await writeFile(join(directory, taskOutputManifestPath("run-1")), JSON.stringify({ schema: TASK_OUTPUT_SCHEMA, outputs: [], delivery }));
  let received;
  assert.deepEqual(await archiveTaskOutputs({ workdir: directory }, "task-1", "run-1", new AbortController().signal, value => { received = value; }), []);
  assert.deepEqual(received, delivery);
  for (const invalid of [{ output_kind: "unknown" }, { output_kind: "agent_report", review_verdict: "approved" }, { output_kind: "code_review_report", review_verdict: "unknown" }]) {
    assert.throws(() => assertTaskOutputManifest({ schema: TASK_OUTPUT_SCHEMA, outputs: [], delivery: invalid }), /TASK_OUTPUT_MANIFEST_INVALID/);
  }
});

test("Runtime rejects symlink paths and verifies real file bytes within its frozen directory", async t => {
  const directory = await workspace(t);
  assert.deepEqual(await loadTaskOutputs(directory, "run-1"), [entry]);
  assert.deepEqual(await readTaskOutput(directory, entry.relative_path, 1024), bytes);
  assert.deepEqual(await loadTaskOutputs(directory, "another-run"), []);
  await symlink(join(directory, "output/page.html"), join(directory, "output/link.html"));
  await assert.rejects(readTaskOutput(directory, "output/link.html", 1024), /TASK_OUTPUT_SYMLINK_REJECTED/);
  await symlink(join(directory, "output"), join(directory, "linked"));
  await assert.rejects(readTaskOutput(directory, "linked/page.html", 1024), /TASK_OUTPUT_SYMLINK_REJECTED/);
  await assert.rejects(readTaskOutput(directory, entry.relative_path, 1), /TASK_OUTPUT_SIZE_EXCEEDED/);
});

test("Runtime uploads actual bytes; a lost commit receipt and retries reuse durable saved references", async t => {
  const directory = await workspace(t);
  const calls = [];
  let uploads = 0;
  let saved = false;
  const receipt = { status: "saved", attachment_id: "att-1", file_id: "file-1", file_version_id: "fv-1" };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === "/storage/upload-ticket") {
      uploads += 1;
      assert.equal(request.method, "PUT");
      assert.equal(request.headers.authorization, undefined);
      assert.deepEqual(Buffer.concat(chunks), bytes);
      response.writeHead(200); response.end(); return;
    }
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(request.headers.authorization, "Bearer run-grant");
    calls.push(rpc);
    response.setHeader("Content-Type", "application/json");
    if (rpc.method === "notifications/initialized") { response.writeHead(202); response.end(); return; }
    let result;
    if (rpc.method === "initialize") result = { protocolVersion: "2025-03-26" };
    else if (rpc.params.name === "task_prepare_output") {
      assert.deepEqual(rpc.params.arguments, { task_id: "task-1", manifest: entry });
      result = { structuredContent: saved ? receipt : { ticket_id: "ticket-1", upload_url: `http://127.0.0.1:${server.address().port}/storage/upload-ticket`, upload_method: "PUT" } };
    } else if (rpc.params.name === "task_fail_output") {
      assert.equal(saved, true);
      result = { structuredContent: receipt };
    } else {
      assert.equal(rpc.params.name, "task_commit_output");
      assert.deepEqual(rpc.params.arguments, { task_id: "task-1", ticket_id: "ticket-1", manifest: entry });
      assert.equal(uploads, 1);
      saved = true;
      response.writeHead(503);
      response.end();
      return;
    }
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const plan = { workdir: directory, mcp_servers: { octo_task: { type: "streamable_http", url: `http://127.0.0.1:${server.address().port}/mcp/team`, headers: { Authorization: "Bearer run-grant" } } } };
  assert.deepEqual(await archiveTaskOutputs({ workdir: plan.workdir }, "task-1", "run-1", new AbortController().signal, undefined, plan.mcp_servers.octo_task), [{ output_id: "page-1", ...receipt }]);
  assert.deepEqual(await archiveTaskOutputs({ workdir: plan.workdir }, "task-1", "run-1", new AbortController().signal, undefined, plan.mcp_servers.octo_task), [{ output_id: "page-1", ...receipt }]);
  assert.equal(uploads, 1);
  assert.equal(calls.filter(call => call.method === "tools/call" && call.params.name === "task_commit_output").length, 1);
  await writeFile(join(directory, entry.relative_path), "changed after manifest");
  const failure = await archiveTaskOutputs({ workdir: plan.workdir }, "task-1", "run-1", new AbortController().signal, undefined, plan.mcp_servers.octo_task);
  assert.deepEqual(failure, [{ output_id: "page-1", status: "failed", error_code: "TASK_OUTPUT_INTEGRITY_MISMATCH" }]);
  assert.equal(uploads, 1);
});

test("upload failures never produce saved receipts or call commit", async t => {
  const directory = await workspace(t);
  const tools = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.method === "PUT") { response.writeHead(503); response.end("not saved"); return; }
    const rpc = JSON.parse(body);
    response.setHeader("Content-Type", "application/json");
    if (rpc.method === "notifications/initialized") { response.writeHead(202); response.end(); return; }
    let result = { protocolVersion: "2025-03-26" };
    if (rpc.method === "tools/call") {
      tools.push(rpc.params.name);
      result = { structuredContent: rpc.params.name === "task_fail_output" ? { status: "failed" } : { ticket_id: "ticket-1", upload_url: `http://127.0.0.1:${server.address().port}/upload`, upload_method: "PUT" } };
      if (rpc.params.name === "task_fail_output") assert.deepEqual(rpc.params.arguments, { task_id: "task-1", ticket_id: "ticket-1", output_id: "page-1", error_code: "TASK_OUTPUT_UPLOAD_FAILED" });
    }
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const plan = { workdir: directory, mcp_servers: { octo_task: { type: "streamable_http", url: `http://127.0.0.1:${server.address().port}/mcp/team` } } };
  assert.deepEqual(await archiveTaskOutputs({ workdir: plan.workdir }, "task-1", "run-1", new AbortController().signal, undefined, plan.mcp_servers.octo_task), [{ output_id: "page-1", status: "failed", error_code: "TASK_OUTPUT_UPLOAD_FAILED" }]);
  assert.deepEqual(tools, ["task_prepare_output", "task_fail_output"]);
});

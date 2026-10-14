import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareRunContext } from "../packages/octo-runtime-adapter-host/dist/index.js";
import { createOpenClawAdapter } from "../packages/octo-runtime-adapter-openclaw/dist/index.js";
import { AgentWorkStore } from "../packages/octo-runtime-worker-access/dist/agent-work-store.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "octo-context-preparation-"));
  const store = new AgentWorkStore();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const options = { workspaceRoot: join(root, "OctoWork"), stateRoot: root, agentSessionId: "session-1", agentId: "agent-1", store };
  const plan = { agent_source: "provisioned", adapter_type: "codex", workdir: "", approval_mode: "ask", workspace: { mode: "random" } };
  return { root, options, plan, prepare: (updates = {}) => prepareRunContext({ ...plan, ...updates }, options) };
}

test("random workspaces are reused; preparation never installs plugins", async t => {
  const f = await fixture(t);
  const first = await f.prepare();
  await writeFile(join(first.workdir, "retained.txt"), "retained");
  const second = await f.prepare();
  assert.equal(second.workdir, first.workdir);
  assert.equal(second.providerStateDir, first.providerStateDir);
  assert.equal(await readFile(join(second.workdir, "retained.txt"), "utf8"), "retained");
  const entries = await readdir(f.root);
  assert.ok(!entries.includes("resources") && !entries.includes("plugin-data"));
  assert.deepEqual(Object.keys(first).sort(), ["providerStateDir", "receipt", "workdir"]);
  assert.ok(!Object.hasOwn(first.receipt, "resources"));
  const another = await prepareRunContext(f.plan, { ...f.options, agentSessionId: "session-2" });
  assert.notEqual(another.workdir, first.workdir);
  await rm(first.workdir, { recursive: true });
  await assert.rejects(f.prepare(), /ENOENT/);
});

test("removed package and MCP configuration fails before workspace side effects", async t => {
  const f = await fixture(t);
  for (const input of [{ resources: [] }, { resources: [{ files: {} }] }, { mcp_servers: {} }]) await assert.rejects(f.prepare(input), /CONTEXT_SCHEMA_INVALID/);
  assert.ok(!(await readdir(f.root)).includes("OctoWork"));
});

test("fixed workspaces preserve user-managed runtime files", async t => {
  const f = await fixture(t);
  const config = join(f.root, "mcp.json");
  await writeFile(config, '{"user":"configured"}');
  await f.prepare({ workdir: f.root, workspace: { mode: "fixed", path: f.root } });
  assert.equal(await readFile(config, "utf8"), '{"user":"configured"}');
});

test("OpenClaw workspace declaration skips fixed and random directory preparation", async t => {
  const f = await fixture(t);
  const adapter = createOpenClawAdapter();
  assert.equal(adapter.metadata.workspace, false);
  const before = await readdir(f.root);
  for (const agent_source of ["preset", "provisioned"]) {
    for (const workspace of [{ mode: "fixed", path: join(f.root, "missing-non-git") }, { mode: "random" }]) {
      const plan = { ...f.plan, agent_source, adapter_type: "openclaw", provider_agent_id: "main", workspace, workdir: workspace.path ?? "" };
      const prepared = await prepareRunContext(plan, {
        ...f.options,
        stateRoot: join(f.root, "unused-state"),
        workspace: adapter.metadata.workspace,
        store: { conversationWorkspace() { assert.fail("OpenClaw must not allocate a workspace"); } }
      });
      assert.equal(prepared.workdir, plan.workdir);
      assert.equal(prepared.providerStateDir, "");
      assert.deepEqual(prepared.receipt, {
        workspace_mode: "none", workspace_path: "", provider_state_dir: "", warnings: ["CONTEXT_WORKSPACE_IGNORED"]
      });
      assert.deepEqual(await readdir(f.root), before);
    }
  }
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareRunContext } from "../packages/octo-harness-daemon/dist/context-preparation.js";
import { AgentWorkStore } from "../packages/octo-harness-daemon/dist/agent-work-store.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "octo-context-preparation-"));
  const store = AgentWorkStore.open(join(root, "runtime.db"));
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

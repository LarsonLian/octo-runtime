import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { prepareRunContext, resourceFilesDigest } from "../packages/octo-harness-daemon/dist/context-preparation.js";
import { AgentWorkStore } from "../packages/octo-harness-daemon/dist/agent-work-store.js";

const skill = "---\nname: context-proof\ndescription: Verify selected Context resources.\n---\nUse the selected tools.\n";
const resource = (texts, extra = {}) => {
  const files = Object.fromEntries(Object.entries(texts).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, text]) => [path, { content_base64: Buffer.from(text).toString("base64"), executable: false }]));
  return { resource_id: "ae67cb3e-0d16-4bb2-9a4e-bb563cb707af", revision: 1, kind: "agent_plugin", invoke: true,
    digest: "sha256:" + createHash("sha256").update(JSON.stringify(files)).digest("hex"), files, sources: ["agent_mandatory"], ...extra };
};
const plugin = () => ({
  "plugin.json": JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "context-proof", version: "1.0.0" }),
  "skills/context-proof/SKILL.md": skill,
  "mcp.json": JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {
    local: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.mjs", "${UNKNOWN}"], cwd: "${PLUGIN_DATA}" },
  } }),
  "server.mjs": "console.log('fixture');\n",
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "octo-context-preparation-"));
  const store = AgentWorkStore.open(join(root, "runtime.db"));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const options = { stateRoot: root, agentSessionId: "session-1", agentId: "agent-1", store };
  const plan = { agent_source: "provisioned", adapter_type: "codex", workdir: "", approval_mode: "ask", workspace: { mode: "random" } };
  return { root, options, plan, prepare: (resources = [], updates = {}) => prepareRunContext({ ...plan, resources, ...updates }, options) };
}

test("random workspaces and provider state are created once per AgentSession; missing workspaces fail", async t => {
  const f = await fixture(t);
  const first = await f.prepare();
  await writeFile(join(first.workdir, "retained.txt"), "retained");
  const second = await f.prepare();
  assert.equal(second.workdir, first.workdir);
  assert.equal(second.providerStateDir, first.providerStateDir);
  assert.equal(await readFile(join(second.workdir, "retained.txt"), "utf8"), "retained");
  const anotherSession = await prepareRunContext(f.plan, { ...f.options, agentSessionId: "session-2" });
  assert.notEqual(anotherSession.workdir, first.workdir);
  assert.notEqual(anotherSession.providerStateDir, first.providerStateDir);
  await rm(first.workdir, { recursive: true });
  await assert.rejects(f.prepare(), /ENOENT/);
});

test("portable plugin preparation mounts native skill roots and per-plugin MCP root/data", async t => {
  const f = await fixture(t);
  const prepared = await f.prepare([resource(plugin())]);
  assert.deepEqual(prepared.skills.map(item => ({ name: item.name, invoke: item.invoke })), [{ name: "context-proof", invoke: true }]);
  assert.equal(prepared.skillRoots[0], dirname(dirname(prepared.skills[0].path)));
  const server = Object.values(prepared.mcpServers)[0];
  assert.equal(server.type, "stdio");
  assert.equal(server.cwd, server.env.PLUGIN_DATA);
  assert.equal(server.args[0], join(server.env.PLUGIN_ROOT, "server.mjs"));
  assert.equal(server.args[1], "${UNKNOWN}");
  assert.deepEqual(prepared.receipt.resources[0].components, ["skill:context-proof", "mcp:local"]);
});

test("same plugin installation retains data across immutable package versions", async t => {
  const f = await fixture(t);
  const first = await f.prepare([resource(plugin())]);
  const files = plugin();
  files["plugin.json"] = JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "context-proof", version: "2.0.0" });
  const second = await f.prepare([resource(files, { revision: 2 })]);
  assert.equal(second.receipt.resources[0].data, first.receipt.resources[0].data);
  assert.notEqual(second.receipt.resources[0].root, first.receipt.resources[0].root);
});

test("component selections exclude unselected skills and MCP servers", async t => {
  const f = await fixture(t);
  const selected = await f.prepare([resource(plugin(), { components: ["skill:context-proof"] })]);
  assert.deepEqual(selected.mcpServers, {});
  await assert.rejects(f.prepare([resource(plugin(), { components: ["skill:missing"] })]), /CONTEXT_COMPONENT_UNAVAILABLE|CONTEXT_RESOURCE_UNAVAILABLE/);
});

test("corrupt cached packages and invalid frontmatter cannot become prepared skills", async t => {
  const f = await fixture(t);
  const files = plugin();
  const first = await f.prepare([resource(files)]);
  const path = first.skills[0].path;
  await chmod(path, 0o700);
  await writeFile(path, "changed");
  await assert.rejects(f.prepare([resource(files)]), /CONTEXT_RESOURCE_DIGEST_MISMATCH/);
  await assert.rejects(f.prepare([resource({ "SKILL.md": "---\nname: context-proof\nname: duplicate\ndescription: test\n---\n" }, { kind: "skill" })]), /SKILL_FRONTMATTER_INVALID|CONTEXT_SKILL_UNAVAILABLE/);
});

test("unsupported MCP transports and package credentials fail explicitly", async t => {
  const f = await fixture(t);
  for (const server of [{ type: "sse", url: "https://example.test/mcp" }, { type: "streamable-http", url: "https://example.test/mcp", headers: { Authorization: "secret" } }]) {
    const files = plugin();
    files["mcp.json"] = JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { local: server } });
    await assert.rejects(f.prepare([resource(files)]), /CONTEXT_COMPONENT_UNAVAILABLE/);
  }
});

test("binary files and executable flags survive FileBundle materialization", async t => {
  const { stat } = await import("node:fs/promises");
  const f = await fixture(t);
  const value = resource({ "SKILL.md": skill, "assets/data.bin": Buffer.from([0, 255, 128, 10]), "scripts/check.sh": "#!/bin/sh\nexit 0\n" }, { kind: "skill" });
  value.files["scripts/check.sh"].executable = true;
  value.digest = "sha256:" + createHash("sha256").update(JSON.stringify(value.files)).digest("hex");
  const prepared = await f.prepare([value]);
  const root = prepared.receipt.resources[0].root;
  assert.deepEqual(await readFile(join(root, "assets/data.bin")), Buffer.from([0, 255, 128, 10]));
  assert.equal((await stat(join(root, "scripts/check.sh"))).mode & 0o777, 0o500);
  assert.equal((await stat(join(root, "SKILL.md"))).mode & 0o777, 0o400);
  assert.equal(prepared.receipt.resources[0].revision, 1);
});

test("manifest version is optional metadata and independent of resource revision", async t => {
  const f = await fixture(t);
  const files = plugin();
  files["plugin.json"] = JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "context-proof" });
  await assert.doesNotReject(f.prepare([resource(files, { revision: 9 })]));
  await assert.rejects(f.prepare([resource({ "AGENTS.md": "expert only" })]));
});

test("path escapes and file/directory conflicts never publish a resource", async t => {
  const f = await fixture(t);
  for (const path of ["../escape", "/tmp/escape", "a\\b", "a//b", "./x"])
    await assert.rejects(f.prepare([resource({ "SKILL.md": skill, [path]: "bad" }, { kind: "skill" })]), /CONTEXT_RESOURCE_INVALID/);
  await assert.rejects(f.prepare([resource({ "SKILL.md": skill, "a": "file", "a/b": "nested" }, { kind: "skill" })]));
});


test("resolved byte digest matches shared Go/TS canonical fixtures", async () => {
  const fixtures = JSON.parse(await readFile(new URL("../packages/octo-harness-protocol/schema/file-bundle-resolved-fixtures.json", import.meta.url), "utf8"));
  for (const fixture of fixtures) assert.equal(resourceFilesDigest(fixture.files), fixture.digest, fixture.name);
});

test("resource resolution sends only the active Run lease and validates the frozen response", async t => {
  const { createServer } = await import("node:http");
  const { resolveRunResources } = await import("../packages/octo-harness-daemon/dist/context-preparation.js");
  const values = [resource(plugin())];
  let supplied;
  const server = createServer(async (request, response) => {
    supplied = { path: request.url, body: JSON.parse(await Array.fromAsync(request).then(chunks => Buffer.concat(chunks).toString())) };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: { resources: values } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const resolved = await resolveRunResources({ baseUrl: `http://127.0.0.1:${server.address().port}`, headers: {}, runId: "run-1", leaseId: "lease-1", fencingToken: 9, signal: new AbortController().signal });
  assert.deepEqual(supplied, { path: "/v1/runtime/context/resources/resolve", body: { run_id: "run-1", lease_id: "lease-1", fencing_token: 9 } });
  assert.deepEqual(resolved, values);
});

test("knowledge FileBundle exposes the full immutable tree without executing skill or MCP entries", async t => {
  const f = await fixture(t);
  const texts = { "facts/a.txt": "evidence", "skills/x/SKILL.md": "not a native skill", "mcp.json": "not executable config" };
  const knowledge = resource(texts, { kind: "knowledge", invoke: false });
  const prepared = await f.prepare([knowledge]);
  assert.deepEqual(prepared.skills, []);
  assert.deepEqual(prepared.mcpServers, {});
  assert.deepEqual(prepared.knowledge[0].files, Object.keys(texts).sort());
  assert.equal(await readFile(join(prepared.knowledge[0].root, "facts/a.txt"), "utf8"), "evidence");
  assert.deepEqual(prepared.receipt.resources[0].components, ["knowledge:files"]);
  await assert.rejects(f.prepare([{ ...knowledge, invoke: true }]), /KNOWLEDGE_SELECTION_INVALID/);
});

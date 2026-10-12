import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeAgentPluginMcpConfig as normalize, normalizeAgentPluginMcpServer as server } from "../packages/octo-harness-adapter-sdk/dist/index.js";

test("agent-plugin HTTP forms normalize once, preserving credential and millisecond timeout", () => {
  for (const type of [undefined, "http", "streamableHttp", "streamable-http", "streamable_http"]) {
    const input = { url: "http://127.0.0.1:8396/mcp/drive", type, staticHeaders: { "X-Space-ID": "space" }, headers: { Token: "private-token" }, timeout: 30000 };
    if (type === undefined) delete input.type;
    assert.deepEqual(normalize({ mcpServers: { octo_drive: input } }), {
      octo_drive: { type: "streamable_http", url: input.url, headers: { "X-Space-ID": "space", Token: "private-token" }, toolTimeoutMs: 30000 }
    });
  }
});
test("disabled connectors do not validate launch settings or produce connections", () => {
  assert.deepEqual(normalize({ mcpServers: { "connector:inactive": { disabled: true, type: "sse", runtime: "unsupported" } } }), {});
});
test("unsupported security policies and ambiguous credentials fail without leaking secrets", () => {
  const cases = [
    { type: "sse", url: "https://example.org" },
    { url: "https://example.org", disabledTools: ["delete"] },
    { url: "https://example.org", staticHeaders: { Token: "secret" }, headers: { token: "secret" } },
    { url: "https://example.org", headers: { Token: "secret\r\nX-Override: yes" } },
    { url: "https://example.org", timeout: 30000, toolTimeoutMs: 30000 },
    { url: "https://example.org", timeout: 86400000 },
    { url: "https://example.org", command: "node" },
    { command: "node", runtime: "npm" }
  ];
  for (const input of cases) assert.throws(() => server(input), error => error instanceof TypeError && !error.message.includes("secret"));
  assert.throws(() => normalize({ mcpServers: { "connector:active": { command: "node" } } }), /MCP_NAME_UNSUPPORTED/);
});
test("stdio maps merge explicitly and canonical configuration is idempotent", () => {
  const input = { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {
    local: { type: "stdio", command: "node", args: ["server.js"], staticEnv: { A: "a" }, env: { B: "b" }, startupTimeoutMs: 1000, required: true }
  } };
  const normalized = normalize(input);
  assert.deepEqual(normalize({ mcpServers: normalized }), normalized);
  assert.deepEqual(normalized.local.env, { A: "a", B: "b" });
});
test("local Workbuddy document can be inspected without contacting any connector", async t => {
  let content;
  try { content = await readFile(join(homedir(), ".workbuddy/connectors/default/mcp.json"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return t.skip("Workbuddy not installed"); throw error; }
  const document = JSON.parse(content);
  // Active external services remain opt-in; this test never invokes them.
  const disabled = Object.fromEntries(Object.entries(document.mcpServers).filter(([, entry]) => entry.disabled === true));
  assert.deepEqual(normalize({ mcpServers: disabled }), {});
});

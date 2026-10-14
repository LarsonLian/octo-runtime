import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";

test("stdio echo MCP server lists and calls its deterministic tool", async t => {
  const server = spawn(process.execPath, ["test-support/mcp/echo-server.mjs"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(() => server.kill());
  const output = createInterface({ input: server.stdout, crlfDelay: Infinity });
  const responses = [];
  output.on("line", line => responses.push(JSON.parse(line)));

  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "octo_echo", arguments: { value: "integration-ok" } } })}\n`);

  await waitFor(() => responses.length === 3);
  assert.equal(responses[0].result.serverInfo.name, "octo-runtime-echo");
  assert.equal(responses[1].result.tools[0].name, "octo_echo");
  assert.equal(responses[2].result.content[0].text, "octo-echo:integration-ok");

  server.stdin.end();
  await once(server, "exit");
  assert.equal(server.exitCode, 0);
});

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for MCP responses");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

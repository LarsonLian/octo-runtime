import assert from "node:assert/strict";
import test from "node:test";

import { assertInvokeRequest, assertMcpServers, capabilities } from "@mininglamp-oss/octo-harness-protocol";

const baseRequest = {
  invocationId: "invoke-1",
  agentSessionId: "session-1",
  runId: "run-1",
  prompt: "work",
  workdir: "/workspace",
  appendInstructions: "",
  context: {},
  agentConfig: {}
};

test("dynamic MCP contract accepts stdio and Streamable HTTP servers", () => {
  const mcpServers = {
    local: {
      type: "stdio",
      command: "node",
      args: ["server.mjs"],
      env: { MODE: "test" },
      cwd: "/workspace",
      required: true,
      startupTimeoutMs: 10_000,
      toolTimeoutMs: 60_000
    },
    remote: {
      type: "streamable_http",
      url: "https://mcp.example.test/rpc",
      headers: { Authorization: "Bearer run-scoped-value" }
    }
  };

  assert.doesNotThrow(() => assertMcpServers(mcpServers));
  assert.doesNotThrow(() => assertInvokeRequest({ ...baseRequest, mcpServers }));
  assert.equal(capabilities.MCP_DYNAMIC, "tool.mcp.dynamic");
});

test("dynamic MCP contract rejects unknown transports, fields, names, and malformed URLs", () => {
  const invalid = [
    { bad: { type: "sse", url: "https://mcp.example.test" } },
    { bad: { type: "stdio", command: "node", token: "must-not-pass" } },
    { "bad/name": { type: "stdio", command: "node" } },
    { bad: { type: "streamable_http", url: "file:///tmp/socket" } },
    { bad: { type: "streamable_http", url: "not-a-url" } },
    { bad: { type: "stdio", command: "" } },
    { bad: { type: "stdio", command: "node", args: ["ok", 1] } }
  ];

  for (const value of invalid) assert.throws(() => assertMcpServers(value), TypeError);
});

test("InvokeRequest remains backward compatible when dynamic MCP is absent", () => {
  assert.doesNotThrow(() => assertInvokeRequest(baseRequest));
});

import assert from "node:assert/strict";
import test from "node:test";

import { assertInvokeRequest, assertMcpServers, executionFeatures } from "@mininglamp-oss/octo-harness-protocol";

const baseRequest = { protocolVersion: 2,
  invocationId: "invoke-1",
  agentSessionId: "session-1",
  runId: "run-1",
  prompt: "work",
  modelInput: "work",
  workdir: "/workspace",
  controlInstructions: "",
  context: { schema: "octo.context-envelope/v3", items: [] },
  approvalMode: "full_access",
  agentSource: "provisioned", agentConfig: {}
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
  assert.equal(executionFeatures.MCP_DYNAMIC, "tool.mcp.dynamic");
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

test("InvokeRequest accepts the mandatory new contract when dynamic MCP is absent", () => {
  assert.doesNotThrow(() => assertInvokeRequest(baseRequest));
});

test("InvokeRequest without dynamic MCP rejects legacy contracts and missing mandatory inputs", () => {
  assert.throws(() => assertInvokeRequest({ ...baseRequest, appendInstructions: "" }), /LEGACY_RUN_CONTRACT_REJECTED/);
  assert.throws(() => assertInvokeRequest({ ...baseRequest, context: {} }), /CONTEXT_SCHEMA_INVALID/);
  for (const [field, reason] of [
    ["context", /CONTEXT_REQUIRED/],
    ["modelInput", /modelInput must be a non-empty string/],
    ["controlInstructions", /controlInstructions must be a string/],
    ["approvalMode", /APPROVAL_MODE_UNSUPPORTED/]
  ]) {
    const incomplete = { ...baseRequest };
    delete incomplete[field];
    assert.throws(() => assertInvokeRequest(incomplete), reason);
  }
});

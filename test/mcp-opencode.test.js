import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenCodeCommand,
  createOpenCodeAdapter,
  openCodeMcpConfig
} from "@mininglamp-oss/octo-harness-adapter-opencode";
import { executionFeatures } from "@mininglamp-oss/octo-harness-protocol";

const mcpServers = {
  team: {
    type: "streamable_http",
    url: "https://worker.example.test/mcp/team",
    headers: { Authorization: "Bearer run-scoped" },
    toolTimeoutMs: 120_000
  },
  local: {
    type: "stdio",
    command: "node",
    args: ["server.mjs"],
    env: { LOCAL_TOKEN: "local-secret" },
    cwd: process.cwd()
  }
};

test("OpenCode converts canonical MCP servers to native local and remote config", () => {
  assert.deepEqual(openCodeMcpConfig(mcpServers), {
    team: {
      type: "remote",
      url: "https://worker.example.test/mcp/team",
      headers: { Authorization: "Bearer run-scoped" },
      oauth: false,
      enabled: true,
      timeout: 120_000
    },
    local: {
      type: "local",
      command: ["node", "server.mjs"],
      cwd: process.cwd(),
      environment: { LOCAL_TOKEN: "local-secret" },
      enabled: true
    }
  });
});

test("OpenCode merges MCP into the child config and redacts provider observation", async () => {
  const previous = process.env.OPENCODE_CONFIG_CONTENT;
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    instructions: ["existing.md"],
    mcp: { existing: { type: "remote", url: "https://existing.example.test", headers: { Existing: "secret" } } }
  });
  try {
    const command = await buildOpenCodeCommand({ protocolVersion: 2,
      invocationId: "invoke-mcp",
      agentSessionId: "session-mcp",
      runId: "run-mcp",
      prompt: "call the tool",
      modelInput: "call the tool",
      workdir: process.cwd(),
      controlInstructions: "control",
      context: { schema: "octo.context-envelope/v1", items: [] },
      approvalMode: "full_access",
      agentSource: "provisioned", agentConfig: {},
      mcpServers
    }, "opencode-test");
    const actual = JSON.parse(command.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(actual.mcp.team.headers.Authorization, "Bearer run-scoped");
    assert.equal(actual.mcp.local.environment.LOCAL_TOKEN, "local-secret");
    assert.equal(actual.mcp.existing.headers.Existing, "secret");
    const observed = command.providerInput.content.inline_config;
    assert.equal(observed.mcp.team.headers.Authorization, "[REDACTED]");
    assert.equal(observed.mcp.local.environment.LOCAL_TOKEN, "[REDACTED]");
    assert.equal(observed.mcp.existing.headers.Existing, "[REDACTED]");
    await command.cleanup();
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
    else process.env.OPENCODE_CONFIG_CONTENT = previous;
  }
});

test("OpenCode advertises dynamic MCP support", () => {
  assert.ok(createOpenCodeAdapter({ command: "opencode-test" }).metadata.executionFeatures.includes(executionFeatures.MCP_DYNAMIC));
});

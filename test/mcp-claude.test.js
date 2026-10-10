import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";

import { buildClaudeCommand, createClaudeCodeAdapter } from "@mininglamp-oss/octo-harness-adapter-claude-code";
import { executionFeatures } from "@mininglamp-oss/octo-harness-protocol";

const request = { protocolVersion: 2,
  invocationId: "invoke-mcp",
  agentSessionKey: "session-mcp",
  runKey: "run-mcp",
  prompt: "call the tool",
  modelInput: "call the tool",
  workdir: process.cwd(),
  controlInstructions: "use the team tool",
  context: { schema: "octo.context-envelope/v3", items: [] },
  approvalMode: "full_access",
  agentSource: "provisioned", agentConfig: {},
  mcpServers: {
    team: {
      type: "streamable_http",
      url: "https://worker.example.test/mcp/team",
      headers: { Authorization: "Bearer run-scoped" }
    },
    local: {
      type: "stdio",
      command: "node",
      args: ["server.mjs"],
      env: { MODE: "test" },
      cwd: process.cwd()
    }
  }
};

test("Claude Code materializes a private strict per-invocation MCP config", async () => {
  const command = await buildClaudeCommand(request, "claude-test");
  const flag = command.args.indexOf("--mcp-config");
  assert.notEqual(flag, -1);
  assert.equal(command.args[flag + 2], "--strict-mcp-config");
  const file = command.args[flag + 1];
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    mcpServers: {
      team: {
        type: "http",
        url: "https://worker.example.test/mcp/team",
        headers: { Authorization: "Bearer run-scoped" }
      },
      local: {
        type: "stdio",
        command: "node",
        args: ["server.mjs"],
        env: { MODE: "test" },
        cwd: process.cwd()
      }
    }
  });
  assert.doesNotMatch(JSON.stringify(command.providerInput), /run-scoped/);

  await command.cleanup();
  await assert.rejects(access(file));
});

test("Claude Code advertises dynamic MCP only when the adapter implements it", () => {
  const adapter = createClaudeCodeAdapter({ command: "claude-test" });
  assert.ok(adapter.metadata.executionFeatures.includes(executionFeatures.MCP_DYNAMIC));
});

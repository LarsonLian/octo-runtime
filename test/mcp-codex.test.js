import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCodexCommand,
  codexMcpOverrides,
  createCodexAdapter
} from "@mininglamp-oss/octo-harness-adapter-codex";
import { capabilities } from "@mininglamp-oss/octo-harness-protocol";

const request = {
  invocationId: "invoke-mcp",
  agentSessionId: "session-mcp",
  runId: "run-mcp",
  prompt: "call the tool",
  workdir: process.cwd(),
  appendInstructions: "use the team tool",
  context: {},
  agentConfig: {},
  mcpServers: {
    "team.api": {
      type: "streamable_http",
      url: "https://worker.example.test/mcp/team",
      headers: { Authorization: "Bearer run-scoped", "X-Octo-Run": "run-mcp" },
      required: true,
      startupTimeoutMs: 10_000,
      toolTimeoutMs: 120_000
    },
    local: {
      type: "stdio",
      command: "node",
      args: ["server.mjs"],
      env: { LOCAL_MCP_TOKEN: "local-secret" },
      cwd: process.cwd()
    }
  }
};

test("Codex builds process-local MCP overrides and keeps secrets out of argv", () => {
  const result = codexMcpOverrides(request.mcpServers, {});
  const argv = JSON.stringify(result.args);
  assert.match(argv, /mcp_servers=/);
  assert.match(argv, /team\.api/);
  assert.match(argv, /env_http_headers/);
  assert.match(argv, /Authorization/);
  assert.match(argv, /startup_timeout_sec/);
  assert.match(argv, /tool_timeout_sec/);
  assert.match(argv, /env_vars/);
  assert.doesNotMatch(argv, /run-scoped|local-secret/);
  assert.equal(result.env.OCTO_HARNESS_MCP_0_HEADER_0, "Bearer run-scoped");
  assert.equal(result.env.LOCAL_MCP_TOKEN, "local-secret");
});

test("Codex rejects ambiguous stdio environment forwarding", () => {
  assert.throws(() => codexMcpOverrides({
    one: { type: "stdio", command: "one", env: { TOKEN: "one" } },
    two: { type: "stdio", command: "two", env: { TOKEN: "two" } }
  }), /conflicting values/);
});

test("Codex preserves the real home and does not rewrite config.toml", async () => {
  const home = await mkdtemp(join(tmpdir(), "octo-codex-mcp-"));
  const configFile = join(home, "config.toml");
  const original = "model = \"existing\"\n";
  await writeFile(configFile, original, { mode: 0o600 });
  try {
    const command = buildCodexCommand(request, "codex-test", ["app-server", "--listen", "stdio://"], {
      CODEX_HOME: home,
      PATH: process.env.PATH
    });
    assert.equal(command.env.CODEX_HOME, home);
    assert.equal(await readFile(configFile, "utf8"), original);
    assert.doesNotMatch(JSON.stringify(command.args), /run-scoped|local-secret/);
    assert.equal(command.env.OCTO_HARNESS_MCP_0_HEADER_0, "Bearer run-scoped");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Codex advertises dynamic MCP support", () => {
  const adapter = createCodexAdapter({ command: "codex-test", env: {} });
  assert.ok(adapter.metadata.capabilities.includes(capabilities.MCP_DYNAMIC));
});

test("Codex routes untrusted MCP approval through the non-interactive responder", async () => {
  const adapter = createCodexAdapter({
    command: process.execPath,
    appServerArgs: [fileURLToPath(new URL("../test-support/fake-codex-mcp-approval.mjs", import.meta.url))]
  });
  const events = [];

  for await (const event of adapter.invoke({
    ...request,
    mcpServers: undefined
  })) {
    events.push(event);
  }

  assert.equal(events.at(-1)?.type, "run.finished");
  assert.ok(events.some(event => event.type === "tool_call.update"
    && event.payload.status === "completed"));
});

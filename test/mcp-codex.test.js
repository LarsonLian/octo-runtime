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
import { capabilities, contextHash } from "@mininglamp-oss/octo-harness-protocol";
import { codexAppServerFixture } from "./agent-work-runtime-fixture.js";

const request = { protocolVersion: 2,
  invocationId: "invoke-mcp",
  agentSessionId: "session-mcp",
  runId: "run-mcp",
  prompt: "call the tool",
  modelInput: "call the tool",
  workdir: process.cwd(),
  controlInstructions: "use the team tool",
  context: { schema: "octo.context-envelope/v1", items: [] },
  approvalMode: "full_access",
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
  assert.ok(adapter.metadata.capabilities.includes(capabilities.INTERACTION_RESPONSE));
});

test("Codex full_access routes untrusted MCP approval through an audited automatic responder", { timeout: 5_000 }, async () => {
  const adapter = createCodexAdapter({
    command: process.execPath,
    appServerArgs: [fileURLToPath(new URL("../test-support/fake-codex-mcp-approval.mjs", import.meta.url))]
  });
  const events = [];

  for await (const event of adapter.invoke({
    ...request,
    mcpServers: undefined,
    signal: AbortSignal.timeout(4_000)
  })) {
    events.push(event);
  }

  assert.equal(events.at(-1)?.type, "run.completed");
  assert.ok(events.some(event => event.type === "tool_call.update"
    && event.payload.status === "completed"));
  const interactions = events.filter(event => event.type.startsWith("interaction."));
  assert.deepEqual(interactions.map(event => event.type), ["interaction.requested", "interaction.resolved"]);
  assert.equal(interactions[0].payload.kind, "approval");
  assert.equal(interactions[0].payload.request.schema, "octo.approval-request/v1");
  assert.deepEqual(interactions[0].payload.request.policy, { mode: "full_access", hash: contextHash(request.context) });
  assert.equal(interactions[0].payload.request.grantScope, "request");
  assert.deepEqual(interactions[1].payload, {
    interactionId: interactions[0].payload.interactionId,
    executionInstanceId: request.invocationId,
    status: "resolved",
    outcome: "accepted",
    reasonCode: "full_access_policy"
  });
  assert.ok(events.indexOf(interactions[1]) < events.findIndex(event => event.type === "tool_call.update"));
});

test("Codex ask routes durable interaction responses back to native app-server requests", { timeout: 5_000 }, async () => {
  const adapter = createCodexAdapter({
    command: process.execPath,
    appServerArgs: [fileURLToPath(new URL("../test-support/fake-codex-interaction.mjs", import.meta.url))]
  });
  const invocationId = "invoke-interaction";
  const events = [];

  for await (const event of adapter.invoke({
    ...request,
    invocationId,
    runId: "run-interaction",
    agentSessionId: "session-interaction",
    mcpServers: undefined,
    approvalMode: "ask",
    signal: AbortSignal.timeout(4_000)
  })) {
    events.push(event);
    if (event.type !== "interaction.requested") continue;

    await assert.rejects(
      adapter.respondInteraction("other-invocation", {
        interactionId: event.payload.interactionId,
        outcome: "accepted"
      }),
      /no active Codex interaction invocation/
    );
    await assert.rejects(
      adapter.respondInteraction(invocationId, {
        interactionId: "missing-interaction",
        outcome: "accepted"
      }),
      /unknown codex interaction/
    );

    if (event.payload.kind === "approval") {
      assert.equal(event.payload.request.schema, "octo.approval-request/v1");
      assert.equal(event.payload.request.policy.mode, "ask");
      assert.equal(event.payload.request.policy.hash, contextHash(request.context));
      assert.equal(event.payload.request.operation.summary, "pnpm add example");
      assert.equal(event.payload.request.grantScope, "request");
      await adapter.respondInteraction(invocationId, {
        interactionId: event.payload.interactionId,
        outcome: "accepted"
      });
    } else if (event.payload.kind === "elicitation") {
      assert.equal(event.payload.request.title, "Verify account");
      assert.doesNotMatch(JSON.stringify(event.payload.request), /provider-secret|challenge|_meta/);
      await adapter.respondInteraction(invocationId, {
        interactionId: event.payload.interactionId,
        outcome: "answered",
        value: { account: "verified" }
      });
    } else {
      assert.equal(event.payload.request.questions[0].id, "language");
      await adapter.respondInteraction(invocationId, {
        interactionId: event.payload.interactionId,
        outcome: "answered",
        value: { language: "TypeScript" }
      });
    }

    await assert.rejects(
      adapter.respondInteraction(invocationId, {
        interactionId: event.payload.interactionId,
        outcome: "accepted"
      }),
      /unknown codex interaction/
    );
  }

  assert.deepEqual(events.filter(event => event.type === "interaction.requested").map(event => event.payload.kind), [
    "approval",
    "elicitation",
    "question"
  ]);
  const requested = events.filter(event => event.type === "interaction.requested");
  const resolved = events.filter(event => event.type === "interaction.resolved");
  assert.deepEqual(resolved.map(event => event.payload), requested.map((event, index) => ({
    interactionId: event.payload.interactionId,
    executionInstanceId: invocationId,
    status: "resolved",
    outcome: index === 0 ? "accepted" : "answered"
  })));
  assert.equal(events.at(-1)?.type, "run.completed");
  await assert.rejects(
    adapter.respondInteraction(invocationId, {
      interactionId: "after-terminal",
      outcome: "accepted"
    }),
    /no active Codex interaction invocation/
  );
});

test("Codex full_access still requires explicit answers for MCP elicitation and questions", { timeout: 5_000 }, async () => {
  const adapter = createCodexAdapter({
    command: process.execPath,
    appServerArgs: [fileURLToPath(new URL("../test-support/fake-codex-interaction.mjs", import.meta.url))]
  });
  const events = [];
  for await (const event of adapter.invoke({ ...request, mcpServers: undefined, signal: AbortSignal.timeout(4_000) })) {
    events.push(event);
    if (event.type !== "interaction.requested") continue;
    if (event.payload.kind === "approval") {
      assert.equal(event.payload.request.policy.mode, "full_access");
      continue;
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.some(previous => previous.type === "interaction.resolved"
      && previous.payload.interactionId === event.payload.interactionId), false);
    if (event.payload.kind === "elicitation") {
      assert.equal(event.payload.request.title, "Verify account");
      assert.doesNotMatch(JSON.stringify(event.payload.request), /provider-secret|challenge|_meta/);
      await adapter.respondInteraction(request.invocationId, {
        interactionId: event.payload.interactionId, outcome: "answered", value: { account: "verified" }
      });
    } else {
      assert.equal(event.payload.kind, "question");
      await adapter.respondInteraction(request.invocationId, {
        interactionId: event.payload.interactionId, outcome: "answered", value: { language: "TypeScript" }
      });
    }
  }
  const requested = events.filter(event => event.type === "interaction.requested");
  const resolved = events.filter(event => event.type === "interaction.resolved");
  assert.deepEqual(requested.map(event => event.payload.kind), ["approval", "elicitation", "question"]);
  assert.deepEqual(resolved.map(event => event.payload), requested.map((event, index) => ({
    interactionId: event.payload.interactionId,
    executionInstanceId: request.invocationId,
    status: "resolved",
    outcome: index === 0 ? "accepted" : "answered",
    ...(index === 0 ? { reasonCode: "full_access_policy" } : {})
  })));
  assert.equal(events.at(-1).type, "run.completed");
});

for (const approvalMode of ["ask", "assisted", "full_access"]) {
  test(`Codex ${approvalMode} rejects native turn-scoped permissions without granting or claiming request scope`, { timeout: 5_000 }, async () => {
    const server = codexAppServerFixture({ method: "item/permissions/requestApproval" });
    const adapter = createCodexAdapter({ command: "fixture", spawnFn: server.spawnFn });
    const events = [];
    for await (const event of adapter.invoke({
      ...request, approvalMode, mcpServers: undefined, signal: AbortSignal.timeout(4_000)
    })) events.push(event);
    assert.equal(events.some(event => event.type === "interaction.requested"), false);
    assert.equal(events.at(-1).type, "run.failed");
    assert.match(events.at(-1).payload.message, /APPROVAL_GRANT_SCOPE_UNSUPPORTED/);
    assert.deepEqual(server.writes.filter(message => message.id === "native-request-1"), [{
      jsonrpc: "2.0", id: "native-request-1",
      error: { code: -32601, message: "unhandled server request: item/permissions/requestApproval" }
    }]);
    assert.equal(server.writes.some(message => message.result?.permissions || message.result?.decision === "accept"), false);
  });
}

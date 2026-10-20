import assert from "node:assert/strict";
import test from "node:test";
import { readFile, stat } from "node:fs/promises";
import {
  assertContextEnvelope,
  assertFrozenContextPlan,
  resolveContextConfiguration
} from "../packages/octo-runtime-protocol/dist/index.js";
import { renderModelContexts } from "../packages/octo-runtime-executor-core/dist/model-input.js";
import {
  invocationMcpServers,
  expandMcpValue,
  defineAdapter
} from "../packages/octo-runtime-adapter-sdk/dist/index.js";
import { resolveLocalContext } from "../packages/octo-runtime-executor-core/dist/context.js";
import { buildCodexCommand } from "../packages/octo-runtime-adapter-codex/dist/index.js";
import { buildClaudeCommand } from "../packages/octo-runtime-adapter-claude-code/dist/index.js";
import { buildOpenCodeCommand } from "../packages/octo-runtime-adapter-opencode/dist/index.js";
import { createAcpAdapter } from "../packages/octo-runtime-adapter-acp/dist/index.js";
import { invokeRequest } from "./runtime-fixture.js";

const envelope = (mcpServers) => ({
  schema: "octo.context-envelope/v3",
  items: [{ namespace: "octo.execution", name: "mcp", payload: { mcpServers } }]
});
const remote = (headers = {}) => ({
  type: "streamable_http",
  url: "https://example.invalid/mcp",
  headers
});
const request = (mcpServers, env = {}, extra = {}) =>
  invokeRequest({
    ...extra,
    context: {
      ...envelope(mcpServers),
      items: [
        ...envelope(mcpServers).items,
        {
          namespace: "octo.execution",
          name: "envs",
          payload: { env_variables: Object.entries(env).map(([key, value]) => ({ key, value })) }
        }
      ]
    }
  });

test("MCP dynamic keys freeze without entering model input; altered plan is rejected", () => {
  const defaults = {
    schema: "octo.context-envelope/v3",
    items: [
      { namespace: "octo.execution", name: "adapter", payload: { type: "codex" } },
      {
        namespace: "octo.execution",
        name: "workspace",
        payload: { mode: "fixed", path: process.cwd() }
      }
    ]
  };
  const servers = JSON.parse(
    '{"business.eu-v2":{"type":"streamable_http","url":"${URL}"},"constructor":{"type":"stdio","command":"node"}}'
  );
  const { effectiveContext, resolvedExecutionPlan } = resolveLocalContext(
    defaults,
    envelope(servers),
    "provisioned"
  );
  assertFrozenContextPlan(effectiveContext, resolvedExecutionPlan);
  assert.equal(renderModelContexts(effectiveContext), "");
  assert.deepEqual(resolvedExecutionPlan.mcp.mcpServers, servers);
  assert.throws(
    () =>
      assertFrozenContextPlan(effectiveContext, {
        ...resolvedExecutionPlan,
        mcp: { mcpServers: {} }
      }),
    /CONTEXT_PLAN_MISMATCH/
  );
});

test("MCP defaults replace whole servers and mandatory checks original request by server name", () => {
  const defaults = envelope({ x: remote({ Old: "secret" }), retained: remote() });
  const mandatory = envelope({ locked: remote() });
  const effective = resolveContextConfiguration(
    { defaults, mandatory },
    envelope({ x: { type: "stdio", command: "node" } })
  );
  const servers = effective.items[0].payload.mcpServers;
  assert.deepEqual(servers.x, { type: "stdio", command: "node" });
  assert.ok(servers.retained && servers.locked);
  const forced = resolveContextConfiguration(
    { defaults, mandatory },
    envelope({ locked: remote({ Extra: "no" }) })
  );
  assert.deepEqual(forced.items[0].payload.mcpServers.locked, remote());
});

test("MCP variable resolution is single-pass, isolated, preserves literals and fails before spawn", async () => {
  const template = remote({
    Authorization: "Bearer ${TOKEN}",
    Literal: "$${TOKEN}",
    Empty: "${EMPTY}"
  });
  const before = JSON.stringify(template);
  const outputs = await Promise.all(
    ["left", "right"].map(async (value) =>
      invocationMcpServers(request({ x: template }, { TOKEN: value, EMPTY: "" }))
    )
  );
  assert.equal(outputs[0].x.headers.Authorization, "Bearer left");
  assert.equal(outputs[1].x.headers.Authorization, "Bearer right");
  assert.equal(outputs[0].x.headers.Literal, "${TOKEN}");
  assert.equal(outputs[0].x.headers.Empty, "");
  assert.equal(JSON.stringify(template), before);
  assert.equal(expandMcpValue("${A}", { A: "${B}", B: "never" }, "x"), "${B}");
  assert.throws(
    () => invocationMcpServers(request({ x: template }), {}),
    /MCP_ENV_MISSING: x.headers.Authorization: TOKEN/
  );
  assert.throws(
    () =>
      invocationMcpServers(request({ x: remote({ Auth: "${TOKEN}" }) }), { TOKEN: "bad\nheader" }),
    /MCP_HEADER_INVALID/
  );
  assert.throws(
    () =>
      invocationMcpServers(request({ x: { type: "streamable_http", url: "${URL}" } }), {
        URL: "file:///private"
      }),
    /absolute HTTP URL/
  );
  assert.equal(
    invocationMcpServers(request({ x: remote({ A: "${A}" }) }), { A: "parent" }).x.headers.A,
    "parent"
  );
});

test("Codex carries private header references; Claude writes a private temporary config; OpenCode overlays", async () => {
  const req = request(
    { business: remote({ Authorization: "Bearer ${TOKEN}" }) },
    { TOKEN: "private-value" },
    { approvalMode: "full_access" }
  );
  const codex = buildCodexCommand(req, "codex", [], {});
  assert.equal(JSON.stringify(codex.args).includes("private-value"), false);
  const ref = codex.mcpServers.business.env_http_headers.Authorization;
  assert.equal(codex.env[ref], "Bearer private-value");
  const claude = await buildClaudeCommand(req);
  const file = claude.args[claude.args.indexOf("--mcp-config") + 1];
  try {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const payload = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(payload.mcpServers.business, {
      type: "http",
      url: "https://example.invalid/mcp",
      headers: { Authorization: "Bearer private-value" }
    });
    assert.equal(claude.args.includes("--strict-mcp-config"), false);
  } finally {
    await claude.cleanup();
  }
  await assert.rejects(readFile(file), { code: "ENOENT" });
  const open = await buildOpenCodeCommand(req);
  try {
    assert.equal(
      JSON.parse(open.env.OPENCODE_CONFIG_CONTENT).mcp.business.headers.Authorization,
      "Bearer private-value"
    );
  } finally {
    await open.cleanup();
  }
});

test("ACP injects HTTP configuration on new, resume and missing-session fallback; checks advertised transport", async () => {
  for (const resume of [false, true]) {
    const calls = [];
    let id = 0;
    const client = {
      initialize: async () => ({
        agentCapabilities: { mcpCapabilities: { http: true }, loadSession: true }
      }),
      reserveRequestId: () => ++id,
      request: async (method, params) => {
        calls.push({ method, params });
        return method === "session/load" ? null : { sessionId: "new" };
      },
      async *prompt() {
        yield { type: "prompt_result", stopReason: "end_turn" };
      },
      close: async () => {},
      cancel() {}
    };
    const adapter = createAcpAdapter(
      { type: "test-acp", provider: "test", command: "unused" },
      { acpClientFactory: () => client }
    );
    const req = request(
      { business: remote({ Auth: "${TOKEN}" }) },
      { TOKEN: "run" },
      { approvalMode: "ask", ...(resume ? { providerSession: { sessionId: "old" } } : {}) }
    );
    for await (const _ of adapter.invoke(req)) {
    }
    assert.deepEqual(
      calls.map((call) => call.method),
      resume ? ["session/load", "session/new"] : ["session/new"]
    );
    for (const call of calls)
      assert.deepEqual(call.params.mcpServers, [
        {
          name: "business",
          type: "http",
          url: "https://example.invalid/mcp",
          headers: [{ name: "Auth", value: "run" }]
        }
      ]);
    client.initialize = async () => ({ agentCapabilities: {} });
    calls.length = 0;
    await assert.rejects(async () => {
      for await (const _ of adapter.invoke(req)) {
      }
    }, /MCP_TRANSPORT_UNSUPPORTED/);
    assert.equal(calls.length, 0);
  }
});

test("unsupported adapters and native options fail explicitly", async () => {
  const adapter = defineAdapter({
    metadata: {
      type: "unsupported",

      agentSources: ["provisioned"]
    },
    async *invoke() {
      throw new Error("must not execute");
    }
  });
  await assert.rejects(async () => {
    for await (const _ of adapter.invoke(request({ x: remote() }))) {
    }
  }, /MCP_UNSUPPORTED/);
  await assert.rejects(
    buildClaudeCommand(request({ x: remote({ Literal: "$${TOKEN}" }) })),
    /MCP_LITERAL_UNSUPPORTED/
  );
  await assert.rejects(
    buildClaudeCommand(request({ x: { ...remote(), startupTimeoutMs: 1000 } })),
    /MCP_OPTION_UNSUPPORTED/
  );
  assert.throws(
    () => assertContextEnvelope(envelope({ x: { ...remote(), unexpected: true } })),
    /CONTEXT_SCHEMA_INVALID/
  );
});

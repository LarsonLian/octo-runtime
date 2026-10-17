import assert from "node:assert/strict";
import test from "node:test";
import { createCodexAdapter } from "@mininglamp-oss/octo-runtime-adapter-codex";
import { codexAppServerFixture, invokeRequest } from "./runtime-fixture.js";

const context = (servers, envs = {}) => ({
  schema: "octo.context-envelope/v3",
  items: [
    { namespace: "octo.execution", name: "mcp", payload: { mcpServers: servers } },
    {
      namespace: "octo.execution",
      name: "envs",
      payload: {
        env_variables: Object.entries(envs).map(([key, value]) => ({ key, value }))
      }
    }
  ]
});

for (const resume of [false, true]) {
  for (const forwardEnv of [false, true]) {
    test(`Codex only overrides new MCP and necessary env names: resume=${resume}, env=${forwardEnv}`, async () => {
      const config = {
        shell_environment_policy: { set: { EXISTING: "kept" }, include_only: ["PATH"] },
        mcp_servers: {
          local: { command: "node", env_vars: ["EXISTING"], tool_timeout_sec: null, cwd: null },
          http: { url: "https://example.invalid/native", tool_timeout_sec: null },
          disabled: { command: "node", enabled: false },
          remote: { command: "node", experimental_environment: "remote" }
        }
      };
      const original = structuredClone(config);
      const server = codexAppServerFixture({ config });
      const adapter = createCodexAdapter({ command: "fixture", spawnFn: server.spawnFn, env: {} });
      const events = [];
      for await (const event of adapter.invoke(
        invokeRequest({
          approvalMode: "full_access",
          signal: AbortSignal.timeout(2_000),
          ...(resume ? { providerSession: { sessionId: "old-thread" } } : {}),
          context: context(
            {
              added: {
                type: "stdio",
                command: "node",
                args: ["tool.mjs"],
                env: { SPECIFIC: "kept" }
              },
              business: {
                type: "streamable_http",
                url: "https://example.invalid/run",
                headers: { Auth: "header-value" }
              }
            },
            forwardEnv ? { RUN_VALUE: "run-value" } : {}
          )
        })
      )) {
        events.push(event);
        if (event.type === "session.update") server.complete();
      }
      assert.equal(events.at(-1).type, "run.completed");
      const thread = server.writes.find(
        (message) => message.method === (resume ? "thread/resume" : "thread/start")
      );
      const overrides = thread.params.config;
      const { business, ...otherServers } = overrides.mcp_servers;
      assert.deepEqual(otherServers, {
        ...(forwardEnv ? { local: { env_vars: ["EXISTING", "RUN_VALUE"] } } : {}),
        added: {
          command: "node",
          args: ["tool.mjs"],
          env: { SPECIFIC: "kept" },
          ...(forwardEnv ? { env_vars: ["RUN_VALUE"] } : {})
        }
      });
      assert.equal(business.url, "https://example.invalid/run");
      assert.match(business.env_http_headers.Auth, /^OCTO_MCP_/);
      assert.doesNotMatch(
        JSON.stringify(server.writes),
        /header-value|tool_timeout_sec|experimental_environment/
      );
      assert.equal(
        overrides["shell_environment_policy.set"]?.RUN_VALUE,
        forwardEnv ? "run-value" : undefined
      );
      assert.deepEqual(config, original);
      assert.equal(server.writes.filter((message) => message.method === "config/read").length, 1);
    });
  }
}

const nativeServers = {
  stdio: { command: "node", tool_timeout_sec: null },
  http: { url: "https://example.invalid/native" },
  disabled: { command: "node", enabled: false },
  null_entry: null
};
for (const [name, native] of Object.entries(nativeServers)) {
  for (const type of ["stdio", "streamable_http"]) {
    for (const resume of [false, true]) {
      test(`Codex rejects native MCP name before any thread or prompt: ${name}/${type}/resume=${resume}`, async () => {
        const server = codexAppServerFixture({ config: { mcp_servers: { [name]: native } } });
        const adapter = createCodexAdapter({ command: "fixture", spawnFn: server.spawnFn });
        const events = [];
        const request = invokeRequest({
          signal: AbortSignal.timeout(2_000),
          ...(resume ? { providerSession: { sessionId: "old-thread" } } : {}),
          context: context({
            [name]:
              type === "stdio"
                ? { type, command: "node" }
                : { type, url: "https://example.invalid/new" }
          })
        });
        for await (const event of adapter.invoke(request)) events.push(event);
        assert.equal(events.at(-1).type, "run.failed");
        assert.equal(events.at(-1).payload.code, "MCP_SERVER_NAME_CONFLICT");
        assert.deepEqual(
          server.writes.filter((message) => message.method).map((message) => message.method),
          ["initialize", "initialized", "config/read"]
        );
      });
    }
  }
}

test("Codex native mode returns the explicit MCP conflict code", async () => {
  const server = codexAppServerFixture({ config: { mcp_servers: nativeServers } });
  const adapter = createCodexAdapter({ command: "fixture", spawnFn: server.spawnFn });
  await assert.rejects(
    async () => {
      for await (const _ of adapter.invoke(
        invokeRequest({
          signal: AbortSignal.timeout(2_000),
          context: context({ stdio: { type: "stdio", command: "node" } })
        }),
        { protocolMode: "native" }
      )) {
      }
    },
    { code: "MCP_SERVER_NAME_CONFLICT" }
  );
  assert.equal(
    server.writes.some((message) => /^(thread|turn)\//.test(message.method ?? "")),
    false
  );
});

test("Codex leaves provider configuration untouched without run MCP or env overrides", async () => {
  const server = codexAppServerFixture({ config: { mcp_servers: nativeServers } });
  const adapter = createCodexAdapter({ command: "fixture", spawnFn: server.spawnFn });
  const events = [];
  for await (const event of adapter.invoke(
    invokeRequest({ approvalMode: "full_access", signal: AbortSignal.timeout(2_000) })
  )) {
    events.push(event);
    if (event.type === "session.update") server.complete();
  }
  assert.equal(events.at(-1).type, "run.completed");
  assert.equal(
    server.writes.some((message) => message.method === "config/read"),
    false
  );
  assert.equal(
    server.writes.find((message) => message.method === "thread/start").params.config,
    undefined
  );
});

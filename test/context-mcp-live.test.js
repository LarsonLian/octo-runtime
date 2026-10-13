import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { buildCodexCommand } from "../packages/octo-harness-adapter-codex/dist/index.js";
import { buildClaudeCommand } from "../packages/octo-harness-adapter-claude-code/dist/index.js";
import { invocationEnvironment } from "../packages/octo-harness-adapter-sdk/dist/index.js";
import { invocationMcpServers } from "../packages/octo-harness-adapter-sdk/dist/index.js";
import { spawnAcpClient } from "../packages/octo-harness-acp-client/dist/index.js";
import { invokeRequest } from "./agent-work-runtime-fixture.js";
import { startMcpHttpServer } from "../test-support/mcp/http-server.mjs";

const enabled = process.env.OCTO_RUN_MCP_LIVE === "1";
const request = (url, root) =>
  invokeRequest({
    workdir: root,
    context: {
      schema: "octo.context-envelope/v3",
      items: [
        {
          namespace: "octo.execution",
          name: "mcp",
          payload: {
            mcpServers: {
              business: {
                type: "streamable_http",
                url: "${MCP_URL}",
                headers: {
                  Authorization: "Bearer ${MCP_TEST_TOKEN}",
                  "X-Literal": "$${MCP_TEST_TOKEN}"
                }
              }
            }
          }
        },
        {
          namespace: "octo.execution",
          name: "envs",
          payload: {
            env_variables: [
              { key: "MCP_URL", value: url },
              { key: "MCP_TEST_TOKEN", value: "synthetic-run-token" }
            ]
          }
        }
      ]
    }
  });

test(
  "native Claude connects a Run HTTP MCP before a model turn",
  { skip: !enabled, timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "octo-claude-mcp-"));
    const http = await startMcpHttpServer();
    const req = request(http.url, root);
    delete req.context.items[0].payload.mcpServers.business.headers["X-Literal"];
    const spec = await buildClaudeCommand(req, "claude", ["--strict-mcp-config"]);
    const child = spawn(spec.command, spec.args, {
      cwd: root,
      env: invocationEnvironment(req),
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    const replies = [];
    lines.on("line", (line) => {
      try {
        replies.push(JSON.parse(line));
      } catch {}
    });
    try {
      child.stdin.write(
        JSON.stringify({
          type: "control_request",
          request_id: "init",
          request: { subtype: "initialize" }
        }) + "\n"
      );
      for (
        let attempt = 0;
        attempt < 200 && !http.receipts.some((r) => r.method === "tools/list");
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(
        http.receipts.some(
          (r) => r.method === "tools/list" && r.authorization === "Bearer synthetic-run-token"
        ),
        `no authenticated discovery; literals: ${JSON.stringify(http.receipts.map((r) => [r.method, r.literal]))}; response types: ${replies.map((r) => r.type).join(",")}`
      );
    } finally {
      lines.close();
      child.stdin.end();
      child.kill();
      await new Promise((resolve) =>
        child.exitCode !== null ? resolve() : child.once("close", resolve)
      );
      await spec.cleanup();
      await http.close();
      await rm(root, { recursive: true, force: true });
    }
  }
);

test(
  "native Codex discovers a Run HTTP MCP with resolved headers without changing config",
  { skip: !enabled, timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "octo-mcp-live-"));
    const http = await startMcpHttpServer();
    const config = "# native configuration remains unchanged\n";
    await writeFile(join(root, "config.toml"), config);
    const spec = buildCodexCommand(request(http.url, root), "codex", ["app-server"], {
      ...process.env,
      CODEX_HOME: root
    });
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    const pending = new Map();
    let id = 0;
    lines.on("line", (line) => {
      const m = JSON.parse(line),
        p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    });
    const rpc = (method, params) =>
      new Promise((resolve, reject) => {
        const current = ++id;
        const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 10000);
        pending.set(current, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id: current, method, params }) + "\n");
      });
    try {
      await rpc("initialize", {
        clientInfo: { name: "octo-mcp-test", version: "1" },
        capabilities: { experimentalApi: true }
      });
      child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
      const first = await rpc("thread/start", {
        cwd: root,
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        config: { mcp_servers: spec.mcpServers }
      });
      assert.ok(first.thread.id);
      for (
        let attempt = 0;
        attempt < 100 && !http.receipts.some((r) => r.method === "tools/list");
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(
        http.receipts.some(
          (r) =>
            r.method === "tools/list" &&
            r.authorization === "Bearer synthetic-run-token" &&
            r.literal === "${MCP_TEST_TOKEN}"
        )
      );
      assert.equal(await readFile(join(root, "config.toml"), "utf8"), config);
      const effective = await rpc("config/read", { cwd: root, includeLayers: false });
      assert.equal(effective.config.mcp_servers?.business, undefined);
    } finally {
      for (const p of pending.values()) clearTimeout(p.timer);
      lines.close();
      child.stdin.end();
      child.kill();
      await new Promise((resolve) =>
        child.exitCode !== null ? resolve() : child.once("close", resolve)
      );
      await http.close();
      await rm(root, { recursive: true, force: true });
    }
  }
);

for (const command of ["kimi", "mcode"])
  test(
    `native ${command} advertises and connects HTTP MCP through ACP`,
    { skip: !enabled, timeout: 30000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "octo-acp-mcp-"));
      const http = await startMcpHttpServer();
      const client = spawnAcpClient({ command, args: ["acp"], cwd: root, env: process.env });
      try {
        const initialized = await client.initialize();
        if (initialized.agentCapabilities?.mcpCapabilities?.http !== true) {
          t.skip(
            "installed native runtime does not advertise HTTP MCP; adapter rejects it explicitly"
          );
          return;
        }
        const servers = invocationMcpServers(request(http.url, root));
        const session = await client.request(
          "session/new",
          {
            cwd: root,
            mcpServers: Object.entries(servers).map(([name, value]) => ({
              name,
              type: "http",
              url: value.url,
              headers: Object.entries(value.headers).map(([name, value]) => ({ name, value }))
            }))
          },
          { timeoutMs: 10000 }
        );
        assert.ok(session.sessionId);
        if (command === "mcode") {
          try {
            await client.request(
              "session/prompt",
              {
                sessionId: session.sessionId,
                prompt: [
                  {
                    type: "text",
                    text: "Call the octo_echo MCP tool with value mcp-live. Do not use any other tools. Then reply done."
                  }
                ]
              },
              { timeoutMs: 15000 }
            );
          } catch {
            t.diagnostic(
              "Model turn failed; this check only validates MCP connection and discovery receipts."
            );
          }
        }
        for (
          let attempt = 0;
          attempt < 100 && !http.receipts.some((r) => r.method === "tools/list");
          attempt++
        )
          await new Promise((resolve) => setTimeout(resolve, 50));
        assert.ok(
          http.receipts.some(
            (r) =>
              r.method === "tools/list" &&
              r.authorization === "Bearer synthetic-run-token" &&
              r.literal === "${MCP_TEST_TOKEN}"
          )
        );
      } finally {
        await client.close();
        await http.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  );

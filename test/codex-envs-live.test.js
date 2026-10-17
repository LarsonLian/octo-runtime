import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { invocationEnvironment } from "../packages/octo-runtime-adapter-sdk/dist/index.js";
import { codexEnvironmentConfig } from "../packages/octo-runtime-adapter-codex/dist/environment.js";
import { invokeRequest } from "./runtime-fixture.js";

// Native app-server and a real stdio MCP child; no model turn or credentials required.
test(
  "native Codex passes Run envs through its MCP whitelist",
  { skip: process.env.OCTO_RUN_CODEX_ENVS_LIVE !== "1", timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "octo-envs-native-"));
    const script = join(root, "mcp.cjs");
    const receipt = join(root, "receipt.json");
    await writeFile(
      script,
      `const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});
fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({value:process.env.OCTO_ENVS_NATIVE_TEST,empty:process.env.OCTO_ENVS_EMPTY,tool:process.env.OCTO_TOOL_OVERRIDE_TEST}));
rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};
if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'env-test',version:'1'}};
if(m.method==='tools/list')result={tools:[]};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`
    );
    await writeFile(
      join(root, "config.toml"),
      `[mcp_servers.env_test]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(script)}]\nrequired = true\n`
    );
    const request = invokeRequest({
      workdir: root,
      context: {
        schema: "octo.context-envelope/v3",
        items: [
          {
            namespace: "octo.execution",
            name: "envs",
            payload: {
              env_variables: [
                { key: "OCTO_ENVS_NATIVE_TEST", value: "native-literal" },
                { key: "OCTO_ENVS_EMPTY", value: "" }
              ]
            }
          }
        ]
      },
      executionEnvOverrides: {
        env_variables: [
          { key: "OCTO_TOOL_OVERRIDE_TEST", value: "internal-only" },
          { key: "OCTO_ENVS_NATIVE_TEST", value: "trusted-override" }
        ]
      }
    });
    const child = spawn("codex", ["app-server"], {
      cwd: root,
      env: invocationEnvironment(request, { CODEX_HOME: root }),
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stderr.resume();
    let next = 0;
    const pending = new Map();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const msg = JSON.parse(line),
        waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
    });
    const rpc = (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    try {
      await rpc("initialize", {
        clientInfo: { name: "octo-envs-test", version: "1" },
        capabilities: { experimentalApi: true }
      });
      child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
      const effective = await rpc("config/read", { includeLayers: false, cwd: root });
      const overrides = codexEnvironmentConfig(request, effective.config);
      const started = await rpc("thread/start", {
        cwd: root,
        sandbox: "read-only",
        approvalPolicy: "untrusted",
        config: overrides
      });
      assert.ok(started.thread.id);
      let observed;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          observed = JSON.parse(await readFile(receipt, "utf8"));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      assert.deepEqual(observed, { value: "trusted-override", empty: "", tool: "internal-only" });
      const unchanged = await rpc("config/read", { includeLayers: false, cwd: root });
      assert.equal(
        unchanged.config.mcp_servers.env_test.env_vars?.includes("OCTO_ENVS_NATIVE_TEST") ?? false,
        false
      );
    } finally {
      for (const waiter of pending.values()) clearTimeout(waiter.timer);
      lines.close();
      child.stdin.end();
      child.kill();
      await new Promise((resolve) =>
        child.exitCode !== null ? resolve() : child.once("close", resolve)
      );
      await rm(root, { recursive: true, force: true });
    }
  }
);

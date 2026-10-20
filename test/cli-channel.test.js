import { prepareInvokeInput } from "../packages/octo-runtime-executor-core/dist/invoke-input.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";
import { runCli } from "../apps/cli/dist/main.js";
import { ExtraPlugins, readExtraDirectory } from "../packages/octo-runtime-daemon/dist/index.js";
import {
  validateImConfig,
  ImRuntime
} from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
import { createImInvocation as createChannelInput } from "../packages/octo-runtime-extra-channel-gateway/dist/execution/dispatcher.js";

const octo = (workdir, overrides = {}) => ({
  api_url: "https://im-test.deepminer.com.cn/api",
  bot_id: "bot",
  bf_token: "bf_fixture",
  adapter: { workdir },
  ...overrides
});

test("generic extra configuration stays independent; CLI OpenClaw tool preparation is the only channel dependency", async () => {
  for (const app of ["cli", "daemon"]) {
    const manifest = JSON.parse(
      await readFile(new URL(`../apps/${app}/package.json`, import.meta.url), "utf8")
    );
    assert.deepEqual(
      Object.keys(manifest.dependencies).filter((name) => name.includes("-extra-")),
      app === "daemon" ? ["@mininglamp-oss/octo-runtime-extra-channel-gateway"] : []
    );
  }
  const daemon = await readFile(new URL("../apps/daemon/src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(daemon, /im-config|imBots|wecomBots|initializeCliImAdapters/);
  assert.match(daemon, /readExtraDirectory/);
  let help = "";
  await runCli(["help"], {
    output: (line) => {
      help += line;
    }
  });
  assert.doesNotMatch(help, /channel configure/);
  assert.match(help, /extraset/);
});

test("extraset without workdir can be loaded by channel-gateway", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "extraset-cwd-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await runCli(["--home", home, "extraset", "channel-gateway"], {
    input: Readable.from([
      JSON.stringify({
        module: "@mininglamp-oss/octo-runtime-extra-channel-gateway",
        config: { bots: [octo(undefined, { enabled: false })] }
      })
    ]),
    output() {}
  });
  const extras = new ExtraPlugins(await readExtraDirectory(join(home, "extras")), {});
  t.after(() => extras.close());
  await extras.loadConfigured();
  assert.equal(extras.status["channel-gateway"].phase, "loaded");
});

test("Extra config preserves Bot arrays, names and arbitrary plugin fields", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "cli-channel-names-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configure = (bots) =>
    runCli(["--home", home, "extraset", "channel-gateway"], {
      input: Readable.from([
        JSON.stringify({
          module: "@mininglamp-oss/octo-runtime-extra-channel-gateway",
          config: { bots }
        })
      ]),
      output() {}
    });
  const first = octo(home, {
    bot_name: "本地助理",
    custom: { nested: [1, true, null, { value: "preserved" }] },
    adapter: { workdir: home, custom_option: { value: 42 } }
  });
  const second = octo(home, { bot_id: "other" });
  const file = join(home, "extras/channel-gateway/config.json");
  await configure([first, second]);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).config.bots, [first, second]);
  await configure([second]);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).config.bots, [second]);
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  const runtime = new ImRuntime(second, { host: {} });
  t.after(() => runtime.close());
  assert.equal(runtime.status.bot_name, "other");
  assert.equal(second.bot_name, undefined);
  const named = new ImRuntime(first, { host: {} });
  t.after(() => named.close());
  assert.equal(named.status.bot_name, "本地助理");
  for (const bot_name of [null, "", "  ", 123, {}, []]) {
    assert.throws(() => validateImConfig({ ...first, bot_name }), /IM_BOT_NAME_INVALID/);
  }
});

test("configuration allows omitted workspace and requires absolute explicit paths", () => {
  validateImConfig(octo(undefined));
  for (const workdir of ["", "~", "~/work", ".", "relative"]) {
    assert.throws(() => validateImConfig(octo(workdir)), /IM_WORKDIR_ABSOLUTE_REQUIRED/);
  }
  validateImConfig(octo("/tmp", { adapter: { workdir: "/tmp", custom: { arbitrary: true } } }));
  assert.throws(
    () =>
      validateImConfig(
        octo("/tmp", { adapter: { adapter_type: "openclaw", provider_agent_id: "../bad" } })
      ),
    /IM_PROVIDER_AGENT_ID_INVALID/
  );
});

test("omitted channel workspace is created per Bot and remains stable across events", async (t) => {
  const botId = `cwd-test-${randomUUID()}`;
  const expected = join(homedir(), "octo-runtime", "channels", botId);
  t.after(() => rm(expected, { recursive: true, force: true }));
  const config = octo(undefined, { bot_id: botId });
  const context = { schema: "octo.context-envelope/v3", items: [] };
  for (const messageId of ["first", "second"]) {
    const { request } = createImInvocation(
      config,
      { messageId, senderId: "u", conversationId: "c", conversationKind: "direct", text: "hello" },
      context,
      "key",
      { id: "as_test", generation: 1 },
      new AbortController().signal
    );
    assert.equal(request.workdir, expected);
    assert.equal(request.agentConfig.workdir, expected);
    assert.equal(
      request.context.items.find((item) => item.name === "workspace").payload.path,
      expected
    );
    assert.ok((await stat(expected)).isDirectory());
  }
  assert.equal(config.adapter.workdir, undefined);
  for (const bot_id of ["..", ".", "../escape", "/tmp/escape", "a\\b"]) {
    assert.throws(() => validateImConfig(octo(undefined, { bot_id })), /IM_BOT_ID_PATH_INVALID/);
  }
});

test("default-enabled endpoint fails without credentials, while explicit disabled does not read credentials", async (t) => {
  let reads = 0;
  for (const enabled of [undefined, false]) {
    const runtime = new ImRuntime(
      octo("/tmp", { bf_token: undefined, ...(enabled === undefined ? {} : { enabled }) }),
      {
        host: {},
        credentials: async () => {
          reads++;
          return undefined;
        }
      }
    );
    t.after(() => runtime.close());
    await runtime.start();
    assert.equal(runtime.status.state, enabled === false ? "stopped" : "failed");
    assert.equal(runtime.status.error, enabled === false ? null : "IM_CREDENTIALS_REQUIRED");
  }
  assert.equal(reads, 1);
});

test("nested execution settings reach Host and OpenClaw defaults to main with no workspace", () => {
  const message = {
    messageId: "m",
    senderId: "u",
    conversationId: "c",
    conversationKind: "direct",
    text: "hello"
  };
  const context = { schema: "octo.context-envelope/v3", items: [] };
  for (const adapter of [
    { adapter_type: "codex", workdir: "/tmp", model: "test", effort: "high" },
    { adapter_type: "openclaw", model: "test", effort: "medium" }
  ]) {
    const { request } = createImInvocation(
      octo("/tmp", { adapter }),
      message,
      context,
      "key",
      { id: "as_test", generation: 1 },
      new AbortController().signal
    );
    assert.equal(request.agentConfig.model, "test");
    assert.equal(request.agentConfig.effort, adapter.effort);
    if (adapter.adapter_type === "openclaw") {
      assert.equal(request.agentSource, "preset");
      assert.equal(request.agentConfig.providerAgentId, "main");
      assert.equal(request.workdir, "");
      assert.ok(!request.context.items.some((item) => item.name === "workspace"));
    } else assert.equal(request.workdir, "/tmp");
  }
});

test("Octo verifies Bot and tenant before registering or connecting, without a configured space_id", async (t) => {
  const { createServer } = await import("node:http");
  let registrationCalls = 0;
  let identity = { bot_uid: "different-bot", space_id: "tenant" };
  const server = createServer((req, res) => {
    if (req.url === "/v1/auth/verify-bot") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(identity));
    } else {
      registrationCalls++;
      res.writeHead(500).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = octo("/tmp", { api_url: `http://127.0.0.1:${server.address().port}` });
  const wrongBot = new ImRuntime(config, { host: {} });
  await wrongBot.start();
  assert.equal(wrongBot.status.error, "IM_BOT_IDENTITY_MISMATCH");
  await wrongBot.close();
  identity = { bot_uid: "bot", space_id: "other-tenant" };
  const wrongTenant = new ImRuntime(config, {
    host: {},
    authorizeSpace: (space) => {
      assert.equal(space, "other-tenant");
      throw new Error("IM_TENANT_NOT_ACTIVE");
    }
  });
  await wrongTenant.start();
  assert.equal(wrongTenant.status.state, "failed");
  assert.equal(wrongTenant.status.error, "IM_TENANT_NOT_ACTIVE");
  await wrongTenant.close();
  assert.equal(registrationCalls, 0);
});

const createImInvocation = (...args) => {
  const result = createChannelInput(...args);
  return { ...result, request: prepareInvokeInput(result.request).request };
};

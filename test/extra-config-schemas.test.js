import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { assertStoredExtra } from "../packages/octo-runtime-daemon/dist/extra-config.js";
import { validateImConfig as validateGateway } from "@mininglamp-oss/octo-runtime-extra-channel-gateway";
import { validateImConfig as validateWecom } from "@mininglamp-oss/octo-runtime-extra-channel-wecom";

const Ajv = createRequire(import.meta.resolve("eslint"))("ajv");
const ajv = new Ajv({ allErrors: true, logger: false });
const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const packages = {
  "channel-gateway": "octo-runtime-extra-channel-gateway",
  "channel-wecom": "octo-runtime-extra-channel-wecom",
  webui: "octo-runtime-webui-extra"
};
const schemas = Object.fromEntries(
  Object.entries(packages).map(([name, directory]) => [
    name,
    readJson(`../packages/${directory}/config-schema.json`)
  ])
);
const validators = Object.fromEntries(
  Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)])
);
const declaration = (name, config) => ({ module: `@mininglamp-oss/${packages[name]}`, config });
const bot = (name) => ({
  bot_id: "example-bot",
  adapter: { adapter_type: "codex", workdir: "/absolute/workspace" },
  ...(name === "channel-gateway" ? { api_url: "https://im-test.deepminer.com.cn/api" } : {})
});
const accepts = (name, config, expected = true) => {
  const validate = validators[name];
  assert.equal(validate(config), expected, JSON.stringify(validate.errors));
};

for (const name of Object.keys(packages)) {
  test(`${name}: complete examples and public schema export match the installed contract`, () => {
    const schema = schemas[name];
    assert.ok(!("definitions" in schema));
    assert.ok(!JSON.stringify(schema).includes('"$ref"'));
    const publicPath = `@mininglamp-oss/octo-runtime/extras/${name}/config-schema.json`;
    assert.deepEqual(
      JSON.parse(readFileSync(new URL(import.meta.resolve(publicPath)), "utf8")),
      schema
    );
    const manifest = readJson(`../packages/${packages[name]}/package.json`);
    assert.equal(manifest.exports["./config-schema.json"], "./config-schema.json");
    assert.ok(manifest.files.includes("config-schema.json"));
    for (const example of schema.examples) {
      const snapshot = structuredClone(example);
      accepts(name, example);
      assertStoredExtra(example);
      for (const item of example.config.bots ?? []) {
        (name === "channel-wecom" ? validateWecom : validateGateway)(item);
      }
      assert.deepEqual(example, snapshot);
    }
  });

  test(`${name}: minimal input stays unchanged and malformed declarations fail`, () => {
    const config = name === "webui" ? { sessionStorePath: "/absolute/private/sessions.json" } : {};
    const minimal = declaration(name, config);
    const snapshot = structuredClone(minimal);
    accepts(name, minimal);
    assert.deepEqual(minimal, snapshot);
    for (const invalid of [
      {},
      { config },
      { module: minimal.module },
      { ...minimal, module: "another-package" },
      { ...minimal, enabled: "true" },
      { ...minimal, config: [] },
      { ...minimal, unexpected: true }
    ])
      accepts(name, invalid, false);
  });

  test(`${name}: business fields explain their purpose and conditional requirements`, () => {
    const visit = (node) => {
      for (const [key, value] of Object.entries(node.properties ?? {})) {
        assert.ok(value.description?.length >= 12, `${name}.${key} needs a useful description`);
        visit(value);
      }
      if (node.items && !Array.isArray(node.items)) visit(node.items);
    };
    visit(schemas[name]);
  });
}

for (const [name, maximum] of [
  ["channel-wecom", 16],
  ["channel-gateway", 64]
]) {
  test(`${name}: Bot limits, required fields, credentials and OpenClaw conditions`, () => {
    const check = (item, valid = true) => accepts(name, declaration(name, { bots: [item] }), valid);
    const item = bot(name);
    check(item);
    check({ ...item, enabled: false });
    for (const field of ["bot_id", "adapter", ...(name === "channel-gateway" ? ["api_url"] : [])]) {
      const missing = structuredClone(item);
      delete missing[field];
      check(missing, false);
    }
    for (const invalid of [
      { ...item, bot_name: "  " },
      { ...item, adapter: { workdir: "./relative" } },
      { ...item, adapter: { ...item.adapter, model: 42 } },
      { ...item, adapter: { ...item.adapter, effort: "unknown" } },
      { ...item, adapter: { ...item.adapter, provider_agent_id: "main" } },
      { ...item, adapter: { adapter_type: "openclaw", workdir: "/absolute/workspace" } },
      { ...item, adapter: { adapter_type: "openclaw", provider_agent_id: "invalid/id" } },
      { ...item, allowed_sender_ids: [42] },
      { ...item, approval_mode: "unknown" }
    ])
      check(invalid, false);
    check({ ...item, adapter: { adapter_type: "openclaw" } });
    check({
      ...item,
      adapter: { adapter_type: "openclaw", provider_agent_id: "research_assistant" }
    });
    check({ ...item, adapter: {} }, name === "channel-gateway");
    const credential = name === "channel-wecom" ? "app_secret" : "bf_token";
    const properties = schemas[name].properties.config.properties.bots.items.properties;
    assert.ok(!(`${credential}_file` in properties));
    check({ ...item, [credential]: "bf_fixture" });
    check({ ...item, [credential]: "" });
    check({ ...item, [credential]: 42 }, false);
    accepts(
      name,
      declaration(name, {
        bots: Array.from({ length: maximum }, (_, i) => ({ ...item, bot_id: `bot-${i}` }))
      })
    );
    accepts(name, declaration(name, { bots: Array(maximum + 1).fill(item) }), false);
    accepts(name, declaration(name, { authorized_space_ids: [" "] }), false);
    accepts(name, declaration(name, { authorized_space_ids: [] }));
    const limits = name === "channel-wecom" ? [1, 600000] : [100, 86400000];
    check({ ...item, run_timeout_ms: limits[0] });
    check({ ...item, run_timeout_ms: limits[1] });
    check({ ...item, run_timeout_ms: limits[0] - 1 }, false);
    check({ ...item, run_timeout_ms: limits[1] + 1 }, false);
    check({ ...item, run_timeout_ms: 100.5 }, false);
    check({ ...item, unknown_extension: true }, name === "channel-gateway");
  });

  test(`${name}: optional Context declares only the v3 envelope and open item objects`, () => {
    const botConfig = schemas[name].properties.config.properties.bots.items;
    const contextConfig = botConfig.properties.context;
    assert.ok(!botConfig.required.includes("context"));
    assert.deepEqual(Object.keys(contextConfig.properties), ["schema", "items"]);
    assert.deepEqual(contextConfig.properties.items.items, {
      type: "object",
      additionalProperties: true
    });
    const item = bot(name);
    const check = (context, valid = true) =>
      accepts(name, declaration(name, { bots: [{ ...item, context }] }), valid);
    check({ schema: "octo.context-envelope/v3", items: [] });
    check({
      schema: "octo.context-envelope/v3",
      items: [
        {
          namespace: "extra.example",
          name: "background",
          guidance: "参考材料",
          payload: { text: "示例" }
        }
      ]
    });
    check({ schema: "octo.context-envelope/v2", items: [] }, false);
    check({ schema: "octo.context-envelope/v3", items: [{}] });
    check({
      schema: "octo.context-envelope/v3",
      items: [{ arbitrary: { nested: [1, true, null] } }]
    });
    for (const invalidItem of [null, 1, "text", []]) {
      check({ schema: "octo.context-envelope/v3", items: [invalidItem] }, false);
    }
    check({ items: [] }, false);
    check({ schema: "octo.context-envelope/v3" }, false);
    check({ schema: "octo.context-envelope/v3", items: {} }, false);
    const validateBot = name === "channel-wecom" ? validateWecom : validateGateway;
    assert.throws(
      () => validateBot({ ...item, context: { schema: "octo.context-envelope/v3", items: [{}] } }),
      /CONTEXT_SCHEMA_INVALID/
    );
  });
}

test("gateway: retry bounds, URL constraints and ignored extensions", () => {
  const name = "channel-gateway";
  const item = bot(name);
  const check = (override, valid = true) =>
    accepts(name, declaration(name, { bots: [{ ...item, ...override }] }), valid);
  for (const [key, minimum, maximum] of [
    ["max_consecutive_retries", 0, 100],
    ["max_total_retries", 0, 100],
    ["recovery_timeout_ms", 100, 3600000],
    ["initial_delay_ms", 100, 60000],
    ["max_delay_ms", 100, 300000]
  ]) {
    check({ codex_retry: { [key]: minimum } });
    check({ codex_retry: { [key]: maximum } });
    check({ codex_retry: { [key]: minimum - 1 } }, false);
    check({ codex_retry: { [key]: maximum + 1 } }, false);
  }
  check({ codex_retry: { enabled: "true" } }, false);
  check({ bf_token: "bf_EXAMPLE_TOKEN" });
  check({ bf_token: "  bf_EXAMPLE_TOKEN  " });
  check({ bf_token: "personal-login-token" }, false);
  check({ bf_token: "bf_" }, false);
  check({ api_url: "http://localhost:8080/api" });
  for (const api_url of [
    "http://example.com/api",
    "https://user:secret@example.com/api",
    "https://example.com/api?token=x"
  ])
    check({ api_url }, false);
  check({ adapter: {}, bot_id: "../escape" }, false);
  check({
    adapter: { ...item.adapter, future_extension: { value: true } },
    future_extension: true
  });
});

test("wecom: WebSocket endpoint and unknown Adapter fields", () => {
  const name = "channel-wecom";
  const item = bot(name);
  for (const ws_url of ["wss://openws.work.weixin.qq.com", "ws://127.0.0.1:8080"]) {
    accepts(name, declaration(name, { bots: [{ ...item, ws_url }] }));
  }
  for (const ws_url of ["https://example.com", "ws://example.com", "wss://example.com?token=x"]) {
    accepts(name, declaration(name, { bots: [{ ...item, ws_url }] }), false);
  }
  accepts(
    name,
    declaration(name, {
      bots: [{ ...item, adapter: { ...item.adapter, future_extension: true } }]
    }),
    false
  );
});

test("webui: required store path, port bounds and supported relative project path", () => {
  const name = "webui";
  const config = { sessionStorePath: "/absolute/private/sessions.json" };
  for (const port of [1, 13888, 65535]) accepts(name, declaration(name, { ...config, port }));
  for (const port of [0, 65536, 1.5, "13888"])
    accepts(name, declaration(name, { ...config, port }), false);
  for (const sessionStorePath of ["relative.json", "~/sessions.json", ""]) {
    accepts(name, declaration(name, { sessionStorePath }), false);
  }
  accepts(name, declaration(name, { ...config, defaultProjectPath: "./workspace" }));
  accepts(name, declaration(name, { ...config, defaultProjectPath: 42 }), false);
});

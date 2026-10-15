import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDaemonRuntime } from "../packages/octo-runtime-daemon/dist/index.js";

assert.ok(process.env.OCTO_CHANNEL_QA_ACCOUNTS, "Set protected QA account file path");
const blocks = (await readFile(process.env.OCTO_CHANNEL_QA_ACCOUNTS, "utf8"))
  .split(/(?=Bot Name:)/)
  .slice(1);
const block = blocks[Number(process.env.OCTO_CAPACITY_QA_INDEX ?? 3)];
const field = (key) => block?.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
assert.equal(field("API Server"), "https://im-test.deepminer.com.cn/api");
assert.ok(field("Bot Token")?.startsWith("bf_"));
const home = await mkdtemp(join(tmpdir(), "oh-log-"));
const previous = process.env.OCTO_RUNTIME_DEBUG;
process.env.OCTO_RUNTIME_DEBUG = "1";
const runtime = createDaemonRuntime({ appId: "hourly-live-test", home, development: true });
const sizes = [];
try {
  for (let round = 0; round < 2; round++) {
    await runtime.startAccount({
      subject: { type: "user", id: "hourly-live-test" },
      tenants: [{ id: "im-test" }]
    });
    await runtime.loadExtra({
      name: "log-output",
      module: resolve("test/fixtures/log-output-extra.js"),
      config: {}
    });
    await runtime.loadExtra({
      name: "channel-gateway",
      module: resolve("packages/octo-runtime-extra-channel-gateway/dist/extra.js"),
      config: {
        bots: [
          {
            bot_id: field("Bot ID"),
            bf_token: field("Bot Token"),
            api_url: field("API Server"),
            adapter: { adapter_type: "codex" },
            cards: false,
            typing: false,
            group_rules: false,
            allowed_sender_ids: ["hourly-qa-no-inbound"]
          }
        ]
      }
    });
    const status = await runtime.extraStatus("channel-gateway");
    assert.equal(status.bots[0].state, "online");
    await runtime.stop("account-switch");
    const account = (await readdir(join(home, "accounts")))[0];
    const logs = join(home, "accounts", account, "logs");
    const names = await readdir(logs);
    assert.ok(!names.includes("embedded-runtime.log"));
    const hourly = names.filter((name) => /^embedded-runtime-\d{8}T\d{2}\.log$/.test(name));
    assert.equal(hourly.length, 1);
    const path = join(logs, hourly[0]),
      text = await readFile(path, "utf8");
    assert.ok(text.includes("hourly-test-disposed"));
    assert.ok(!text.includes(field("Bot Token")));
    sizes.push((await stat(path)).size);
  }
  assert.ok(sizes[1] > sizes[0]);
  console.log(
    JSON.stringify({
      endpoint: "https://im-test.deepminer.com.cn",
      onlineRestarts: 2,
      files: 1,
      sizes,
      finalOutputDrained: true,
      credentialsLogged: false
    })
  );
} finally {
  await runtime.stop("quit");
  if (previous === undefined) delete process.env.OCTO_RUNTIME_DEBUG;
  else process.env.OCTO_RUNTIME_DEBUG = previous;
  await rm(home, { recursive: true, force: true });
}

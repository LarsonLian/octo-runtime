import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import load from "../packages/octo-runtime-extra-channel-gateway/dist/extra.js";

// Only the explicitly selected test account connects; other slots are disabled.
assert.ok(process.env.OCTO_CHANNEL_QA_ACCOUNTS, "Set protected QA account file path");
const blocks = (await readFile(process.env.OCTO_CHANNEL_QA_ACCOUNTS, "utf8"))
  .split(/(?=Bot Name:)/)
  .slice(1);
const block = blocks[Number(process.env.OCTO_CAPACITY_QA_INDEX ?? 3)];
const field = (key) => block?.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
const api = field("API Server");
assert.equal(api, "https://im-test.deepminer.com.cn/api");
const config = {
  bot_id: field("Bot ID"),
  bf_token: field("Bot Token"),
  api_url: api,
  adapter: { adapter_type: "codex" },
  cards: false,
  typing: false,
  allowed_sender_ids: ["capacity-qa-no-inbound"]
};
assert.ok(config.bf_token?.startsWith("bf_"));
const bots = [
  config,
  ...Array.from({ length: 63 }, (_, i) => ({
    bot_id: `disabled-capacity-${i}`,
    api_url: api,
    enabled: false,
    adapter: { adapter_type: "codex" }
  }))
];
let status, dispose;
try {
  await load(
    {
      signal: AbortSignal.timeout(30000),
      adapterHost: {},
      onStatus: (fn) => {
        status = fn;
      },
      onDispose: (fn) => {
        dispose = fn;
      }
    },
    { bots }
  );
  assert.deepEqual(status().errors, []);
  assert.equal(status().bots.length, 64);
  assert.equal(status().bots[0].state, "online");
  assert.equal(status().bots.filter((b) => b.state === "stopped").length, 63);
  console.log(JSON.stringify({ endpoint: api, slots: 64, online: 1, disabled: 63 }));
} finally {
  await dispose?.();
}
console.log("verified: Extra unload completed");

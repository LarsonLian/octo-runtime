import test from "node:test";
import assert from "node:assert/strict";
import { build_im_contexts } from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
import { acceptsImMessage } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/normalize.js";
const config = {
  bot_id: "bot",
  api_url: "https://im-test.deepminer.com.cn/api",
  spaceId: "s",
  adapter: { adapter_type: "codex" },
  group_ids: ["g"]
};
const incoming = (payload) => ({
  messageId: "m",
  messageSeq: 1,
  fromUid: "owner",
  channelId: "g",
  channelType: 2,
  timestamp: 0,
  payload
});
test("F04: resources preserve source and address without fetching or provider attachment conversion", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw Error("unexpected resource fetch");
  });
  for (const payload of [
    { type: 8, name: "test.pdf", url: "storage/test.pdf" },
    { type: 18, title: "doc", kind: "sheet", doc_id: "d", url: "https://example.invalid/docs/d" },
    {
      type: 1,
      content: "See https://example.invalid/drive/s/share and https://example.invalid/docs/d"
    }
  ]) {
    const [item] = await build_im_contexts(
      config,
      incoming(payload),
      "bf_fixture",
      new AbortController().signal
    );
    assert.equal(item.name, "resources");
    assert.equal(item.namespace, "extra.im");
    assert.match(item.guidance, /是否读取/);
    assert.ok(item.payload.text.includes(payload.url ?? "drive-link"));
    assert.equal(
      acceptsImMessage(config, "owner", incoming({ ...payload, mention: { uids: ["bot"] } })),
      true
    );
    assert.equal(acceptsImMessage(config, "owner", incoming(payload)), false);
  }
});
test("F04: missing addresses remain explicit, arbitrary objects and unsupported message types stay excluded", async () => {
  const [item] = await build_im_contexts(
    config,
    incoming({ type: 8, name: "missing" }),
    "bf_fixture",
    new AbortController().signal
  );
  assert.equal(item.payload.status, "missing_address");
  const empty = await build_im_contexts(
    config,
    incoming({ type: 1, content: "https://other.invalid/a.pdf" }),
    "bf_fixture",
    new AbortController().signal
  );
  assert.deepEqual(empty, []);
  assert.equal(
    acceptsImMessage(
      config,
      "owner",
      incoming({ type: 17, content: "card", mention: { uids: ["bot"] } })
    ),
    false
  );
});

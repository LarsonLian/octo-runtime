import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryImSessionStore } from "../packages/octo-runtime-channel-im/dist/index.js";

test("IM reset keeps pending bindings within one process and retries do not clear the next session", () => {
  const store = new MemoryImSessionStore();
  try {
    const old = {
      id: "first",
      generation: 1,
      providerSession: { adapterType: "codex", sessionId: "provider-old" }
    };
    store.save("tenant/bot/dm/user", old);
    store.save("other-bot/dm/user", old);
    store.remember("tenant/bot/dm/user", "message-1", {
      text: "hello",
      sessionId: "first",
      runId: "run-1"
    });
    assert.deepEqual(store.reset("tenant/bot/dm/user", "reset-1"), { generation: 2 });
    assert.deepEqual(store.read("tenant/bot/dm/user"), { generation: 2 });
    assert.deepEqual(store.read("other-bot/dm/user"), old);
    const next = { id: "next", generation: 2 };
    store.save("tenant/bot/dm/user", next);
    assert.deepEqual(store.reset("tenant/bot/dm/user", "reset-1"), next);
    assert.equal(store.occurrence("tenant/bot/dm/user", "message-1").sessionId, "first");
    assert.equal(store.occurrence("other-bot/dm/user", "message-1"), undefined);
  } finally {
    store.close();
  }
});

test("IM mappings bound count, bytes and lifetime and disappear on close", t => {
  const store = new MemoryImSessionStore();
  t.after(() => store.close());
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  for (let index = 0; index <= 1024; index++) store.save(String(index), { id: String(index), generation: 1 });
  assert.equal(store.read("0"), undefined);
  assert.equal(store.read("1024").id, "1024");
  for (let index = 0; index < 100; index++) store.remember("scope", String(index), {
    text: "x".repeat(256 << 10), sessionId: "s", runId: "r"
  });
  assert.equal(store.occurrence("scope", "0"), undefined);
  const saved = store.occurrence("scope", "99");
  saved.text = "mutated";
  assert.notEqual(store.occurrence("scope", "99").text, "mutated");
  now += 120_000;
  assert.equal(store.occurrence("scope", "99"), undefined);
  now += 24 * 60 * 60_000;
  assert.equal(store.read("1024"), undefined);
  store.save("fresh", { id: "provider-old", generation: 1 });
  store.close();
  assert.equal(store.read("fresh"), undefined);
  const restarted = new MemoryImSessionStore();
  assert.equal(restarted.read("fresh"), undefined);
  restarted.close();
});

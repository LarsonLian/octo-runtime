import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteImSessionStore } from "../packages/octo-harness-channel-im/dist/index.js";

test("IM reset persists pending bindings and retries do not clear the next session", () => {
  const root = mkdtempSync(join(tmpdir(), "im-reset-")),
    path = join(root, "sessions.db");
  let store = new SqliteImSessionStore(path);
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
    store.close();
    store = new SqliteImSessionStore(path);
    assert.deepEqual(store.read("tenant/bot/dm/user"), { generation: 2 });
    assert.deepEqual(store.read("other-bot/dm/user"), old);
    const next = { id: "next", generation: 2 };
    store.save("tenant/bot/dm/user", next);
    assert.deepEqual(store.reset("tenant/bot/dm/user", "reset-1"), next);
    assert.equal(store.occurrence("tenant/bot/dm/user", "message-1").sessionId, "first");
    assert.equal(store.occurrence("other-bot/dm/user", "message-1"), undefined);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

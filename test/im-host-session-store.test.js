import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ExtraPlugins, createDaemonRuntime } from "../packages/octo-runtime-daemon/dist/index.js";
import * as gateway from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
import * as gatewayModule from "@mininglamp-oss/octo-runtime/extras/channel-gateway";
import { GatewayTransport } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/channel.js";
import { HostSessionStore } from "../packages/octo-runtime-extra-channel-gateway/dist/application/host-session-store.js";
import { prepareInvokeInput } from "../packages/octo-runtime-executor-core/dist/invoke-input.js";
import { deferred, waitFor } from "./runtime-fixture.js";

const bot = (id = "bot", scope = "org/assistant/user") => ({
  bot_id: id,
  api_url: "https://example.com/api",
  scope,
  adapter: { adapter_type: "test", workdir: process.cwd() }
});
const canonical = (type, payload = {}) => ({ protocolVersion: 2, type, payload });
function fixture(t, host) {
  const connections = new Map();
  t.mock.method(GatewayTransport.prototype, "start", async function () {
    connections.set(this.config.bot_id, this.callbacks);
  });
  t.mock.method(GatewayTransport.prototype, "close", async () => {});
  const requests = [],
    replies = [],
    logs = [];
  const extras = new ExtraPlugins(
    [],
    host ?? {
      async *invoke(input) {
        const request = prepareInvokeInput(input).request;
        requests.push(request);
        yield canonical("session.update", {
          providerSession: { adapterType: "test", sessionId: `provider:${request.agentSessionId}` }
        });
        yield canonical("run.completed");
      },
      async cancel() {
        return { cancelled: true };
      }
    },
    () =>
      (...args) =>
        logs.push(args)
  );
  t.after(() => extras.close().catch(() => undefined));
  return {
    extras,
    requests,
    replies,
    logs,
    send(id, { botId = "bot", conversationId = "chat", text = "hello", ...options } = {}) {
      connections.get(botId).onMessage({
        messageId: id,
        senderId: "sender",
        conversationId,
        conversationKind: "direct",
        text,
        buildContext: async () => ({ schema: "octo.context-envelope/v3", items: [] }),
        reply: async (value) => {
          replies.push(value);
        },
        ...options
      });
    }
  };
}

// 只用于验收的真实 SQLite 实现。数据库归宿主，工厂每次返回独立且可撤销的句柄。
// 表中分开存 binding/control/occurrence，所有操作按宿主可信 scope 分区。
function sqliteHost(path) {
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE IF NOT EXISTS entries (scope TEXT, kind TEXT, key TEXT, value TEXT, PRIMARY KEY(scope,kind,key))"
  );
  const get = db.prepare("SELECT value FROM entries WHERE scope=? AND kind=? AND key=?");
  const put = db.prepare("INSERT OR REPLACE INTO entries VALUES (?,?,?,?)");
  const counts = new Map();
  const handles = [];
  return {
    db,
    handles,
    counts,
    factory(config) {
      const scope = JSON.stringify([config.scope, config.bot_id]);
      let closed = false;
      const access = (method) => {
        assert.equal(closed, false, "closed handle accessed");
        counts.set(method, (counts.get(method) ?? 0) + 1);
      };
      const read = (kind, key) => {
        const row = get.get(scope, kind, key);
        return row ? JSON.parse(row.value) : undefined;
      };
      const save = (kind, key, value) => put.run(scope, kind, key, JSON.stringify(value));
      const store = {
        read(key) {
          access("read");
          return read("binding", key);
        },
        save(key, value) {
          access("save");
          save("binding", key, value);
        },
        reset(key, id) {
          access("reset");
          db.exec("BEGIN IMMEDIATE");
          try {
            const current = read("binding", key);
            if (read("control", JSON.stringify([key, id]))) {
              db.exec("COMMIT");
              return current;
            }
            const next = { generation: (current?.generation ?? 1) + 1 };
            save("binding", key, next);
            save("control", JSON.stringify([key, id]), true);
            db.exec("COMMIT");
            return next;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        },
        occurrence(key, id) {
          access("occurrence");
          return read("occurrence", JSON.stringify([key, id]));
        },
        remember(key, id, value) {
          access("remember");
          save("occurrence", JSON.stringify([key, id]), value);
        },
        patchGap(key, identity, update) {
          access("patchGap");
          const binding = read("binding", key);
          if (
            !binding ||
            binding.id !== identity.sessionId ||
            binding.generation !== identity.generation
          )
            return false;
          binding.gap = update(binding.gap);
          save("binding", key, binding);
          return true;
        },
        close() {
          assert.equal(closed, false);
          closed = true;
          counts.set("close", (counts.get("close") ?? 0) + 1);
        }
      };
      handles.push(store);
      return store;
    }
  };
}

test("Gateway: real Extra restores logical and Provider sessions after SQLite close/reopen and isolates scopes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "im-host-sqlite-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "host.db");
  const f = fixture(t);
  let host = sqliteHost(path);
  let calls = 0;
  const load = async (scope = "org/assistant/user") =>
    f.extras.load(
      gatewayModule,
      { bots: [bot("bot", scope), bot("other", scope)] },
      {
        createSessionStore(config) {
          calls++;
          assert.equal(config.scope, scope);
          return host.factory(config);
        }
      }
    );
  const send = async (id, options) => {
    const previous = f.replies.length;
    f.send(id, options);
    await waitFor(() => f.replies.length > previous);
  };
  await load();
  await send("one");
  const first = f.requests.at(-1);
  await send("other-bot", { botId: "other" });
  assert.notEqual(f.requests.at(-1).agentSessionId, first.agentSessionId);
  await send("other-chat", { conversationId: "other-chat" });
  const otherChatSession = f.requests.at(-1).agentSessionId;
  assert.notEqual(otherChatSession, first.agentSessionId);
  await f.extras.unload(gateway.name);
  assert.equal(host.counts.get("close"), 2);
  assert.equal(
    host.db.prepare("SELECT count(*) AS n FROM entries").get().n > 0,
    true,
    "handle close leaves host database usable"
  );
  host.db.close();
  host = sqliteHost(path);
  await load();
  await send("two");
  assert.equal(f.requests.at(-1).agentSessionId, first.agentSessionId);
  assert.equal(f.requests.at(-1).providerSession.sessionId, `provider:${first.agentSessionId}`);
  const count = f.requests.length;
  await send("one");
  assert.equal(f.requests.length, count, "persisted occurrence prevents execution duplication");
  await send("reset", { text: "/reset" });
  await send("after-reset");
  const resetSession = f.requests.at(-1).agentSessionId;
  assert.notEqual(resetSession, first.agentSessionId);
  assert.equal(f.requests.at(-1).providerSession, undefined);
  await f.extras.unload(gateway.name);
  await load();
  await send("reset", { text: "/reset" });
  await send("reset-idempotent");
  assert.equal(f.requests.at(-1).agentSessionId, resetSession);
  const binding = host.db
    .prepare("SELECT value FROM entries WHERE kind='binding'")
    .all()
    .map((row) => JSON.parse(row.value))
    .find((value) => value.id === resetSession);
  assert.equal(binding.generation, 2);
  await send("other-chat-preserved", { conversationId: "other-chat" });
  assert.equal(
    f.requests.at(-1).agentSessionId,
    otherChatSession,
    "reset must leave other chats unchanged"
  );
  for (const method of ["read", "save", "reset", "occurrence", "remember"])
    assert.ok(host.counts.get(method), method);
  await f.extras.unload(gateway.name);
  for (const scope of [
    "other-org/assistant/user",
    "org/other-assistant/user",
    "org/assistant/other-user"
  ]) {
    await load(scope);
    await send(`new-scope:${scope}`);
    assert.notEqual(f.requests.at(-1).agentSessionId, resetSession);
    await f.extras.unload(gateway.name);
  }
  await load("org/assistant/user");
  await send("original-scope");
  assert.equal(f.requests.at(-1).agentSessionId, resetSession);
  await f.extras.unload(gateway.name);
  host.db.close();
  assert.equal(calls, 14);
});

test("Gateway: factory receives validated independent config and disabled Bots allocate no host handle", async (t) => {
  const f = fixture(t);
  const original = bot();
  const configs = [];
  let closes = 0;
  await f.extras.load(
    gateway,
    {
      bots: [
        original,
        { ...bot("disabled"), enabled: false },
        { ...bot("invalid"), api_url: "bad" }
      ]
    },
    {
      createSessionStore(config) {
        configs.push(config);
        config.bot_id = "mutated";
        const store = new gateway.MemoryImSessionStore();
        const close = store.close.bind(store);
        store.close = () => {
          closes++;
          close();
        };
        return store;
      }
    }
  );
  assert.equal(configs.length, 1);
  assert.equal(original.bot_id, "bot");
  assert.ok((await f.extras.inspect(gateway.name)).bots.some((value) => value.bot_name === "bot"));
  await f.extras.unload(gateway.name);
  assert.equal(closes, 1);
});

for (const mode of ["throw", "invalid", "read-failed"]) {
  test(`Gateway: ${mode} host store failure is observable and never falls back to Memory`, async (t) => {
    const f = fixture(t);
    let closed = 0;
    const store = new gateway.MemoryImSessionStore();
    t.after(() => store.close());
    await f.extras.load(
      gatewayModule,
      { bots: [bot()] },
      {
        createSessionStore() {
          if (mode === "throw") throw new Error("IM_HOST_STORE_UNAVAILABLE");
          if (mode === "invalid")
            return {
              close() {
                closed++;
              }
            };
          store.read = () => {
            throw new Error("private database failure");
          };
          return store;
        }
      }
    );
    if (mode === "read-failed") {
      f.send("failure");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(f.requests.length, 0);
      assert.ok(
        f.logs.some(
          ([, event, data]) =>
            event === "channel.diagnostic" && data.code === "IM_SESSION_STORE_FAILED"
        )
      );
      assert.doesNotMatch(JSON.stringify(f.logs), /private database failure/);
    } else {
      const status = await f.extras.inspect(gateway.name);
      assert.match(status.errors[0].error, /IM_(HOST_STORE_UNAVAILABLE|SESSION_STORE_INVALID)/);
      assert.equal(closed, mode === "invalid" ? 1 : 0);
    }
    await f.extras.unload(gateway.name);
    assert.equal(f.requests.length, 0);
  });
}

test("Gateway: remove/upsert release factory handles once after the old Runtime and preserve borrowed stores", async (t) => {
  fixture(t);
  const order = [];
  const manager = new gateway.ImChannelManager({
    host: {},
    createSessionStore(config) {
      order.push(`create:${config.bot_id}`);
      const store = new gateway.MemoryImSessionStore();
      const close = store.close.bind(store);
      store.close = async () => {
        await Promise.resolve();
        order.push(`close:${config.bot_id}`);
        close();
      };
      return store;
    }
  });
  await manager.upsert(bot());
  await manager.upsert(bot());
  assert.deepEqual(order, ["create:bot", "close:bot", "create:bot"]);
  await manager.remove(gateway.imBotIdentity(bot()));
  await manager.close();
  assert.equal(order.filter((value) => value === "close:bot").length, 2);
  const borrowed = new gateway.MemoryImSessionStore();
  const spy = t.mock.method(borrowed, "close");
  const runtime = new gateway.ImRuntime(bot(), { host: {}, sessions: borrowed });
  await runtime.start();
  await runtime.close();
  assert.equal(spy.mock.callCount(), 0);
  spy.mock.restore();
  borrowed.close();
});

test("Gateway: failed initialization closes its handle and permits a clean retry", async (t) => {
  fixture(t);
  let closes = 0;
  const starting = t.mock.method(gateway.ImRuntime.prototype, "start", async () => {
    throw new Error("IM_START_FAILED");
  });
  const manager = new gateway.ImChannelManager({
    host: {},
    createSessionStore() {
      const store = new gateway.MemoryImSessionStore();
      const close = store.close.bind(store);
      store.close = () => {
        closes++;
        close();
      };
      return store;
    }
  });
  await assert.rejects(manager.upsert(bot()), /IM_START_FAILED/);
  assert.equal(closes, 1);
  starting.mock.restore();
  await manager.upsert(bot());
  await manager.close();
  assert.equal(closes, 2);
});

test("Gateway: Extra unload reports handle release failure and rejects reload", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const dependencies = {
    createSessionStore() {
      calls++;
      const store = new gateway.MemoryImSessionStore();
      const close = store.close.bind(store);
      store.close = () => {
        close();
        throw new Error("private database failure");
      };
      return store;
    }
  };
  await f.extras.load(gatewayModule, { bots: [bot()] }, dependencies);
  await assert.rejects(f.extras.unload(gateway.name), /EXTRA_DISPOSE_FAILED/);
  assert.equal(f.extras.status[gateway.name].error, "EXTRA_DISPOSE_FAILED");
  await assert.rejects(
    f.extras.load(gatewayModule, { bots: [bot()] }, dependencies),
    /EXTRA_ALREADY_LOADED/
  );
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(f.extras.status), /private database failure/);
});

test("Gateway: invalid factory is rejected before Bot initialization", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.extras.load(gatewayModule, { bots: [bot()] }, { createSessionStore: true }),
    /IM_SESSION_STORE_FACTORY_INVALID/
  );
  assert.equal(f.requests.length, 0);
});

test("Gateway: initialization exception releases the acquired handle and close failure blocks replacement", async (t) => {
  fixture(t);
  let factories = 0,
    closes = 0;
  const manager = new gateway.ImChannelManager({
    host: {},
    createSessionStore() {
      factories++;
      const store = new gateway.MemoryImSessionStore();
      const close = store.close.bind(store);
      store.close = () => {
        closes++;
        close();
        throw new Error("private close failure");
      };
      return store;
    }
  });
  t.mock.method(gateway.ImRuntime.prototype, "start", async () => {
    throw new Error("IM_START_FAILED");
  });
  await assert.rejects(manager.upsert(bot()), /IM_DISPOSE_FAILED/);
  await assert.rejects(manager.upsert(bot()), /IM_DISPOSE_FAILED/);
  await assert.rejects(manager.remove(gateway.imBotIdentity(bot())), /IM_DISPOSE_FAILED/);
  await assert.rejects(manager.close(), /IM_DISPOSE_FAILED/);
  assert.equal(factories, 1);
  assert.equal(closes, 1);
});

test("Gateway: draining saves a late Provider binding before closing and suppresses presentation/delivery", async (t) => {
  const release = deferred();
  let started = false,
    closed = 0,
    store,
    cancelled = 0,
    updates = 0,
    finishes = 0;
  const f = fixture(t, {
    async *invoke() {
      started = true;
      await release.promise;
      yield canonical("session.update", { providerSession: { sessionId: "late-provider" } });
      yield canonical("run.completed");
    },
    async cancel() {
      cancelled++;
      return { cancelled: true };
    }
  });
  let binding;
  await f.extras.load(
    gateway,
    { bots: [bot()] },
    {
      createSessionStore() {
        store = new gateway.MemoryImSessionStore();
        const save = store.save.bind(store),
          close = store.close.bind(store);
        store.save = (key, value) => {
          binding = structuredClone(value);
          save(key, value);
        };
        store.close = () => {
          closed++;
          assert.equal(binding.providerSession.sessionId, "late-provider");
          close();
        };
        return store;
      }
    }
  );
  f.send("active", {
    beginPresentation() {
      return {
        update() {
          updates++;
        },
        async finish() {
          finishes++;
        }
      };
    }
  });
  await waitFor(() => started);
  const beforeDrain = updates;
  const closing = f.extras.unload(gateway.name);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 0);
  release.resolve();
  await closing;
  assert.equal(closed, 1);
  assert.equal(f.replies.length, 0);
  assert.equal(updates, beforeDrain, "draining must not project unknown-result or progress");
  assert.equal(
    finishes,
    0,
    "presentation.finish can flush messages and must not run after shutdown"
  );
  assert.equal(cancelled, 1, "normal draining must not issue a second cancellation");
  assert.ok(!f.logs.some(([, , data]) => data.code === "IM_EXECUTION_RESULT_UNKNOWN"));
});

test("Gateway: reset rejects a previous generation's late Provider update", async (t) => {
  const release = deferred();
  let started = false,
    store;
  const f = fixture(t, {
    async *invoke() {
      started = true;
      await release.promise;
      yield canonical("session.update", { providerSession: { sessionId: "obsolete" } });
      yield canonical("run.completed");
    },
    async cancel() {
      return { cancelled: true };
    }
  });
  await f.extras.load(
    gateway,
    { bots: [bot()] },
    {
      createSessionStore() {
        return (store = new gateway.MemoryImSessionStore());
      }
    }
  );
  f.send("old");
  await waitFor(() => started);
  f.send("reset", { text: "/reset" });
  await waitFor(() => f.replies.length === 1);
  release.resolve();
  await waitFor(() => f.replies.length === 2);
  const key = [gateway.imBotIdentity(bot()), gateway.imBotIdentity(bot()), "test", "direct", "chat"]
    .map(encodeURIComponent)
    .join("/");
  assert.deepEqual(store.read(key), { generation: 2 });
  await f.extras.unload(gateway.name);
});

test("Gateway: lease forwards optional gap operations and rejects every operation after close", async () => {
  const source = new gateway.MemoryImSessionStore();
  const lease = new HostSessionStore(source);
  lease.validate();
  const sessions = lease.sessions;
  sessions.save("chat", { id: "s", generation: 1 });
  let called = 0;
  assert.equal(
    sessions.patchGap("chat", { sessionId: "s", generation: 1 }, () => {
      called++;
      return { revision: 1 };
    }),
    true
  );
  assert.equal(called, 1);
  const closing = lease.close();
  assert.equal(lease.close(), closing);
  await closing;
  for (const operation of [
    () => sessions.read("chat"),
    () => sessions.save("chat", {}),
    () => sessions.reset("chat", "r"),
    () => sessions.occurrence("chat", "m"),
    () => sessions.remember("chat", "m", {}),
    () => sessions.patchGap("chat", {}, () => ({}))
  ])
    assert.throws(operation, /IM_SESSION_STORE_CLOSED/);
});

test(
  "Gateway: cleanup timeout revokes late storage access and prevents replacement",
  { timeout: 8000 },
  async (t) => {
    fixture(t);
    const pending = deferred();
    let factories = 0,
      injected;
    t.mock.method(gateway.ImRuntime.prototype, "close", function () {
      injected = this.dependencies.sessions;
      return pending.promise;
    });
    const manager = new gateway.ImChannelManager({
      host: {},
      createSessionStore() {
        factories++;
        return new gateway.MemoryImSessionStore();
      }
    });
    await manager.upsert(bot());
    await assert.rejects(manager.upsert(bot()), /IM_DISPOSE_FAILED/);
    assert.throws(() => injected.read("late"), /IM_SESSION_STORE_CLOSED/);
    await assert.rejects(manager.upsert(bot()), /IM_DISPOSE_FAILED/);
    assert.equal(factories, 1);
    pending.resolve();
    await assert.rejects(manager.close(), /IM_DISPOSE_FAILED/);
  }
);

test(
  "Gateway: SDK public three-argument entrypoint releases handles on account switch and stop",
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t);
    const home = await mkdtemp(join(tmpdir(), "im-host-sdk-"));
    const runtime = createDaemonRuntime({
      appId: "im-host-store-test",
      home,
      distribution: {
        adapterHostEntrypoint: fileURLToPath(
          new URL("./fixtures/sdk-extra-host.js", import.meta.url)
        )
      },
      healthPollIntervalMs: 20
    });
    t.after(async () => {
      await runtime.stop().catch(() => undefined);
      await rm(home, { recursive: true, force: true });
    });
    const account = (id) => ({ subject: { type: "user", id }, tenants: [{ id: "space" }] });
    let closes = 0;
    const dependencies = {
      createSessionStore() {
        const store = new gateway.MemoryImSessionStore();
        const close = store.close.bind(store);
        store.close = async () => {
          closes++;
          close();
        };
        return store;
      }
    };
    await runtime.startAccount(account("first"));
    await runtime.loadExtra(gatewayModule, { bots: [bot()] }, dependencies);
    f.send("sdk-message");
    await waitFor(() => f.replies.length > 0);
    await runtime.startAccount(account("second"));
    assert.equal(closes, 1);
    await runtime.loadExtra(gatewayModule, { bots: [bot()] }, dependencies);
    await runtime.stop("quit");
    assert.equal(closes, 2);
  }
);

test("Gateway: host factory contracts compile from the package public entry without assertions", async () => {
  const source = new URL("./fixtures/host-session-store-types.ts", import.meta.url);
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--types",
      "node",
      "--skipLibCheck",
      "false",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      fileURLToPath(source)
    ],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const operation of ["save", "remember", "patchGap"]) {
  test(`Gateway: draining ${operation} failure makes unload fail and blocks reload`, async (t) => {
    const release = deferred();
    let started = false,
      fail = false,
      closes = 0;
    const f = fixture(t, {
      async *invoke() {
        started = true;
        await release.promise;
        yield canonical("session.update", {
          providerSession: { sessionId: "late", resumeOutcome: "fresh_fallback" }
        });
        yield canonical("run.completed");
      },
      async cancel() {
        return { cancelled: true };
      }
    });
    const dependencies = {
      createSessionStore() {
        const store = new gateway.MemoryImSessionStore();
        const original = store[operation].bind(store),
          close = store.close.bind(store);
        store[operation] = (...args) => {
          if (fail) throw new Error("private drain database failure");
          return original(...args);
        };
        store.close = () => {
          closes++;
          close();
        };
        return store;
      }
    };
    await f.extras.load(gatewayModule, { bots: [bot()] }, dependencies);
    f.send("active");
    await waitFor(() => started);
    const closing = f.extras.unload(gateway.name);
    const rejected = assert.rejects(closing, /EXTRA_DISPOSE_FAILED/);
    fail = true;
    release.resolve();
    await rejected;
    assert.equal(closes, 1, "write failure must not prevent handle release attempt");
    assert.equal(f.extras.status[gateway.name].error, "EXTRA_DISPOSE_FAILED");
    await assert.rejects(
      f.extras.load(gatewayModule, { bots: [bot()] }, dependencies),
      /EXTRA_ALREADY_LOADED/
    );
    assert.doesNotMatch(JSON.stringify(f.extras.status), /private drain database failure/);
  });
}

test(
  "Gateway: owner abort revokes a store even when initialization never exits",
  { timeout: 8000 },
  async (t) => {
    const f = fixture(t);
    const release = deferred();
    let injected,
      closed = 0;
    t.mock.method(gateway.ImRuntime.prototype, "start", function () {
      injected = this.dependencies.sessions;
      return release.promise;
    });
    t.mock.method(gateway.ImRuntime.prototype, "close", () => release.promise);
    const loading = f.extras
      .load(
        gatewayModule,
        { bots: [bot()] },
        {
          createSessionStore() {
            const store = new gateway.MemoryImSessionStore();
            const close = store.close.bind(store);
            store.close = () => {
              closed++;
              close();
            };
            return store;
          }
        }
      )
      .catch((error) => error);
    await waitFor(() => injected);
    try {
      await assert.rejects(f.extras.unload(gateway.name), /EXTRA_DISPOSE_FAILED/);
      assert.throws(() => injected.read("late"), /IM_SESSION_STORE_CLOSED/);
      assert.equal(closed, 0, "timeout cannot claim the host handle was released");
    } finally {
      release.resolve();
      await loading;
    }
    await waitFor(() => closed === 1);
    await assert.rejects(
      f.extras.load(gatewayModule, { bots: [bot()] }, {}),
      /EXTRA_ALREADY_LOADED/
    );
  }
);

import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createServer } from "node:http";
import { once } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { WebSocketServer } from "ws";
import load from "../packages/octo-runtime-extra-channel-gateway/dist/extra.js";
import { ImRuntime } from "../packages/octo-runtime-extra-channel-gateway/dist/application/im-channel.js";
import { GatewayTransport } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/channel.js";
import { ImConnectionError } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/connection-error.js";
import {
  WukongConnection,
  registerBot
} from "../packages/octo-runtime-extra-channel-gateway/dist/transport/wukong.js";
import { verifyBotIdentity } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/auth.js";

const bot = (patch = {}) => ({
  bot_id: "state-machine-bot",
  api_url: "https://im-test.deepminer.com.cn/api",
  bf_token: "bf_fixture",
  adapter: { adapter_type: "codex", workdir: process.cwd() },
  ...patch
});
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function snapshot(runtime, state, error = null) {
  assert.equal(runtime.status.state, state);
  assert.equal(runtime.status.connected, state === "online");
  assert.equal(runtime.status.error, error);
}
function fixture(t, options = {}) {
  const attempts = [],
    closed = [],
    diagnostics = [];
  let behavior = async () => {};
  t.mock.method(GatewayTransport.prototype, "start", async function (signal) {
    attempts.push(this);
    await behavior(this, signal);
  });
  t.mock.method(GatewayTransport.prototype, "close", async function () {
    closed.push(this);
    await options.cleanup?.(this);
  });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  const runtime = new ImRuntime(bot(options.config), {
    host: {},
    signal: options.signal,
    onDiagnostic: (code) => diagnostics.push(code)
  });
  t.after(() => runtime.close().catch(() => {}));
  return {
    runtime,
    attempts,
    closed,
    diagnostics,
    behavior(value) {
      behavior = value;
    },
    async tick(ms) {
      t.mock.timers.tick(ms);
      await settle();
    },
    drop(code = "IM_DISCONNECTED", retryable = true) {
      attempts.at(-1).callbacks.onDisconnect(code, retryable);
    }
  };
}

for (const code of [
  "IM_CREDENTIALS_REQUIRED",
  "IM_AUTH_HTTP_401",
  "IM_REGISTER_HTTP_409",
  "IM_CONNECT_REJECTED_2",
  "IM_CONNECT_TIMEOUT"
]) {
  test(`initial failure ${code} is terminal, including transient failures`, async (t) => {
    const f = fixture(t);
    f.behavior(async () => {
      throw new ImConnectionError(code, true);
    });
    await f.runtime.start();
    snapshot(f.runtime, "failed", code);
    await f.tick(300_000);
    assert.equal(f.attempts.length, 1);
    await f.runtime.close();
    snapshot(f.runtime, "stopped");
  });
}

test("recovery stays retrying, uses 5/10/20/30/30 seconds, and resets after each success", async (t) => {
  const f = fixture(t);
  await f.runtime.start();
  snapshot(f.runtime, "online");
  for (let cycle = 0; cycle < 2; cycle++) {
    f.behavior(async () => {
      throw new ImConnectionError("IM_REGISTER_HTTP_503", true);
    });
    f.drop();
    snapshot(f.runtime, "retrying", "IM_DISCONNECTED");
    await settle();
    for (const delay of [5000, 10000, 20000, 30000, 30000]) {
      const before = f.attempts.length;
      await f.tick(delay - 1);
      assert.equal(f.attempts.length, before);
      await f.tick(1);
      assert.equal(f.attempts.length, before + 1);
      snapshot(f.runtime, "retrying", "IM_REGISTER_HTTP_503");
    }
    let release;
    f.behavior(
      async () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    await f.tick(30000);
    snapshot(f.runtime, "retrying", "IM_REGISTER_HTTP_503");
    release();
    await settle();
    snapshot(f.runtime, "online");
  }
});

test("explicit restart retries a failed first attempt, concurrent starts do not duplicate", async (t) => {
  const f = fixture(t);
  f.behavior(async () => {
    throw new Error("IM_CREDENTIALS_REQUIRED");
  });
  await f.runtime.start();
  snapshot(f.runtime, "failed", "IM_CREDENTIALS_REQUIRED");
  let release;
  f.behavior(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const first = f.runtime.start(),
    second = f.runtime.start();
  await settle();
  snapshot(f.runtime, "connecting");
  assert.equal(f.attempts.length, 2);
  release();
  await Promise.all([first, second]);
  snapshot(f.runtime, "online");
});

test("a disconnect during the first handshake cannot be overwritten by late success", async (t) => {
  const f = fixture(t);
  f.behavior(async (transport) => {
    transport.callbacks.onDisconnect("IM_DISCONNECTED", true);
  });
  await f.runtime.start();
  snapshot(f.runtime, "failed", "IM_DISCONNECTED");
  await f.tick(30000);
  assert.equal(f.attempts.length, 1);
});

test("terminal disconnects and unknown protocol failures stop recovery", async (t) => {
  const f = fixture(t);
  await f.runtime.start();
  f.drop("IM_SERVER_DISCONNECTED_12", false);
  snapshot(f.runtime, "failed", "IM_SERVER_DISCONNECTED_12");
  await settle();
  await f.tick(30000);
  assert.equal(f.attempts.length, 1);
  await f.runtime.start();
  f.behavior(async () => {
    throw new Error("IM_FRAME_TRUNCATED");
  });
  f.drop();
  await settle();
  await f.tick(5000);
  snapshot(f.runtime, "failed", "IM_FRAME_TRUNCATED");
  const count = f.attempts.length;
  await f.tick(30000);
  assert.equal(f.attempts.length, count);
});

test("stop cancels waiting recovery and stale messages/diagnostics cannot change its state", async (t) => {
  const f = fixture(t);
  await f.runtime.start();
  const old = f.attempts[0];
  old.callbacks.onDiagnostic("IM_CARD_ACTION_POLL_FAILED");
  snapshot(f.runtime, "online");
  f.drop();
  f.drop();
  await settle();
  await f.runtime.close();
  old.callbacks.onDisconnect("IM_DISCONNECTED");
  old.callbacks.onDiagnostic("IM_DELIVERY_FAILED");
  await f.tick(30000);
  snapshot(f.runtime, "stopped");
  assert.equal(f.attempts.length, 1);
});

test("owner abort stops pending startup even if a transport returns late success", async (t) => {
  const controller = new AbortController();
  const f = fixture(t, { signal: controller.signal });
  let release;
  f.behavior(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const starting = f.runtime.start();
  await settle();
  controller.abort();
  snapshot(f.runtime, "stopped");
  release();
  await starting;
  await f.runtime.close();
  await f.tick(30000);
  snapshot(f.runtime, "stopped");
  assert.equal(f.attempts.length, 1);
});

test("recovery cleanup must finish before the first backoff begins", async (t) => {
  let release,
    blocking = false;
  const f = fixture(t, {
    cleanup: () =>
      blocking
        ? new Promise((resolve) => {
            release = resolve;
          })
        : undefined
  });
  await f.runtime.start();
  blocking = true;
  f.drop();
  await settle();
  await f.tick(30000);
  snapshot(f.runtime, "retrying", "IM_DISCONNECTED");
  assert.equal(f.attempts.length, 1);
  blocking = false;
  release();
  await settle();
  await f.tick(4999);
  assert.equal(f.attempts.length, 1);
  await f.tick(1);
  snapshot(f.runtime, "online");
});

test("cleanup failure stops recovery and does not overlap connections", async (t) => {
  let broken = false;
  const f = fixture(t, {
    cleanup: () => {
      if (broken) throw Error("private cleanup error");
    }
  });
  await f.runtime.start();
  broken = true;
  f.drop();
  await settle();
  snapshot(f.runtime, "failed", "IM_DISCONNECTED");
  assert.ok(f.diagnostics.includes("IM_DISPOSE_FAILED"));
  await f.tick(30000);
  assert.equal(f.attempts.length, 1);
});

test("Retry-After can extend the wait without advancing the backoff twice", async (t) => {
  const f = fixture(t);
  await f.runtime.start();
  f.behavior(async () => {
    throw new ImConnectionError("IM_REGISTER_HTTP_429", true, 45000);
  });
  f.drop();
  await settle();
  await f.tick(5000);
  const count = f.attempts.length;
  await f.tick(44999);
  assert.equal(f.attempts.length, count);
  f.behavior(async () => {});
  await f.tick(1);
  snapshot(f.runtime, "online");
});

test("Extra status keeps per-Bot startup failures visible and isolates healthy/disabled Bots", async (t) => {
  let status, dispose;
  t.mock.method(GatewayTransport.prototype, "start", async function () {
    if (this.config.bot_id === "bad") throw new Error("IM_CREDENTIALS_REQUIRED");
  });
  t.mock.method(GatewayTransport.prototype, "close", async () => {});
  await load(
    {
      signal: new AbortController().signal,
      adapterHost: {},
      onStatus: (fn) => {
        status = fn;
      },
      onDispose: (fn) => {
        dispose = fn;
      }
    },
    { bots: [bot({ bot_id: "bad" }), bot({ bot_id: "good" }), bot({ enabled: false })] }
  );
  t.after(dispose);
  assert.deepEqual(
    status().bots.map((b) => [b.state, b.error, b.connected]),
    [
      ["failed", "IM_CREDENTIALS_REQUIRED", false],
      ["online", null, true],
      ["stopped", null, false]
    ]
  );
});

test("long waits and a delayed wake never overflow timers or replay missed attempts", async (t) => {
  const f = fixture(t);
  await f.runtime.start();
  f.behavior(async () => {
    throw new ImConnectionError("IM_AUTH_HTTP_429", true, 2_147_483_647 + 60000);
  });
  f.drop();
  await settle();
  await f.tick(5000);
  assert.equal(f.attempts.length, 2);
  await f.tick(2_147_483_647);
  assert.equal(f.attempts.length, 2);
  await f.tick(59999);
  assert.equal(f.attempts.length, 2);
  f.behavior(async () => {
    throw new ImConnectionError("IM_AUTH_NETWORK_ERROR", true);
  });
  await f.tick(1);
  assert.equal(f.attempts.length, 3);
  await f.tick(600000);
  assert.equal(f.attempts.length, 4);
  snapshot(f.runtime, "retrying", "IM_AUTH_NETWORK_ERROR");
  await f.tick(29999);
  assert.equal(f.attempts.length, 4);
  await f.tick(1);
  assert.equal(f.attempts.length, 5);
});

test("stopping an in-flight recovery suppresses its late result and old callbacks after restart", async (t) => {
  const f = fixture(t);
  await f.runtime.start();
  let release;
  f.behavior(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  f.drop();
  await settle();
  await f.tick(5000);
  const old = f.attempts.at(-1);
  const closing = f.runtime.close();
  snapshot(f.runtime, "stopped");
  release();
  await closing;
  f.behavior(async () => {});
  await f.runtime.start();
  old.callbacks.onDisconnect("IM_SERVER_DISCONNECTED_12", false);
  old.callbacks.onDiagnostic("IM_DELIVERY_FAILED");
  snapshot(f.runtime, "online");
  await f.tick(60000);
  assert.equal(f.attempts.length, 3);
});

async function server(t) {
  let status = 200;
  const http = createServer((_req, res) => {
    res.writeHead(status);
    res.end("private response bf_secret");
  });
  const ws = new WebSocketServer({ server: http });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(async () => {
    for (const peer of ws.clients) peer.terminate();
    ws.close();
    await new Promise((r) => http.close(r));
  });
  const port = http.address().port;
  return {
    http,
    ws,
    url: `http://127.0.0.1:${port}`,
    registration: { robot_id: "bot", im_token: "secret", ws_url: `ws://127.0.0.1:${port}` },
    status: (value) => {
      status = value;
    }
  };
}
function string(value) {
  const bytes = Buffer.from(value),
    length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}
function handshake() {
  const key = generateKeyPairSync("x25519")
    .publicKey.export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64");
  const body = Buffer.concat([
    Buffer.alloc(8),
    Buffer.from([1]),
    string(key),
    string("0123456789abcdef")
  ]);
  return Buffer.concat([Buffer.from([0x20, body.length]), body]);
}

test("real WS protocol preserves kick reason and cannot report a closed socket as connected", async (t) => {
  const s = await server(t);
  const disconnected = [];
  const client = new WukongConnection(
    () => {},
    (error) => disconnected.push(error)
  );
  t.after(() => client.close());
  s.ws.on("connection", (peer) =>
    peer.once("message", () => {
      peer.send(handshake());
      peer.send(Buffer.from([0x90, 3, 12, 0, 0]));
    })
  );
  await client.connect(s.registration).catch((error) => {
    assert.equal(error.message, "IM_SERVER_DISCONNECTED_12");
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(client.connected, false);
  assert.equal(disconnected.length, 1);
  assert.equal(disconnected[0].message, "IM_SERVER_DISCONNECTED_12");
  assert.equal(disconnected[0].retryable, false);
});

test("real handshake rejection preserves reason even without optional success fields", async (t) => {
  const s = await server(t);
  s.ws.on("connection", (peer) =>
    peer.once("message", () =>
      peer.send(Buffer.concat([Buffer.from([0x20, 9]), Buffer.alloc(8), Buffer.from([2])]))
    )
  );
  const client = new WukongConnection(() => {});
  t.after(() => client.close());
  await assert.rejects(client.connect(s.registration), {
    message: "IM_CONNECT_REJECTED_2",
    retryable: false
  });
});

test("missing heartbeat packets reports a retryable timeout and releases pending sends", async (t) => {
  const s = await server(t);
  s.ws.on("connection", (peer) => peer.once("message", () => peer.send(handshake())));
  let disconnected;
  const closed = new Promise((resolve) => {
    disconnected = resolve;
  });
  const client = new WukongConnection(() => {}, disconnected);
  t.after(() => client.close());
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  await client.connect(s.registration);
  const pending = assert.rejects(client.sendText("qa", 1, "test"), { message: "IM_DISCONNECTED" });
  t.mock.timers.tick(100000);
  const error = await closed;
  await pending;
  assert.equal(error.message, "IM_HEARTBEAT_TIMEOUT");
  assert.equal(error.retryable, true);
  assert.equal(client.connected, false);
});

test("a success and terminal disconnect in the same WS packet cannot resolve a healthy connection", async (t) => {
  const s = await server(t);
  s.ws.on("connection", (peer) =>
    peer.once("message", () => {
      peer.send(Buffer.concat([handshake(), Buffer.from([0x90, 3, 12, 0, 0])]));
    })
  );
  const client = new WukongConnection(() => {});
  t.after(() => client.close());
  await assert.rejects(client.connect(s.registration), { message: "IM_SERVER_DISCONNECTED_12" });
  assert.equal(client.connected, false);
});

test("HTTP failures keep status and retry classification without exposing response bodies", async (t) => {
  const s = await server(t);
  for (const status of [401, 403, 409, 429, 503]) {
    s.status(status);
    await assert.rejects(registerBot(s.url, "bf_secret"), (error) => {
      assert.equal(error.message, `IM_REGISTER_HTTP_${status}`);
      assert.equal(error.retryable, status === 429 || status === 503);
      assert.doesNotMatch(JSON.stringify(error), /bf_secret|private response/);
      return true;
    });
    await assert.rejects(verifyBotIdentity(s.url, "bf_secret", AbortSignal.timeout(1000)), {
      message: `IM_AUTH_HTTP_${status}`
    });
  }
});

test("HTTP body interruptions remain retryable while malformed JSON is terminal", async (t) => {
  let malformed = false;
  const http = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (malformed) res.end("invalid JSON");
    else {
      res.write("{");
      setTimeout(() => res.destroy(), 10);
    }
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(() => {
    http.closeAllConnections();
    return new Promise((resolve) => http.close(resolve));
  });
  const url = `http://127.0.0.1:${http.address().port}`;
  for (const invalid of [false, true]) {
    malformed = invalid;
    await assert.rejects(registerBot(url, "bf_fixture"), {
      message: invalid ? "IM_REGISTRATION_INVALID" : "IM_REGISTER_NETWORK_ERROR",
      retryable: !invalid
    });
    await assert.rejects(verifyBotIdentity(url, "bf_fixture", AbortSignal.timeout(1000)), {
      message: invalid ? "IM_AUTH_IDENTITY_INVALID" : "IM_AUTH_NETWORK_ERROR",
      retryable: !invalid
    });
  }
});

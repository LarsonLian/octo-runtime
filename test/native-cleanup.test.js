import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { NativeInteractionBridge } from "../packages/octo-runtime-adapter-sdk/dist/index.js";

for (const trigger of ["automatic-validation", "automatic-write", "expiry"]) {
  test(`native ${trigger} observes failed background transport cleanup`, async (t) => {
    if (trigger === "expiry") t.mock.timers.enable({ apis: ["setTimeout"] });
    const bridge = new NativeInteractionBridge();
    const cleanupError = new Error("transport cleanup failed");
    let closes = 0;
    bridge.bindTransport(async () => {
      closes++;
      throw cleanupError;
    });
    bridge.request(
      "approval",
      {},
      async () => {
        if (trigger === "automatic-write") throw new Error("write failed");
      },
      () => {
        if (trigger === "automatic-validation") throw new Error("invalid automatic response");
      },
      trigger === "expiry" ? undefined : {}
    );
    if (trigger === "expiry") t.mock.timers.tick(600_000);
    await nextTurn();
    bridge.close();
    await assert.rejects(
      Array.fromAsync(bridge.stream((async function* () {})())),
      (error) => error === cleanupError
    );
    assert.equal(closes, 1);
  });
}

test("native cleanup failure does not skip iterator resource disposal", async (t) => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    if (server.listening) {
      server.close();
      await once(server, "close");
    }
  });
  const bridge = new NativeInteractionBridge();
  const cleanupError = new Error("transport cleanup failed");
  bridge.bindTransport(async () => {
    throw cleanupError;
  });
  let reads = 0,
    returns = 0,
    release;
  const source = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (++reads === 1)
        return Promise.resolve({
          done: false,
          value: { kind: "native", messageKind: "notification", payload: {} }
        });
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    async return() {
      returns++;
      server.close();
      await once(server, "close");
      release?.({ done: true });
      return { done: true };
    }
  };
  const output = bridge.stream(source);
  await output.next();
  const closed = once(server, "close");
  await assert.rejects(output.return(), (error) => error === cleanupError);
  await closed;
  assert.equal(returns, 1);
  assert.equal(server.listening, false);
});

test("native cleanup starts every step and reports failure without waiting for a blocked sibling", async () => {
  const bridge = new NativeInteractionBridge();
  const cleanupError = new Error("transport close failed");
  bridge.bindTransport(async () => {
    throw cleanupError;
  });
  let returns = 0;
  const source = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      return { done: true };
    },
    return() {
      returns++;
      return new Promise(() => {});
    }
  };
  await assert.rejects(bridge.stream(source).next(), (error) => error === cleanupError);
  assert.equal(returns, 1);
});

test("native response preserves write and cleanup errors without repeating close", async () => {
  const bridge = new NativeInteractionBridge();
  const writeError = new Error("write failed"),
    cleanupError = new Error("cleanup failed");
  let closes = 0;
  bridge.bindTransport(async () => {
    closes++;
    throw cleanupError;
  });
  bridge.request(
    "approval",
    {},
    async () => {
      throw writeError;
    },
    () => {}
  );
  await assert.rejects(bridge.respond({ requestId: "approval", payload: {} }), (error) => {
    assert.deepEqual(error.errors, [writeError, cleanupError]);
    assert.equal(error.cause, cleanupError);
    return true;
  });
  await assert.rejects(
    Array.fromAsync(bridge.stream((async function* () {})())),
    (error) => error === cleanupError
  );
  assert.equal(closes, 1);
});

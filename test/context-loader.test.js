import test from "node:test";
import assert from "node:assert/strict";
import {
  createContextLoader,
  mergeConfiguredContexts,
  ExtraPlugins
} from "../packages/octo-runtime-daemon/dist/index.js";
import { contextControlInstructions } from "../packages/octo-runtime-protocol/dist/index.js";

const signal = () => new AbortController().signal;
const item = (name, text) => ({ namespace: "extra.business", name, payload: { text } });
const control = (...texts) => ({
  namespace: "octo.control",
  name: "instructions",
  payload: { entries: texts.map((text) => ({ text })) }
});
const config = {
  context: {
    schema: "octo.context-envelope/v3",
    items: [control("我是明略科技的Octo助理"), item("first", "base"), item("last", "last")]
  }
};

test("dynamic contexts replace whole items at the base position, append in order and never mutate config", () => {
  const dynamic = [
    item("first", "dynamic"),
    control("override", "override", "  preserved\n"),
    item("new", "new")
  ];
  const merged = mergeConfiguredContexts(config.context.items, dynamic);
  assert.deepEqual(
    merged.map((i) => i.name),
    ["instructions", "first", "last", "new"]
  );
  assert.equal(
    contextControlInstructions({ schema: config.context.schema, items: merged }),
    "override\noverride\n  preserved\n"
  );
  merged[1].payload.text = "changed";
  assert.equal(dynamic[0].payload.text, "dynamic");
  assert.equal(config.context.items[1].payload.text, "base");
});

test("sync and async callbacks load afresh, receive JSON copies and release every slot", async () => {
  for (const asynchronous of [false, true]) {
    let calls = 0;
    const loader = createContextLoader(
      (copy, options) => {
        assert.equal(options.signal.aborted, false);
        copy.context.items.length = 0;
        const value = [item("first", String(++calls))];
        return asynchronous ? Promise.resolve(value) : value;
      },
      undefined,
      signal()
    );
    for (let i = 1; i <= 2000; i++) {
      const result = await loader.load(config, signal());
      assert.equal(result[1].payload.text, String(i));
      assert.equal(loader.inFlight, 0);
    }
    assert.equal(config.context.items.length, 3);
    await loader.close();
  }
});

test("unsettled timeout occupies capacity, late rejection is consumed and close aborts callbacks", async () => {
  let rejectOperation;
  let callbackSignal;
  const loader = createContextLoader(
    (_config, { signal }) => {
      callbackSignal = signal;
      return new Promise((_, reject) => {
        rejectOperation = reject;
      });
    },
    { timeout_ms: 5, max_in_flight: 1 },
    signal()
  );
  await assert.rejects(loader.load(config, signal()), /IM_CONTEXT_LOADING_TIMEOUT/);
  assert.equal(callbackSignal.aborted, true);
  assert.equal(loader.inFlight, 1);
  for (let i = 0; i < 100; i++)
    await assert.rejects(loader.load(config, signal()), /IM_CONTEXT_LOADING_BUSY/);
  rejectOperation(new Error("late private failure"));
  await loader.close();
  assert.equal(loader.inFlight, 0);
});

test("owner cancellation completes waiting callers and closes cooperative I/O", async () => {
  const owner = new AbortController();
  const loader = createContextLoader(
    (_config, { signal }) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve([item("late", "discarded")]), {
          once: true
        });
      }),
    undefined,
    owner.signal
  );
  const pending = assert.rejects(loader.load(config, signal()), /IM_CONTEXT_LOADING_CANCELLED/);
  await Promise.resolve();
  owner.abort();
  await pending;
  await loader.close();
  assert.equal(loader.inFlight, 0);
});

test("invalid, cyclic, oversized and duplicate results fail before invoke", async () => {
  const cycle = item("cycle", "");
  cycle.payload.self = cycle;
  const sparse = item("sparse", "");
  sparse.payload.values = new Array(2 ** 30);
  const customJson = item("custom", "");
  Object.defineProperty(customJson.payload, "toJSON", {
    value: () => {
      throw new Error("must not execute");
    }
  });
  for (const result of [
    [cycle],
    [sparse],
    [customJson],
    [item("large", "x".repeat(300000))],
    [item("same", "a"), item("same", "b")],
    [item("bad", Infinity)],
    Array(33).fill(item("over", "")),
    { items: [] }
  ]) {
    const loader = createContextLoader(() => result, undefined, signal());
    await assert.rejects(loader.load(config, signal()));
    assert.equal(loader.inFlight, 0);
    await loader.close();
  }
});

test("typed module assembly separates functions from JSON and disposes each loaded instance", async () => {
  const extras = new ExtraPlugins([], {});
  let calls = 0;
  const module = {
    name: "business",
    default(context, value) {
      assert.deepEqual(value, { value: 1 });
      return async (dependencies) => {
        assert.equal(Object.isFrozen(dependencies), true);
        calls += await dependencies.business(value);
        context.onDispose(() => {
          calls--;
        });
      };
    }
  };
  for (let i = 0; i < 100; i++) {
    await extras.load(module, { value: 1 }, { business: async () => 1 });
    assert.equal(calls, 1);
    await extras.unload(module.name);
    assert.equal(calls, 0);
  }
  await extras.close();
});

test(
  "ten thousand completed context loads retain bounded heap after warmup",
  { skip: !global.gc },
  async (t) => {
    const loader = createContextLoader(() => [item("first", "dynamic")], undefined, signal());
    const batch = async (count) => {
      for (let i = 0; i < count; i++) {
        await loader.load(config, signal());
        if (i % 100 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
      await new Promise((resolve) => setImmediate(resolve));
      global.gc();
    };
    await batch(1000);
    const before = process.memoryUsage().heapUsed;
    await batch(10000);
    const growth = process.memoryUsage().heapUsed - before;
    t.diagnostic(`retained heap growth after 10000 loads: ${growth} bytes`);
    assert.ok(growth < 8 * 1024 * 1024);
    assert.equal(loader.inFlight, 0);
    await loader.close();
  }
);

test(
  "uncooperative callbacks bound unload, block replacement and do not stop another Extra",
  { timeout: 8000 },
  async () => {
    let finish;
    const owner = new AbortController();
    const loader = createContextLoader(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      { timeout_ms: 1 },
      owner.signal
    );
    const extras = new ExtraPlugins([], {});
    await extras.load(
      {
        name: "uncooperative",
        default: (ctx) => () => {
          ctx.onDispose(() => loader.close());
        }
      },
      {},
      {}
    );
    await extras.load({ name: "healthy", default: () => () => {} }, {}, {});
    await assert.rejects(loader.load(config, signal()), /IM_CONTEXT_LOADING_TIMEOUT/);
    await assert.rejects(extras.unload("uncooperative"), /EXTRA_DISPOSE_FAILED/);
    await assert.rejects(
      extras.load({ name: "uncooperative", default: () => () => {} }, {}, {}),
      /EXTRA_(?:ALREADY_LOADED|DISPOSE_FAILED)/
    );
    assert.deepEqual(await extras.inspect("healthy"), {});
    finish([item("late", "discarded")]);
    await assert.rejects(extras.close(), /EXTRA_DISPOSE_FAILED/);
  }
);

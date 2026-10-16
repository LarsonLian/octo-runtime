import test from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  ExtraPlugins,
  readExtraDirectory,
  extraRegistration,
  startDaemonServer,
  createDaemonRuntime
} from "../packages/octo-runtime-daemon/dist/index.js";
import { runCli, callDaemon } from "../apps/cli/dist/main.js";
import { invokeRequest, waitFor } from "./runtime-fixture.js";
import { invocationInput } from "@mininglamp-oss/octo-runtime-protocol";

const root = fileURLToPath(new URL("..", import.meta.url));
test("legacy void and async Extra entries are rejected and their cleanup still runs", async () => {
  for (const asynchronous of [false, true]) {
    let cleaned = 0;
    const initialize = (context) => {
      context.onDispose(() => cleaned++);
      if (asynchronous) return Promise.reject(new Error("legacy-async-error"));
    };
    const extras = new ExtraPlugins(
      [
        {
          name: "legacy",
          config: {},
          load: async () => ({ name: "legacy", default: initialize })
        }
      ],
      {}
    );
    await assert.rejects(extras.load("legacy"), /EXTRA_INITIALIZER_REQUIRED/);
    assert.equal(cleaned, 1);
    assert.equal(extras.status.legacy.error, "EXTRA_INITIALIZER_REQUIRED");
    await extras.close();
  }
});

test("lambda scope loads once, keeps running after return, and disposes in reverse order exactly once", async () => {
  const calls = [],
    host = {};
  let context;
  const extras = new ExtraPlugins(
    [
      {
        name: "example",
        config: { custom: [1, "a"] },
        load: async () => ({
          name: "example",
          default(ctx, config) {
            return async () => {
              context = ctx;
              assert.equal(ctx.adapterHost, host);
              assert.deepEqual(config, { custom: [1, "a"] });
              ctx.onDispose(() => calls.push("first"));
              ctx.onDispose(async () => calls.push("second"));
            };
          }
        })
      }
    ],
    host
  );
  await extras.loadConfigured();
  assert.equal(extras.status.example.phase, "loaded");
  assert.deepEqual(await extras.inspect("example"), {});
  assert.equal("onConfigure" in context, false);
  assert.equal("onRequest" in context, false);
  await assert.rejects(extras.load("example"), /EXTRA_ALREADY_LOADED/);
  await Promise.all([extras.unload("example"), extras.unload("example")]);
  assert.equal(context.signal.aborted, true);
  assert.deepEqual(calls, ["second", "first"]);
  assert.equal(extras.status.example.phase, "disposed");
  assert.throws(() => context.onDispose(() => {}), /EXTRA_ALREADY_DISPOSED/);
  await extras.close();
  assert.deepEqual(calls, ["second", "first"]);
});

test("failed initialization unwinds resources, failure is isolated and disabled code is never imported", async () => {
  const calls = [];
  const extras = new ExtraPlugins(
    [
      {
        name: "broken",
        config: {},
        load: async () => ({
          name: "broken",
          default(ctx) {
            return async () => {
              ctx.onDispose(() => calls.push("cleaned"));
              throw new Error("private-config-value");
            };
          }
        })
      },
      {
        name: "healthy",
        config: {},
        load: async () => ({
          name: "healthy",
          default() {
            return async () => {};
          }
        })
      },
      {
        name: "disabled",
        config: {},
        enabled: false,
        load: async () => {
          throw new Error("must not import");
        }
      }
    ],
    {}
  );
  await extras.loadConfigured();
  assert.deepEqual(calls, ["cleaned"]);
  assert.deepEqual(extras.status.broken, { phase: "error", error: "EXTRA_LOAD_FAILED" });
  assert.equal(extras.status.healthy.phase, "loaded");
  assert.equal(extras.status.disabled.phase, "disabled");
  assert.doesNotMatch(JSON.stringify(extras.status), /private-config-value/);
  await extras.close();
  assert.deepEqual(calls, ["cleaned"]);
  const mismatched = new ExtraPlugins(
    [
      {
        name: "wrong",
        config: {},
        load: async () => ({
          name: "other",
          default() {
            return async () => {};
          }
        })
      }
    ],
    {}
  );
  await assert.rejects(mismatched.load("wrong"), /EXTRA_NAME_MISMATCH/);
  await mismatched.close();
});

test("host unloads before loading a new snapshot; status is synchronous and isolated per Extra", async () => {
  const calls = [];
  const plugin = {
    name: "managed",
    default(ctx, config) {
      return async () => {
        calls.push(`load:${config.value}`);
        ctx.onDispose(() => calls.push(`dispose:${config.value}`));
        ctx.onStatus(() => ({ value: config.value }));
      };
    }
  };
  const entry = (value, module = "first") => ({
    name: "managed",
    module,
    config: { value },
    load: async () => plugin
  });
  const extras = new ExtraPlugins(
    [
      entry(1),
      {
        name: "other",
        config: {},
        load: async () => ({
          name: "other",
          default(ctx) {
            return async () => {
              ctx.onDispose(() => calls.push("other:dispose"));
            };
          }
        })
      }
    ],
    {}
  );
  try {
    await extras.loadConfigured();
    await assert.rejects(extras.load("managed", entry(2)), /EXTRA_ALREADY_LOADED/);
    assert.deepEqual(await extras.inspect("managed"), { value: 1 });
    const unloaded = extras.unload("managed");
    const loaded = extras.load("managed", entry(2));
    const status = extras.inspect("managed");
    await unloaded;
    await loaded;
    assert.deepEqual(await status, { value: 2 });
    assert.deepEqual(calls, ["load:1", "dispose:1", "load:2"]);
    assert.equal(extras.status.other.phase, "loaded");
    assert.deepEqual(await extras.inspect("other"), {});
    await extras.unload("managed");
    await assert.rejects(extras.inspect("managed"), /EXTRA_NOT_LOADED/);
  } finally {
    await extras.close();
  }
});

test("status returns a JSON snapshot and hides callback failures without changing lifecycle", async () => {
  for (const result of [
    { nested: { value: 1 } },
    [],
    { missing: undefined },
    { value: Infinity },
    Promise.resolve({})
  ]) {
    const extras = new ExtraPlugins(
      [
        {
          name: "status-test",
          config: {},
          load: async () => ({
            name: "status-test",
            default(ctx) {
              return async () => {
                ctx.onStatus(() => result);
              };
            }
          })
        }
      ],
      {}
    );
    await extras.loadConfigured();
    try {
      if (result.nested) {
        const snapshot = await extras.inspect("status-test");
        snapshot.nested.value = 2;
        assert.equal(result.nested.value, 1);
      } else await assert.rejects(extras.inspect("status-test"), /EXTRA_STATUS_FAILED/);
      assert.equal(extras.status["status-test"].phase, "loaded");
    } finally {
      await extras.close();
    }
  }
  const extras = new ExtraPlugins(
    [
      {
        name: "broken-status",
        config: {},
        load: async () => ({
          name: "broken-status",
          default(ctx) {
            return async () => {
              ctx.onStatus(() => {
                throw new Error("private-token");
              });
            };
          }
        })
      }
    ],
    {}
  );
  await extras.loadConfigured();
  await assert.rejects(
    extras.inspect("broken-status"),
    (error) => error.message === "EXTRA_STATUS_FAILED"
  );
  await extras.close();
});

test(
  "unload cancels initialization queued before an instance exists",
  { timeout: 2000 },
  async () => {
    const extras = new ExtraPlugins(
      [
        {
          name: "queued",
          config: {},
          load: async () => ({
            name: "queued",
            default(ctx) {
              return async () => {
                await new Promise((resolve) =>
                  ctx.signal.addEventListener("abort", resolve, { once: true })
                );
              };
            }
          })
        }
      ],
      {}
    );
    const loading = extras.load("queued");
    const unloaded = extras.unload("queued");
    await assert.rejects(loading, /EXTRA_LOAD_CANCELLED/);
    await unloaded;
    await extras.close();
  }
);

test("failed cleanup prevents reload and remains visible without affecting another Extra", async () => {
  const broken = {
    name: "cleanup-failure",
    config: {},
    load: async () => ({
      name: "cleanup-failure",
      default(ctx) {
        return async () => {
          ctx.onDispose(() => {
            throw new Error("cleanup");
          });
        };
      }
    })
  };
  const extras = new ExtraPlugins(
    [
      broken,
      {
        name: "healthy",
        config: {},
        load: async () => ({
          name: "healthy",
          default() {
            return async () => {};
          }
        })
      }
    ],
    {}
  );
  await extras.loadConfigured();
  await assert.rejects(extras.unload(broken.name), /EXTRA_DISPOSE_FAILED/);
  await assert.rejects(extras.load(broken.name, broken), /EXTRA_ALREADY_LOADED/);
  await assert.rejects(extras.inspect(broken.name), /EXTRA_NOT_LOADED/);
  assert.equal(extras.status.healthy.phase, "loaded");
  assert.deepEqual(await extras.inspect("healthy"), {});
  await assert.rejects(extras.close(), /EXTRA_DISPOSE_FAILED/);
});

test("dispose keeps cleaning after an error, and shutdown aborts pending initialization", async () => {
  const calls = [];
  let starting;
  const started = new Promise((resolve) => {
    starting = resolve;
  });
  const extras = new ExtraPlugins(
    [
      {
        name: "pending",
        config: {},
        load: async () => ({
          name: "pending",
          default(ctx) {
            return async () => {
              ctx.onDispose(() => calls.push("first"));
              ctx.onDispose(() => {
                calls.push("second");
                throw new Error("cleanup failed");
              });
              starting();
              await new Promise((resolve) =>
                ctx.signal.addEventListener("abort", resolve, { once: true })
              );
            };
          }
        })
      }
    ],
    {}
  );
  const loading = extras.load("pending");
  const rejected = assert.rejects(loading);
  await started;
  await assert.rejects(extras.close(), /EXTRA_DISPOSE_FAILED/);
  await rejected;
  assert.deepEqual(calls, ["second", "first"]);
  assert.equal(extras.status.pending.error, "EXTRA_DISPOSE_FAILED");
});

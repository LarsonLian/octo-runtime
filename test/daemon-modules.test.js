import test from "node:test";
import assert from "node:assert/strict";
import { DaemonModules } from "../packages/octo-harness-daemon/dist/index.js";
import { createDaemonRuntime } from "../packages/octo-harness-daemon/dist/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

test(
  "account shutdown interrupts a module request waiting for enrollment",
  { timeout: 10_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "daemon-pending-"));
    const runtime = createDaemonRuntime({
      appId: "pending",
      home,
      development: true,
      modules: [
        {
          id: "worker-access",
          module: fileURLToPath(new URL("./fixtures/pending-daemon-module.js", import.meta.url)),
          exportName: "createPendingModule"
        }
      ]
    });
    try {
      await runtime.startAccount({
        subject: { type: "user", id: "user" },
        tenants: [{ id: "space" }]
      });
      await runtime.startModule("worker-access", {});
      const request = runtime.requestModule("worker-access", "status");
      const rejected = assert.rejects(request);
      await runtime.stop("account-switch");
      await rejected;
      assert.equal(runtime.health().phase, "stopped");
    } finally {
      await runtime.stop("quit");
      await rm(home, { recursive: true, force: true });
    }
  }
);

test("optional modules load only on demand and share the local Host", async () => {
  const host = {},
    calls = [];
  const modules = new DaemonModules(
    [
      {
        id: "channel-im",
        create(context, config) {
          calls.push({ host: context.host, config });
          return {
            status: { connected: true },
            async start() {},
            async close() {},
            async handle(request) {
              return request.method;
            }
          };
        }
      }
    ],
    { host, homePath: "/tmp" }
  );
  modules.startConfigured();
  assert.deepEqual(calls, []);
  assert.deepEqual(modules.status, { "channel-im": { phase: "disabled" } });
  await modules.start("channel-im", { bot: "test" });
  assert.equal(await modules.request("channel-im", { method: "status" }), "status");
  assert.equal(calls[0].host, host);
  await modules.stop("channel-im");
  assert.deepEqual(modules.status, { "channel-im": { phase: "disabled" } });
  await modules.close();
});

test("a pending enrollment is aborted during shutdown without waiting for cloud readiness", async () => {
  let aborted = false,
    started = false;
  const modules = new DaemonModules(
    [
      {
        id: "worker-access",
        create(context) {
          return {
            status: {},
            async start() {
              started = true;
              await new Promise((resolve) =>
                context.signal.addEventListener(
                  "abort",
                  () => {
                    aborted = true;
                    resolve();
                  },
                  { once: true }
                )
              );
            },
            async close() {}
          };
        }
      }
    ],
    { host: {}, homePath: "/tmp" }
  );
  await modules.start("worker-access", {});
  assert.equal(started, true);
  const request = modules.request("worker-access", { method: "status" });
  const rejected = assert.rejects(request, /DAEMON_MODULE_STOPPED/);
  await modules.close();
  await rejected;
  assert.equal(aborted, true);
});

test("module failure is isolated and a failed connection can be restarted", async () => {
  let fail = true;
  const modules = new DaemonModules(
    [
      {
        id: "worker-access",
        create() {
          return {
            status: {},
            async start() {
              if (fail) throw new Error("cloud unavailable");
            },
            async close() {},
            async handle() {
              return "online";
            }
          };
        }
      }
    ],
    { host: {}, homePath: "/tmp" }
  );
  await modules.start("worker-access", {});
  await assert.rejects(modules.request("worker-access", { method: "status" }), /cloud unavailable/);
  assert.equal(modules.status["worker-access"].phase, "error");
  fail = false;
  await modules.start("worker-access", {});
  assert.equal(await modules.request("worker-access", { method: "status" }), "online");
  await modules.close();
});

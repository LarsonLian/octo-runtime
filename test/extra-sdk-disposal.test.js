import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDaemonRuntime } from "../packages/octo-runtime-daemon/dist/index.js";
import { waitFor } from "./runtime-fixture.js";
const root = fileURLToPath(new URL("..", import.meta.url));

for (const action of ["unload", "quit", "account-switch"]) {
  test(
    `SDK interrupts a pending Extra load on ${action} without restoring the cancelled declaration`,
    { timeout: 15000 },
    async () => {
      const home = await mkdtemp("/tmp/extra-stop-");
      const module = join(home, "pending.mjs");
      const marker = join(home, "started");
      const disposed = join(home, "disposed");
      await writeFile(
        module,
        `import { writeFile } from 'node:fs/promises';
      export const name = 'pending';
      export default async function(ctx, config) {
        ctx.onDispose(() => writeFile(config.disposed, 'done'));
        await writeFile(config.marker, 'started');
        if (!ctx.signal.aborted) await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, { once: true }));
      }`
      );
      const runtime = createDaemonRuntime({
        appId: "extra-stop",
        home,
        development: true,
        distribution: { manifestPath: join(root, "test/fixtures/adapters.json") }
      });
      const account = { subject: { type: "user", id: "one" }, tenants: [{ id: "space" }] };
      try {
        await runtime.startAccount(account);
        const loading = runtime.loadExtra({
          name: "pending",
          module,
          config: { marker, disposed }
        });
        const failed = assert.rejects(loading, /EXTRA_LOAD_CANCELLED/);
        await waitFor(() => existsSync(marker));
        if (action === "unload") await runtime.unloadExtra("pending");
        else if (action === "quit") await runtime.stop();
        else {
          const switching = runtime.startAccount({ ...account, subject: { type: "user", id: "two" } });
          const staleUnload = assert.rejects(runtime.unloadExtra("pending"), /EXTRA_ACCOUNT_CHANGED/);
          await switching;
          await staleUnload;
          assert.equal((await runtime.extraStatus()).pending, undefined);
        }
        await failed;
        assert.equal(await readFile(disposed, "utf8"), "done");
        if (action === "unload")
          assert.equal((await runtime.extraStatus()).pending.phase, "disposed");
        await runtime.stop("reconfigure");
        await runtime.startAccount(account);
        assert.equal((await runtime.extraStatus()).pending, undefined);
        // A queued load immediately followed by unload must never enter the plugin.
        const queued = runtime.loadExtra({ name: "pending", module, config: { marker, disposed } });
        const cancelled = assert.rejects(queued, /EXTRA_LOAD_CANCELLED/);
        await runtime.unloadExtra("pending");
        await cancelled;
      } finally {
        await runtime.stop();
        await rm(home, { recursive: true, force: true });
      }
    }
  );
}

test(
  "SDK reports failed disposal after still stopping its runner",
  { timeout: 15000 },
  async () => {
    const home = await mkdtemp("/tmp/extra-stop-error-");
    const module = join(home, "broken.mjs");
    await writeFile(
      module,
      `export const name = 'broken'; export default function(ctx) { ctx.onDispose(() => { throw new Error('private cleanup detail'); }); }`
    );
    const runtime = createDaemonRuntime({
      appId: "extra-stop",
      home,
      development: true,
      distribution: { manifestPath: join(root, "test/fixtures/adapters.json") }
    });
    try {
      await runtime.startAccount({
        subject: { type: "user", id: "one" },
        tenants: [{ id: "space" }]
      });
      const pid = runtime.health().local.pid;
      await runtime.loadExtra({ name: "broken", module, config: {} });
      await assert.rejects(runtime.unloadExtra("broken"), /EXTRA_DISPOSE_FAILED/);
      await assert.rejects(runtime.stop(), /Extra cleanup failed/);
      assert.equal(runtime.health().phase, "stopped");
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
    } finally {
      await runtime.stop();
      await rm(home, { recursive: true, force: true });
    }
  }
);

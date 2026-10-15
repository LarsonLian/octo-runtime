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
import loadSse, { name as sseName } from "../packages/octo-runtime-extra-sse-demo/dist/index.js";
import { runCli, callDaemon } from "../apps/cli/dist/main.js";
import { invokeRequest, waitFor } from "./runtime-fixture.js";
import { invocationInput } from "@mininglamp-oss/octo-runtime-protocol";

const root = fileURLToPath(new URL("..", import.meta.url));
const modulePath = join(root, "packages/octo-runtime-extra-sse-demo/dist/index.js");
const token = "extra-test-token";
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function payload() {
  const { signal, ...request } = invokeRequest({ approvalMode: "full_access", runId: randomUUID(), invocationId: randomUUID() });
  request.context.items.push({ namespace: "octo.execution", name: "adapter", payload: { type: "test" } });
  return invocationInput(request, "canonical");
}
function post(port, value = payload(), auth = `Bearer ${token}`, path = "/") {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: typeof value === "string" ? value : JSON.stringify(value)
  });
}

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
            context = ctx;
            assert.equal(ctx.adapterHost, host);
            assert.deepEqual(config, { custom: [1, "a"] });
            ctx.onDispose(() => calls.push("first"));
            ctx.onDispose(async () => calls.push("second"));
          }
        })
      }
    ],
    host
  );
  await extras.loadConfigured();
  assert.equal(extras.status.example.phase, "loaded");
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
            ctx.onDispose(() => calls.push("cleaned"));
            throw new Error("private-config-value");
          }
        })
      },
      { name: "healthy", config: {}, load: async () => ({ name: "healthy", default() {} }) },
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
    [{ name: "wrong", config: {}, load: async () => ({ name: "other", default() {} }) }],
    {}
  );
  await assert.rejects(mismatched.load("wrong"), /EXTRA_NAME_MISMATCH/);
  await mismatched.close();
});

test("Extra configuration updates serialize with requests and module changes reload resources", async () => {
  const calls = [];
  const plugin = { name: "managed", default(ctx, config) {
    let value = config.value;
    calls.push('load');
    ctx.onDispose(() => calls.push('dispose'));
    ctx.onConfigure(async next => { if (next.value === 'invalid') throw new Error('INVALID'); value = next.value; calls.push('configure'); });
    ctx.onRequest(method => { assert.equal(method, 'status'); return { value }; });
  } };
  const entry = (value, module = 'first') => ({ name: 'managed', module, config: { value }, load: async () => plugin });
  const extras = new ExtraPlugins([entry(1)], {});
  try {
    await extras.loadConfigured();
    const update = extras.configure(entry(2));
    const status = extras.request('managed', 'status');
    await update;
    assert.deepEqual(await status, { value: 2 });
    assert.deepEqual(calls, ['load', 'configure']);
    await assert.rejects(extras.configure(entry('invalid')), /INVALID/);
    assert.deepEqual(await extras.request('managed', 'status'), { value: 2 });
    await extras.configure(entry(3, 'second'));
    assert.deepEqual(calls, ['load', 'configure', 'dispose', 'load']);
    await extras.unload('managed');
    await assert.rejects(extras.request('managed', 'status'), /EXTRA_NOT_LOADED/);
  } finally { await extras.close(); }
});

test("unload cancels initialization queued before an instance exists", { timeout: 2000 }, async () => {
  const extras = new ExtraPlugins([{
    name: 'queued', config: {}, load: async () => ({ name: 'queued', async default(ctx) {
      await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, { once: true }));
    } })
  }], {});
  const loading = extras.load('queued');
  const unloaded = extras.unload('queued');
  await assert.rejects(loading, /EXTRA_LOAD_CANCELLED/);
  await unloaded;
  await extras.close();
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
          async default(ctx) {
            ctx.onDispose(() => calls.push("first"));
            ctx.onDispose(() => {
              calls.push("second");
              throw new Error("cleanup failed");
            });
            starting();
            await new Promise((resolve) =>
              ctx.signal.addEventListener("abort", resolve, { once: true })
            );
          }
        })
      }
    ],
    {}
  );
  const loading = extras.load("pending");
  await started;
  await assert.rejects(extras.close(), /EXTRA_DISPOSE_FAILED/);
  await loading;
  assert.deepEqual(calls, ["second", "first"]);
  assert.equal(extras.status.pending.error, "EXTRA_DISPOSE_FAILED");
});

test(
  "extraset saves arbitrary plugin JSON privately, replaces fully, rejects invalid envelopes and auto-loads after daemon restart",
  { timeout: 20_000 },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "extra-cli-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const port = await freePort(),
      outputs = [];
    const set = (config) =>
      runCli(["--home", home, "extraset", sseName], {
        input: Readable.from([typeof config === "string" ? config : JSON.stringify(config)]),
        output: (line) => outputs.push(line)
      });
    const stored = {
      module: modulePath,
      enabled: true,
      config: { host: "127.0.0.1", port, token }
    };
    await set({ ...stored, config: { ...stored.config, removed: true } });
    await set(stored);
    const file = join(home, "default/extra/sse-demo/config.json");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), stored);
    assert.doesNotMatch(outputs.join(""), new RegExp(token));
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    for (const invalid of [
      "{bad",
      [],
      { ...stored, config: [] },
      { ...stored, module: "https://example.com/plugin.js" },
      { ...stored, enabled: "yes" }
    ]) {
      await assert.rejects(set(invalid));
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), stored);
    }
    const options = {
      homePath: home,
      socketPath: join(home, "daemon.sock"),
      manifestPath: join(root, "test/fixtures/adapters.json"),
      hostEntrypoint: join(root, "apps/adapter-host/dist/index.js")
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const app = await startDaemonServer({
        ...options,
        extras: await readExtraDirectory(join(home, "default/extra"))
      });
      try {
        assert.equal(
          (await callDaemon(options.socketPath, { method: "status" })).extras[sseName].phase,
          "loaded"
        );
        const response = await post(port, payload(), `Bearer ${token}`, "/any-path");
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /text\/event-stream/);
        const text = await response.text();
        assert.match(text, /run.completed/);
        assert.doesNotMatch(text, /event: error/);
        await callDaemon(options.socketPath, { method: "extra.unload", params: { name: sseName } });
        await assert.rejects(post(port));
        assert.equal((await callDaemon(options.socketPath, { method: "status" })).ready, true);
        await callDaemon(options.socketPath, { method: "extra.load", params: { name: sseName } });
      } finally {
        await app.close();
      }
      await assert.rejects(post(port));
    }
    await writeFile(file, "invalid", { mode: 0o600 });
    const entries = await readExtraDirectory(join(home, "default/extra"));
    const broken = new ExtraPlugins(entries, {});
    await broken.loadConfigured();
    assert.equal(broken.status[sseName].error, "EXTRA_CONFIG_READ_FAILED");
    await broken.close();
  }
);

test(
  "HTTP validates Bearer and payload before invoke; disconnect and dispose cancel active calls and release port",
  { timeout: 10_000 },
  async () => {
    const port = await freePort();
    let calls = 0,
      cancelled = 0;
    const extras = new ExtraPlugins(
      [
        {
          name: sseName,
          config: { port, token },
          load: async () => ({ name: sseName, default: loadSse })
        }
      ],
      {
        async *invoke(input, environment) {
          calls++;
          assert.equal(input.contexts.items[0].payload.type, "test");
          yield { kind: "control", marker: "started" };
          await new Promise((resolve) =>
            environment.signal.addEventListener("abort", resolve, { once: true })
          );
          cancelled++;
        }
      }
    );
    await extras.loadConfigured();
    try {
      for (const auth of ["", "Bearer wrong", `Basic ${token}`])
        assert.equal((await post(port, payload(), auth)).status, 401);
      assert.equal(
        (await fetch(`http://127.0.0.1:${port}`, { headers: { Authorization: `Bearer ${token}` } }))
          .status,
        405
      );
      for (const invalid of ["bad", {}, { ...payload(), protocol_mode: "wrong" }])
        assert.equal((await post(port, invalid)).status, 400);
      assert.equal((await post(port, "x".repeat(16 * 1024 * 1024 + 1))).status, 413);
      assert.equal(calls, 0);
      const abort = new AbortController();
      const response = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload()),
        signal: abort.signal
      });
      await response.body.getReader().read();
      abort.abort();
      await waitFor(() => cancelled === 1);
      const active = await post(port);
      await active.body.getReader().read();
      await extras.unload(sseName);
      assert.equal(cancelled, 2);
      await assert.rejects(post(port));
    } finally {
      await extras.close();
    }
  }
);

test(
  "CLI daemon process discovers enabled installed extras on each startup",
  { timeout: 20_000 },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "extra-process-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const port = await freePort();
    await runCli(["--home", home, "extraset", sseName], {
      input: Readable.from([
        JSON.stringify({
          module: "@mininglamp-oss/octo-runtime-extra-sse-demo",
          config: { port, token }
        })
      ]),
      output() {}
    });
    await runCli(["--home", home, "extraset", "missing"], {
      input: Readable.from([JSON.stringify({ module: "octo-extra-does-not-exist", config: { token } })]),
      output() {}
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const child = spawn(
        process.execPath,
        [
          join(root, "apps/cli/dist/index.js"),
          "--home",
          home,
          "daemon", "run"
        ],
        { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, OCTO_RUNTIME_MANIFEST: join(root, "test/fixtures/adapters.json") } }
      );
      let errors = "";
      child.stderr.on("data", (bytes) => {
        errors += bytes.toString();
      });
      try {
        const deadline = Date.now() + 8000;
        let response;
        while (Date.now() < deadline) {
          if (child.exitCode !== null) assert.fail(`daemon exited: ${errors}`);
          try {
            response = await post(port);
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        assert.ok(response, "plugin listener did not start");
        assert.match(await response.text(), /run.completed/);
        await waitFor(() => errors.includes("daemon ready"), 5000);
        assert.match(errors, /extras scanning/);
        assert.match(errors, /extras discovered/);
        assert.match(errors, /extra loading/);
        assert.match(errors, /phase: 'loaded'/);
        assert.match(errors, /EXTRA_MODULE_NOT_FOUND/);
        assert.ok(errors.includes(join(home, "default", "extra")));
        assert.ok(!errors.includes(token));
      } finally {
        if (child.exitCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGTERM");
          const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
          const [code] = await exited;
          clearTimeout(timer);
          assert.equal(code, 0, errors);
        }
      }
      await assert.rejects(post(port));
    }
  }
);

test("occupied HTTP port fails only the extra and does not close the existing server", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const extras = new ExtraPlugins(
    [extraRegistration({ name: sseName, module: modulePath, config: { port, token } })],
    {}
  );
  try {
    await extras.loadConfigured();
    assert.equal(extras.status[sseName].phase, "error");
    assert.equal(server.listening, true);
  } finally {
    await extras.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test(
  "Desktop SDK passes JSON descriptors to its supervised daemon without configuration files",
  { timeout: 20_000 },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "extra-sdk-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const port = await freePort();
    const runtime = createDaemonRuntime({
      appId: "extra-demo",
      home,
      development: true,
      distribution: { manifestPath: join(root, "test/fixtures/adapters.json") },
      extras: [{ name: sseName, module: modulePath, config: { port, token } }]
    });
    try {
      await runtime.startAccount({
        subject: { type: "user", id: "test" },
        tenants: [{ id: "test-space" }]
      });
      await waitFor(() => runtime.health().extras?.[sseName]?.phase === "loaded", 5000);
      const response = await post(port);
      assert.match(await response.text(), /run.completed/);
      assert.equal((await runtime.extraStatus())[sseName].phase, 'loaded');
      await runtime.unloadExtra(sseName);
      await assert.rejects(post(port));
      await runtime.loadExtra(sseName);
      await assert.rejects(runtime.requestExtra(sseName, 'status'), /EXTRA_REQUEST_UNSUPPORTED/);
      const secondPort = await freePort();
      await runtime.configureExtra({ name: sseName, module: modulePath, config: { port: secondPort, token } });
      await assert.rejects(post(port));
      assert.match(await (await post(secondPort)).text(), /run.completed/);
      await runtime.stop('reconfigure');
      await runtime.startAccount({ subject: { type: 'user', id: 'test' }, tenants: [{ id: 'test-space' }] });
      assert.match(await (await post(secondPort)).text(), /run.completed/);
      await runtime.startAccount({ subject: { type: 'user', id: 'other' }, tenants: [{ id: 'other-space' }] });
      await assert.rejects(post(secondPort));
      assert.match(await (await post(port)).text(), /run.completed/);
      await runtime.unloadExtra(sseName);
    } finally {
      await runtime.stop();
    }
    await assert.rejects(post(port));
  }
);

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  truncateSync,
  symlinkSync
} from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  HourlyLogWriter,
  HOURLY_LOG_MAX_BYTES
} from "../packages/octo-runtime-adapter-sdk/dist/index.js";
import { resolveServiceControl } from "../apps/cli/dist/service-control.js";
import { probeDaemon } from "../packages/octo-runtime-daemon/dist/runtime/runtime-contract.js";
import { createDaemonRuntime } from "../packages/octo-runtime-daemon/dist/index.js";

const hour = 3600000;
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), "octo-hourly-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const files = (path) => readdirSync(path).filter((name) => name.endsWith(".log"));
async function wait(predicate) {
  const end = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() >= end) throw new Error("hourly log verification timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("24 hours, idle cleanup and clock reversal retain only the current and two preceding buckets", async (t) => {
  const root = directory(t);
  let now = Date.UTC(2026, 9, 16);
  const writer = new HourlyLogWriter(root, "test", { now: () => now, cleanupIntervalMs: 10 });
  t.after(() => writer.close());
  for (let i = 0; i < 24; i++) {
    assert.equal(writer.write("row\n"), true);
    assert.ok(files(root).length <= 3);
    now += hour;
  }
  now += 3 * hour;
  await wait(() => files(root).length === 0);
  writer.write("future\n");
  now -= 12 * hour;
  writer.write("past\n");
  assert.equal(files(root).length, 1);
  assert.match(files(root)[0], /T15\.log$/);
});

test("actual 100 MiB boundary is inherited after restart and never creates overflow shards", (t) => {
  const root = directory(t);
  let now = Date.UTC(2026, 9, 16, 7);
  let writer = new HourlyLogWriter(root, "test", { now: () => now });
  writer.write("a");
  const path = join(root, files(root)[0]);
  truncateSync(path, HOURLY_LOG_MAX_BYTES - 1);
  writer.close();
  writer = new HourlyLogWriter(root, "test", { now: () => now });
  t.after(() => writer.close());
  assert.equal(writer.write("b"), true);
  assert.equal(writer.write("c"), false);
  for (let i = 0; i < 10000; i++) writer.write("discarded");
  assert.equal(statSync(path).size, 100 * 1024 * 1024);
  assert.equal(files(root).length, 1);
  now += hour;
  assert.equal(writer.write("next hour\n"), true);
  assert.equal(files(root).length, 2);
});

test("cleanup preserves legacy files, other categories, user files and symlink targets", (t) => {
  const root = directory(t),
    target = join(root, "user.txt");
  for (const name of [
    "adapter-host.log",
    "embedded-runtime.log",
    "service.out.log",
    "other-20260101T00.log",
    "user.txt"
  ])
    writeFileSync(join(root, name), "keep");
  symlinkSync(target, join(root, "test-20260101T00.log"));
  const writer = new HourlyLogWriter(root, "test", { now: () => Date.UTC(2026, 9, 16, 7) });
  t.after(() => writer.close());
  assert.equal(readFileSync(target, "utf8"), "keep");
  assert.equal(readdirSync(root).length, 6);
  symlinkSync(target, join(root, "test-20261016T07.log"));
  assert.equal(writer.write("must not reach user file"), false);
  assert.equal(readFileSync(target, "utf8"), "keep");
});

test("write failures remain bounded and recover; a stale lock disables only its hour", (t) => {
  const root = directory(t),
    blocked = join(root, "blocked");
  writeFileSync(blocked, "not a directory");
  let warnings = 0,
    now = Date.UTC(2026, 9, 16, 7);
  const writer = new HourlyLogWriter(blocked, "test", {
    now: () => now,
    onError: () => warnings++
  });
  t.after(() => writer.close());
  for (let i = 0; i < 100; i++) assert.equal(writer.write("x"), false);
  assert.equal(warnings, 1);
  rmSync(blocked);
  assert.equal(writer.write("recovered"), true);
  writeFileSync(join(blocked, "test-20261016T07.log.lock"), "");
  assert.equal(writer.write("locked"), false);
  now += hour;
  assert.equal(writer.write("next"), true);
  now += 3 * hour;
  writer.cleanup();
  assert.equal(readdirSync(blocked).length, 0);
});

test("a symlinked log directory is neither cleaned nor written", (t) => {
  const root = directory(t),
    target = directory(t),
    link = join(root, "logs");
  writeFileSync(join(target, "test-20260101T00.log"), "keep");
  symlinkSync(target, link, "dir");
  const writer = new HourlyLogWriter(link, "test");
  t.after(() => writer.close());
  assert.equal(writer.write("must not append"), false);
  assert.deepEqual(readdirSync(target), ["test-20260101T00.log"]);
  assert.equal(readFileSync(join(target, "test-20260101T00.log"), "utf8"), "keep");
});

test("concurrent processes cannot jointly exceed the same hourly file budget", async (t) => {
  const root = directory(t);
  const module = new URL("../packages/octo-runtime-adapter-sdk/dist/index.js", import.meta.url)
    .href;
  const code = `const { HourlyLogWriter } = await import(process.argv[1]); const w = new HourlyLogWriter(process.argv[2], 'test', { maxBytes: 4096 }); for(let i=0;i<2000;i++) w.write('x'.repeat(64)); w.close();`;
  await Promise.all(
    Array.from({ length: 3 }, () =>
      promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, module, root])
    )
  );
  assert.equal(files(root).length, 1);
  assert.ok(statSync(join(root, files(root)[0])).size <= 4096);
});

test("native service specs use explicit structured logging rather than implicit output capture", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const spec = resolveServiceControl({ platform, backend: {} }).spec({
      home: "/tmp/runtime",
      logs: "/tmp/runtime/logs"
    });
    assert.equal(spec.args.includes("--managed-logs"), false);
    assert.equal(spec.stdoutPath, undefined);
    assert.equal(spec.stderrPath, undefined);
  }
});

test(
  "real launcher enables only selected structured logs and preserves foreground output",
  { timeout: 15000 },
  async (t) => {
    const root = directory(t);
    const child = spawn(
      process.execPath,
      [
        resolve("apps/daemon/dist/launcher.js"),
        "--home",
        root,
        "--logs-dir",
        join(root, "selected-logs"),
        "--execution-only",
        "--console",
        "--manifest",
        resolve("test/fixtures/adapters.json")
      ],
      {
        env: { ...process.env, OCTO_RUNTIME_DEBUG: "1" },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await done;
    });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    await wait(
      async () => (await probeDaemon(join(root, "sockets", "octo-runtime-daemon.sock"), 200))?.ready
    );
    await wait(() => files(join(root, "selected-logs")).some((name) => name.startsWith("kernel-")));
    child.kill("SIGTERM");
    const exit = await done;
    assert.ok(exit.code === 0 || exit.signal === "SIGTERM", stderr);
    assert.match(stderr, /daemon (ready|listening|stopping)/);
    assert.equal(
      files(join(root, "selected-logs")).some((name) =>
        /^(service-|adapter-host-|embedded-runtime-)/.test(name)
      ),
      false
    );
  }
);

test(
  "SDK explicit logging records Extra events and releases writers across account restarts",
  { timeout: 20000 },
  async (t) => {
    const root = directory(t);
    const runtime = createDaemonRuntime({
      appId: "hourly-test",
      home: root,
      development: true,
      logging: { directory: join(root, "selected-logs") },
      extras: [
        { name: "log-output", module: resolve("test/fixtures/log-output-extra.js"), config: {} }
      ]
    });
    t.after(() => runtime.stop("quit"));
    for (let i = 0; i < 2; i++) {
      await runtime.startAccount({
        subject: { type: "user", id: "test" },
        tenants: [{ id: "space" }]
      });
      await runtime.stop("account-switch");
    }
    const account = readdirSync(join(root, "accounts"))[0];
    const logs = join(root, "selected-logs", "extras");
    const output = files(logs).filter((name) => name.startsWith("log-output-"));
    assert.equal(output.length, 1);
    const content = readFileSync(join(logs, output[0]), "utf8");
    assert.equal(content.match(/fixture.started/g).length, 2);
    assert.equal(content.match(/fixture.disposed/g).length, 2);
    assert.doesNotMatch(content, /private body|bf_secret/);
    assert.equal(readdirSync(join(root, "accounts", account)).includes("logs"), false);
  }
);

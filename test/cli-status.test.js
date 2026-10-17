import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, chmod, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { startDaemonServer } from "@mininglamp-oss/octo-runtime-daemon";
import { runCli, callDaemon } from "../apps/cli/dist/main.js";
import { waitFor } from "./runtime-fixture.js";

test("Extra configuration belongs to Home even when the default profile changes", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "extra-device-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const legacyDirectory = join(home, "default", "extra", "example");
  await mkdir(legacyDirectory, { recursive: true });
  const legacyFile = join(legacyDirectory, "config.json");
  const legacy = JSON.stringify({ module: "legacy-extra", config: { legacy: true } });
  await writeFile(legacyFile, legacy, { mode: 0o600 });
  const warnings = [];
  const errorOutput = (value) => warnings.push(value);
  await assert.rejects(
    runCli(["--home", home, "extraget", "example"], { output() {}, errorOutput }),
    /EXTRA_NOT_REGISTERED/
  );
  assert.deepEqual(warnings, []);
  const stored = { module: "device-extra", config: { shared: true } };
  await runCli(["--home", home, "extraset", "example"], {
    input: Readable.from([JSON.stringify(stored)]),
    output() {},
    errorOutput
  });
  for (const profile of ["personal", "team"]) {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ schema_version: 1, default_profile: profile, channel: "stable" })
    );
    let result;
    await runCli(["--home", home, "extraget", "example"], {
      output: (value) => {
        result = JSON.parse(value);
      },
      errorOutput() {}
    });
    assert.deepEqual(result, stored);
  }
  assert.deepEqual(
    JSON.parse(await readFile(join(home, "extras", "example", "config.json"), "utf8")),
    stored
  );
  assert.equal(await readFile(legacyFile, "utf8"), legacy);
  for (const command of ["extraset", "extraget"]) {
    await assert.rejects(
      runCli(["--home", home, "--profile", "team", command, "example"], { output() {} }),
      /--profile is not supported/
    );
  }
  await assert.rejects(
    runCli(["--home", home, "--profile", "extras", "adapter", "list"], { output() {} }),
    /infrastructure/
  );
});

test("extraget round trips the entire stored declaration without importing its module", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "extra-get-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const enabled of [undefined, false, true]) {
    const original = {
      module: "not-installed-example",
      ...(enabled === undefined ? {} : { enabled }),
      config: { nested: [true, null, { value: "fixture-secret" }] }
    };
    await runCli(["--home", home, "extraset", "example"], {
      input: Readable.from([JSON.stringify(original)]),
      output() {}
    });
    const output = [];
    const diagnostics = [];
    await runCli(["--home", home, "extraget", "example"], {
      output: (value) => output.push(value),
      errorOutput: (value) => diagnostics.push(value)
    });
    assert.equal(output.length, 1);
    assert.deepEqual(JSON.parse(output[0]), original);
    assert.deepEqual(diagnostics, [`Config file: ${join(home, "extras/example/config.json")}`]);
  }
  await assert.rejects(runCli(["--home", home, "extraget", "missing"]), /EXTRA_NOT_REGISTERED/);
  await assert.rejects(runCli(["--home", home, "extraget", ".."]));
  if (process.platform !== "win32") {
    await chmod(join(home, "extras/example/config.json"), 0o644);
    await assert.rejects(
      runCli(["--home", home, "extraget", "example"]),
      /EXTRA_CONFIG_PERMISSIONS_INVALID/
    );
  }
});

test("status includes each loaded Extra JSON and isolates lifecycle and query failures", async (t) => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "extra-status-"));
  const socketPath = join(home, "sockets/octo-runtime-daemon.sock");
  const registration = (name, callback, enabled = true) => ({
    name,
    config: {},
    enabled,
    load: async () => ({ name, default: (ctx, config) => () => callback(ctx, config) })
  });
  const expected = {
    bots: [{ connected: true, state: "online" }],
    custom: { nested: [1, false, null] }
  };
  const app = await startDaemonServer({
    homePath: home,
    socketPath,
    manifestPath: join(root, "test/fixtures/adapters.json"),
    hostEntrypoint: join(root, "packages/octo-runtime-adapter-host/dist/runner.js"),
    extras: [
      registration("healthy", (ctx) => ctx.onStatus(() => expected)),
      registration("empty", () => {}),
      registration("broken-status", (ctx) =>
        ctx.onStatus(() => {
          throw new Error("private-do-not-show");
        })
      ),
      registration("failed", () => {
        throw new Error("private-do-not-show");
      }),
      registration("disabled", () => assert.fail("disabled plugin must not load"), false)
    ]
  });
  t.after(async () => {
    await app.close();
    await rm(home, { recursive: true, force: true });
  });
  await waitFor(async () => {
    const state = await callDaemon(socketPath, { method: "status" });
    return state.extras.healthy.phase === "loaded" && state.extras.failed.phase === "error";
  });
  const run = async (args) => {
    let result;
    await runCli(["--home", home, ...args], {
      output: (value) => {
        result = value;
      },
      backend: {
        inspect: async () => ({ state: "running", manager: "test", enabled: true, drift: [] })
      }
    });
    return result;
  };
  for (const args of [["status"], ["daemon", "status", "--json"]]) {
    const value = await run(args);
    const result = JSON.parse(value);
    const extras = (result.application ?? result).extras;
    assert.deepEqual(extras.healthy.status, expected);
    assert.deepEqual(extras.empty.status, {});
    assert.equal(extras["broken-status"].status_error, "EXTRA_STATUS_FAILED");
    assert.equal(extras.failed.phase, "error");
    assert.equal(extras.disabled.phase, "disabled");
    assert.equal(Object.hasOwn(extras.failed, "status"), false);
    assert.doesNotMatch(value, /private-do-not-show/);
  }
  const terminal = await run(["daemon", "status"]);
  assert.match(terminal, /Backend: ready/);
  assert.match(terminal, /Extra healthy:/);
  assert.match(terminal, /"connected": true/);
  assert.match(terminal, /disabled: disabled/);
  assert.match(terminal, /status query failed/);
  assert.doesNotMatch(terminal, /private-do-not-show/);
});

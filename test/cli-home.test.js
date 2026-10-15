import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../apps/cli/dist/main.js";

test("install and run initialize the same default Home without authentication and preserve existing data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "octo-cli-home-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, ".octo-runtime");
  let installed;
  let enabled = false;
  const dependencies = {
    env: { HOME: directory },
    platform: "linux",
    output: () => {},
    fetchImplementation: () => { throw new Error("local initialization must not authenticate"); },
    backend: {
      probe: async () => ({ supported: true, manager: "test" }),
      install: async (spec) => { installed = spec; },
      enable: async () => { enabled = true; },
      disable: async () => { enabled = false; },
      inspect: async () => ({ state: "stopped", drift: [] })
    },
    runForegroundDaemon: async (args) => {
      assert.equal(args[args.indexOf("--home") + 1], home);
      assert.equal(JSON.parse(await readFile(join(home, "config.json"), "utf8")).schema_version, 1);
      return 0;
    }
  };
  await runCli(["daemon", "install"], dependencies);
  assert.equal(installed.workingDirectory, home);
  assert.equal(installed.args[installed.args.indexOf("--home") + 1], home);
  assert.equal(enabled, true);
  const machine = await readFile(join(home, "machine.json"), "utf8");
  const config = '{"schema_version":1,"default_profile":"work","channel":"beta","custom":true}\n';
  await writeFile(join(home, "config.json"), config);
  await writeFile(join(home, "default", "identity", "runtime.json"), "existing identity");
  await runCli(["daemon", "run"], dependencies);
  await runCli(["daemon", "install", "--no-autostart"], dependencies);
  assert.equal(enabled, false);
  assert.equal(await readFile(join(home, "config.json"), "utf8"), config);
  assert.equal(await readFile(join(home, "machine.json"), "utf8"), machine);
  assert.equal(await readFile(join(home, "default", "identity", "runtime.json"), "utf8"), "existing identity");

  const freshHome = join(directory, "fresh");
  await runCli(["--home", freshHome, "daemon", "run"], {
    ...dependencies,
    runForegroundDaemon: async (args) => {
      assert.equal(args[args.indexOf("--home") + 1], freshHome);
      assert.equal(JSON.parse(await readFile(join(freshHome, "machine.json"), "utf8")).schema_version, 1);
      return 0;
    }
  });
  await writeFile(join(home, "config.json"), '{"schema_version":99}');
  await assert.rejects(runCli(["daemon", "install"], dependencies), /unsupported Runtime Home config schema/);
  assert.equal(await readFile(join(home, "machine.json"), "utf8"), machine);
});

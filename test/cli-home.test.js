import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { Readable } from "node:stream";
import { runCli } from "../apps/cli/dist/main.js";

for (const [state, json] of [
  "fresh",
  "not_installed",
  "stopped",
  "running",
  "failed",
  "unknown",
  "disabled",
  "unsupported",
  "install_failure"
].flatMap((state) => [
  [state, false],
  [state, true]
])) {
  test(`daemon start precheck handles ${state} services (${json ? "JSON" : "terminal"})`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "octo-start-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const calls = [];
    const extra = {
      module: "example-extra",
      enabled: true,
      config: { endpoint: "https://im-test.deepminer.com.cn" }
    };
    await runCli(["--home", home, "extraset", "example"], {
      input: Readable.from([JSON.stringify(extra)]),
      output: () => {}
    });
    const config =
      '{"schema_version":1,"default_profile":"default","channel":"beta","custom":true}\n';
    const machine = JSON.stringify({ schema_version: 1, machine_id: `machine_${randomUUID()}` });
    if (state !== "fresh") {
      await writeFile(join(home, "config.json"), config);
      await writeFile(join(home, "machine.json"), machine);
    }
    const missing = ["fresh", "not_installed", "unsupported", "install_failure"].includes(state);
    let installed = !missing;
    let server;
    t.after(async () => {
      if (server)
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
    });
    const outputs = [];
    const backend = {
      inspect: async () => ({
        state: installed ? (missing || state === "disabled" ? "stopped" : state) : "not_installed",
        enabled: state !== "disabled",
        drift: []
      }),
      probe: async () => {
        calls.push("probe");
        return { supported: state !== "unsupported", manager: "test", detail: "no user session" };
      },
      install: async (spec) => {
        if (!json)
          assert.ok(outputs.some((value) => value.startsWith("Installing background service")));
        calls.push("install");
        assert.equal(spec.workingDirectory, home);
        assert.equal(spec.enabled, true);
        if (state === "install_failure") throw new Error("installation failed");
        installed = true;
      },
      enable: async () => {
        calls.push("enable");
      },
      start: async () => {
        if (!json) assert.ok(outputs.includes("Starting backend in the background..."));
        calls.push("start");
        if (state === "disabled") throw new Error("service is disabled");
        await mkdir(join(home, "sockets"), { recursive: true });
        server = net.createServer((socket) => {
          socket.once("data", () =>
            socket.end(
              `${JSON.stringify({
                result: {
                  ready: true,
                  adapters: ["codex", "claude-code"],
                  extras: {
                    active: { phase: "loaded" },
                    pending: { phase: "loading" },
                    broken: { phase: "failed" }
                  }
                }
              })}\n`
            )
          );
        });
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(join(home, "sockets", "octo-runtime-daemon.sock"), resolve);
        });
      }
    };
    const start = () =>
      runCli(["--home", home, "daemon", "start", ...(json ? ["--json"] : [])], {
        backend,
        output: (value) => outputs.push(json ? JSON.parse(value) : value),
        runForegroundDaemon: async () => {
          assert.fail("start must use the native background service");
        }
      });
    if (["disabled", "unsupported", "install_failure"].includes(state)) {
      await assert.rejects(
        start(),
        state === "disabled"
          ? /service is disabled/
          : state === "unsupported"
            ? /test is unavailable/
            : /installation failed/
      );
      assert.deepEqual(
        calls,
        state === "disabled"
          ? ["start"]
          : state === "unsupported"
            ? ["probe"]
            : ["probe", "install"]
      );
      if (json) assert.deepEqual(outputs, []);
      else assert.doesNotMatch(outputs.join("\n"), /successfully/);
    } else {
      assert.equal(await start(), 0);
      assert.deepEqual(calls, missing ? ["probe", "install", "enable", "start"] : ["start"]);
      if (json) {
        assert.equal(outputs.length, 1);
        assert.equal(outputs[0].action, "start");
        assert.equal(outputs[0].readiness.ready, true);
      } else {
        assert.equal(outputs[0], "Checking background service...");
        const summary = outputs.at(-1);
        assert.match(summary, /Backend started successfully/);
        assert.match(summary, /Adapters \(2\): codex, claude-code/);
        assert.match(summary, /Active Extras: active\n/);
        assert.match(summary, /pending: loading/);
        assert.match(summary, /broken: failed/);
        assert.equal(
          outputs.some((value) => value.startsWith("Installing background service")),
          missing
        );
      }
    }
    if (state === "fresh") {
      assert.equal(JSON.parse(await readFile(join(home, "config.json"), "utf8")).schema_version, 1);
      assert.match(
        JSON.parse(await readFile(join(home, "machine.json"), "utf8")).machine_id,
        /^machine_/
      );
    } else {
      assert.equal(await readFile(join(home, "config.json"), "utf8"), config);
      assert.equal(await readFile(join(home, "machine.json"), "utf8"), machine);
    }
    assert.deepEqual(
      JSON.parse(await readFile(join(home, "extras", "example", "config.json"), "utf8")),
      extra
    );
  });
}

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
    fetchImplementation: () => {
      throw new Error("local initialization must not authenticate");
    },
    backend: {
      probe: async () => ({ supported: true, manager: "test" }),
      install: async (spec) => {
        installed = spec;
      },
      enable: async () => {
        enabled = true;
      },
      disable: async () => {
        enabled = false;
      },
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
  assert.equal(
    await readFile(join(home, "default", "identity", "runtime.json"), "utf8"),
    "existing identity"
  );

  const freshHome = join(directory, "fresh");
  await runCli(["--home", freshHome, "daemon", "run"], {
    ...dependencies,
    runForegroundDaemon: async (args) => {
      assert.equal(args[args.indexOf("--home") + 1], freshHome);
      assert.equal(
        JSON.parse(await readFile(join(freshHome, "machine.json"), "utf8")).schema_version,
        1
      );
      return 0;
    }
  });
  await writeFile(join(home, "config.json"), '{"schema_version":99}');
  await assert.rejects(
    runCli(["daemon", "install"], dependencies),
    /unsupported Runtime Home config schema/
  );
  assert.equal(await readFile(join(home, "machine.json"), "utf8"), machine);
});

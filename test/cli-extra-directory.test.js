import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import { runCli, callDaemon } from "../apps/cli/dist/main.js";

const root = fileURLToPath(new URL("..", import.meta.url));

test("CLI Extra storage isolates Homes", async t => {
  const home = await mkdtemp("/tmp/extra-home-");
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const [name, value] of [["first", 1], ["second", 2]]) {
    const separate = join(home, name);
    await runCli(["--home", separate, "extraset", "example"], {
      input: Readable.from([JSON.stringify({ module: "not-installed-extra", config: { value } })]), output() {}
    });
    let saved;
    await runCli(["--home", separate, "extraget", "example"], { output: text => { saved = JSON.parse(text); }, errorOutput() {} });
    assert.deepEqual(saved.config, { value });
  }
});

for (const consoleOutput of [true, false]) {
  test(`daemon loads only device Extra configuration (${consoleOutput ? "console" : "quiet"})`, async t => {
    const home = await mkdtemp("/tmp/extra-daemon-");
    const module = join(home, "directory-test.mjs");
    await writeFile(module, 'export const name = "example"; export default function(ctx, config) { ctx.onStatus(() => config); }\n');
    const legacy = join(home, "default", "extra", "example", "config.json");
    await mkdir(join(home, "default", "extra", "example"), { recursive: true });
    await writeFile(legacy, "invalid legacy secret");
    await runCli(["--home", home, "extraset", "example"], {
      input: Readable.from([JSON.stringify({ module, config: { source: "device" } })]), output() {}, errorOutput() {}
    });
    // A file in the device Extra directory is not a Runtime profile declaration.
    await writeFile(join(home, "extras", "config.json"), "not a profile");
    const child = spawn(process.execPath, [join(root, "apps/daemon/dist/index.js"), "--home", home,
      "--manifest", join(root, "test/fixtures/adapters.json"), ...(consoleOutput ? ["--console"] : [])],
    { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, OPENCLAW_HOME: join(home, "no-openclaw") } });
    const exited = once(child, "exit");
    let errors = "";
    child.stderr.on("data", data => { errors += data; });
    t.after(async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(timer);
      await rm(home, { recursive: true, force: true });
    });
    const socket = join(home, "sockets/octo-runtime-daemon.sock");
    let ready = false;
    for (const deadline = Date.now() + 10000; Date.now() < deadline;) {
      assert.equal(child.exitCode, null, errors);
      try { ready = (await callDaemon(socket, { method: "status" })).extras.example.phase === "loaded"; }
      catch { /* Wait for the child to create its socket. */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(ready, true, errors);
    let status;
    await runCli(["--home", home, "status"], { output: text => { status = JSON.parse(text); } });
    assert.deepEqual(status.extras.example.status, { source: "device" });
    assert.doesNotMatch(errors, /legacy|migrat|Ignored Extra configuration/);
    assert.doesNotMatch(errors, /invalid legacy secret/);
    assert.equal(await readFile(legacy, "utf8"), "invalid legacy secret");
  });
}

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { once } from "node:events";

const execute = promisify(execFile);
const archive = resolve(process.argv[2]);
// macOS Unix sockets have a short path limit; its default temp directory is too long.
const directory = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "orc-"));
const npm = join(dirname(process.execPath), process.platform === "win32"
  ? "node_modules/npm/bin/npm-cli.js" : "../lib/node_modules/npm/bin/npm-cli.js");
let daemon;
let daemonExit;
try {
  await execute(process.execPath, [npm, "install", "--global", "--prefix", directory,
    "--offline", "--cache", join(directory, "empty-cache"), "--no-audit", "--no-fund", archive],
  { cwd: directory, timeout: 60_000 });
  const installed = join(directory, process.platform === "win32" ? "node_modules" : "lib/node_modules",
    "@mininglamp-oss/octo-runtime");
  const metadata = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.deepEqual(metadata.exports, {});
  assert.equal(metadata.scripts, undefined);
  for (const [name, version] of Object.entries(metadata.dependencies)) {
    assert.doesNotMatch(version, /workspace:|link:|file:/);
    const dependency = JSON.parse(await readFile(join(installed, "node_modules", name, "package.json"), "utf8"));
    if (name.startsWith("@mininglamp-oss/")) {
      assert.equal(dependency.version, metadata.version);
      assert.equal(dependency.private, true);
    }
  }
  const cli = join(installed, "apps/cli/dist/index.js");
  const home = join(directory, "home");
  const run = args => execute(process.execPath, [cli, ...args, "--home", home], { cwd: directory, timeout: 10_000 });
  assert.match((await run(["--help"])).stdout, /Octo Runtime CLI/);
  const build = JSON.parse(await readFile(join(installed, "apps/cli/dist/build-info.json"), "utf8"));
  assert.match(build.commit, /^[a-f0-9]{40,64}$/);
  const versionInfo = `${metadata.version}\ncommit:${build.commit.slice(0, 12)}${build.dirty ? " (dirty)" : ""}`;
  assert.equal((await run(["--version"])).stdout.trim(), versionInfo);
  assert.match((await run([])).stdout, new RegExp(`Octo Runtime CLI \\(${metadata.version.replaceAll(".", "\\.")}\\)`));
  assert.equal((await run(["daemon"])).stdout, (await run(["daemon", "--help"])).stdout);
  const playboardHelp = (await run(["playboard", "--help"])).stdout;
  assert.match(playboardHelp, /Examples:/);
  const reference = playboardHelp.split("Reference:\n  ")[1].trim();
  await access(reference);
  // Exercise the generated global command, not just the JS entrypoint.
  const command = join(directory, process.platform === "win32" ? "octo-runtime.cmd" : "bin/octo-runtime");
  assert.match((await execute(command, ["--help"], { cwd: directory, shell: process.platform === "win32" })).stdout, /Octo Runtime CLI/);
  const consumer = process.platform === "win32" ? directory : join(directory, "lib");
  for (const [specifier, code] of [
    ["@mininglamp-oss/octo-runtime", "ERR_PACKAGE_PATH_NOT_EXPORTED"],
    ["@mininglamp-oss/octo-runtime/apps/cli/dist/index.js", "ERR_PACKAGE_PATH_NOT_EXPORTED"],
    ["@mininglamp-oss/octo-runtime/node_modules/@mininglamp-oss/octo-runtime-core/dist/index.js", "ERR_PACKAGE_PATH_NOT_EXPORTED"],
    ["@mininglamp-oss/octo-runtime-core", "ERR_MODULE_NOT_FOUND"],
    ["@mininglamp-oss/octo-runtime-daemon", "ERR_MODULE_NOT_FOUND"]
  ]) {
    const result = await execute(process.execPath, ["--input-type=module", "-e",
      `try { await import(${JSON.stringify(specifier)}); process.exitCode = 1; } catch (error) { console.log(error.code); }`],
    { cwd: consumer });
    assert.equal(result.stdout.trim(), code, specifier);
  }
  daemon = spawn(process.execPath, [join(installed, "apps/daemon/dist/index.js"), "--home", home],
    { cwd: directory, stdio: ["ignore", "ignore", "pipe"] });
  daemonExit = once(daemon, "exit");
  let errors = "";
  daemon.stderr.on("data", data => { errors += data; });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (daemon.exitCode !== null) throw new Error(errors);
    try {
      ready = JSON.parse((await run(["status"])).stdout).ready === true;
      if (ready) break;
    } catch { /* Wait for the isolated daemon socket. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, errors);
  const adapters = JSON.parse((await run(["adapter", "list"])).stdout);
  assert.ok(adapters.some(adapter => adapter.type === "codex"));
  assert.ok(adapters.some(adapter => adapter.type === "claude-code"));
  daemon.kill("SIGTERM");
  const stopTimer = setTimeout(() => daemon.kill("SIGKILL"), 10_000);
  await daemonExit;
  clearTimeout(stopTimer);
  await execute(process.execPath, [npm, "uninstall", "--global", "--prefix", directory,
    "--offline", "--cache", join(directory, "empty-cache"), "--no-audit", "--no-fund", metadata.name],
  { cwd: directory, timeout: 60_000 });
  await assert.rejects(access(installed), { code: "ENOENT" });
  await assert.rejects(access(command), { code: "ENOENT" });
  await access(home);
  console.log(JSON.stringify({ version: metadata.version, offlineInstall: true, globalCli: true,
    commit: build.commit, dirty: build.dirty,
    importsBlocked: true, daemonReady: ready, adapters: adapters.map(adapter => adapter.type),
    uninstallRemovedPackage: true, uninstallPreservedHome: true }));
} finally {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill("SIGTERM");
    const timer = setTimeout(() => daemon.kill("SIGKILL"), 10_000);
    await daemonExit;
    clearTimeout(timer);
  }
  await rm(directory, { recursive: true, force: true });
}

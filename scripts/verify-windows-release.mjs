import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { once } from "node:events";

const execute = promisify(execFile);
const archive = resolve(process.argv[2]);
const expectedCommit = process.argv[3];
if (process.platform !== "win32") throw new Error("该验收只能在 Windows 运行");
if (!/^[a-f0-9]{40,64}$/.test(expectedCommit ?? "")) {
  throw new Error("必须提供完整的十六进制 commit");
}

const directory = await mkdtemp(join(tmpdir(), "orc-win-"));
const npm = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
let daemon;
let daemonExit;

async function stopDaemon() {
  if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return;
  try {
    await execute("taskkill", ["/PID", String(daemon.pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 10_000
    });
  } catch (error) {
    if (daemon.exitCode === null && daemon.signalCode === null) throw error;
  }
  await daemonExit;
  assert.ok(daemon.exitCode !== null || daemon.signalCode !== null, "daemon 包装进程必须退出");
  daemon = undefined;
  daemonExit = undefined;
}

try {
  await execute(
    process.execPath,
    [
      npm,
      "install",
      "--global",
      "--prefix",
      directory,
      "--offline",
      "--cache",
      join(directory, "empty-cache"),
      "--no-audit",
      "--no-fund",
      archive
    ],
    { cwd: directory, timeout: 60_000 }
  );

  const installed = join(directory, "node_modules", "@mininglamp-oss/octo-runtime");
  const metadata = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  const build = JSON.parse(
    await readFile(join(installed, "apps/cli/dist/build-info.json"), "utf8")
  );
  assert.equal(build.commit, expectedCommit);
  assert.equal(build.dirty, false);

  const command = join(directory, "octo-runtime.cmd");
  const daemonCommand = join(directory, "octo-runtime-daemon.cmd");
  assert.match(
    (await execute(command, ["--help"], { cwd: directory, shell: true })).stdout,
    /Octo Runtime CLI/
  );
  await access(daemonCommand);

  const home = join(directory, "home");
  daemon = spawn(daemonCommand, ["--home", home], {
    cwd: directory,
    shell: true,
    stdio: ["ignore", "ignore", "pipe"]
  });
  daemonExit = once(daemon, "exit");
  let errors = "";
  daemon.stderr.on("data", (data) => {
    errors += data;
  });

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (daemon.exitCode !== null) throw new Error(errors);
    try {
      const result = await execute(command, ["status", "--home", home], {
        cwd: directory,
        shell: true,
        timeout: 10_000
      });
      ready = JSON.parse(result.stdout).ready === true;
      if (ready) break;
    } catch {
      /* Wait for the isolated daemon socket. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, errors);
  await stopDaemon();

  await execute(
    process.execPath,
    [
      npm,
      "uninstall",
      "--global",
      "--prefix",
      directory,
      "--offline",
      "--cache",
      join(directory, "empty-cache"),
      "--no-audit",
      "--no-fund",
      metadata.name
    ],
    { cwd: directory, timeout: 60_000 }
  );
  await assert.rejects(access(installed), { code: "ENOENT" });
  await assert.rejects(access(command), { code: "ENOENT" });
  await assert.rejects(access(daemonCommand), { code: "ENOENT" });
  await access(home);
  console.log(
    JSON.stringify({
      version: metadata.version,
      commit: build.commit,
      dirty: build.dirty,
      globalCli: true,
      daemonReady: true,
      daemonTreeStopped: true,
      uninstallRemovedPackage: true,
      uninstallPreservedHome: true
    })
  );
} finally {
  await stopDaemon();
  await rm(directory, { recursive: true, force: true });
}

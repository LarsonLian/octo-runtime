import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { readReleaseBuildInfo } from "./read-release-build-info.mjs";

const execute = promisify(execFile);
const diagnosticLimit = 4_000;

function boundedDiagnostic(value) {
  const text = String(value ?? "").trim();
  return text.length <= diagnosticLimit ? text : text.slice(-diagnosticLimit);
}

export function commandDiagnostic(error) {
  if (!error || typeof error !== "object") return boundedDiagnostic(error);
  const details = [
    error instanceof Error ? error.message : String(error),
    "stderr" in error && error.stderr ? `stderr: ${error.stderr}` : "",
    "stdout" in error && error.stdout ? `stdout: ${error.stdout}` : ""
  ].filter(Boolean);
  return boundedDiagnostic(details.join("\n"));
}

function readinessFailure(reason, lastStatusError, daemonErrors) {
  const details = [
    reason,
    lastStatusError ? `last status error:\n${commandDiagnostic(lastStatusError)}` : "",
    daemonErrors ? `daemon stderr:\n${boundedDiagnostic(daemonErrors)}` : ""
  ].filter(Boolean);
  return new Error(details.join("\n"));
}

export async function waitForDaemonReady({
  queryStatus,
  daemonExited,
  daemonStopped,
  daemonErrors = () => "",
  timeoutMs = 60_000,
  pollIntervalMs = 250,
  now = Date.now,
  delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}) {
  const deadline = now() + timeoutMs;
  let lastStatusError;
  while (now() < deadline) {
    if (daemonExited()) {
      throw readinessFailure(
        "daemon exited before reporting ready",
        lastStatusError,
        daemonErrors()
      );
    }
    const statusAbort = new AbortController();
    const status = Promise.resolve()
      .then(() => queryStatus(deadline - now(), statusAbort.signal))
      .then(
        (ready) => ({ type: "status", ready }),
        (error) => ({ type: "status_error", error })
      );
    const result = daemonStopped
      ? await Promise.race([status, daemonStopped.then(() => ({ type: "daemon_exit" }))])
      : await status;
    if (result.type === "daemon_exit") {
      statusAbort.abort();
      await status;
      throw readinessFailure(
        "daemon exited before reporting ready",
        lastStatusError,
        daemonErrors()
      );
    }
    if (result.type === "status" && result.ready) return;
    if (result.type === "status_error") lastStatusError = result.error;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await delay(Math.min(pollIntervalMs, remaining));
  }
  throw readinessFailure("daemon readiness timed out", lastStatusError, daemonErrors());
}

export async function verifyWindowsRelease(archiveInput, expectedCommit) {
  if (process.platform !== "win32") throw new Error("该验收只能在 Windows 运行");
  if (!/^[a-f0-9]{40,64}$/.test(expectedCommit ?? "")) {
    throw new Error("必须提供完整的十六进制 commit");
  }

  const archive = resolve(archiveInput);
  const directory = await mkdtemp(join(tmpdir(), "orc-win-"));
  const npm = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  let daemon;
  let daemonExit;
  let spawnError;

  async function stopDaemon() {
    if (!daemon) return;
    if (daemon.exitCode === null && daemon.signalCode === null) {
      if (!Number.isSafeInteger(daemon.pid) || daemon.pid < 1) {
        await daemonExit;
        daemon = undefined;
        daemonExit = undefined;
        return;
      }
      try {
        await execute("taskkill", ["/PID", String(daemon.pid), "/T", "/F"], {
          windowsHide: true,
          timeout: 10_000
        });
      } catch (error) {
        if (daemon.exitCode === null && daemon.signalCode === null) throw error;
      }
      await daemonExit;
      assert.ok(
        spawnError || daemon.exitCode !== null || daemon.signalCode !== null,
        "daemon 包装进程必须退出"
      );
    }
    daemon = undefined;
    daemonExit = undefined;
  }

  let failure;
  let success;
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
    assert.match(build.buildTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(new Date(build.buildTime).toISOString(), build.buildTime);
    const archivedBuild = readReleaseBuildInfo(archive);
    assert.deepEqual(build, archivedBuild);

    const command = join(directory, "octo-runtime.cmd");
    const daemonCommand = join(directory, "octo-runtime-daemon.cmd");
    const versionInfo = `${metadata.version}\ncommit:${build.commit.slice(0, 12)}\nbuild:${build.buildTime}`;
    for (const args of [["--version"], ["-v"], ["version"]]) {
      assert.equal(
        (await execute(command, args, { cwd: directory, shell: true })).stdout.trim(),
        versionInfo
      );
    }
    for (const args of [[], ["--help"], ["-h"], ["help"]]) {
      assert.ok(
        (await execute(command, args, { cwd: directory, shell: true })).stdout.includes(
          `\nbuild:${build.buildTime}\n`
        )
      );
    }
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
    daemonExit = new Promise((resolveExit) => {
      daemon.once("error", (error) => {
        spawnError = error;
        resolveExit();
      });
      daemon.once("exit", resolveExit);
    });
    let daemonErrors = "";
    daemon.stderr.on("data", (data) => {
      daemonErrors = boundedDiagnostic(`${daemonErrors}${data}`);
    });

    await waitForDaemonReady({
      daemonExited: () => daemon.exitCode !== null || daemon.signalCode !== null,
      daemonStopped: daemonExit,
      daemonErrors: () =>
        [daemonErrors, spawnError ? commandDiagnostic(spawnError) : ""].filter(Boolean).join("\n"),
      queryStatus: async (remainingMs, signal) => {
        const result = await execute(command, ["status", "--home", home], {
          cwd: directory,
          shell: true,
          signal,
          timeout: Math.max(1, Math.min(5_000, remainingMs))
        });
        return JSON.parse(result.stdout).ready === true;
      }
    });
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
    success = {
      version: metadata.version,
      commit: build.commit,
      dirty: build.dirty,
      globalCli: true,
      daemonReady: true,
      daemonTreeStopped: true,
      uninstallRemovedPackage: true,
      uninstallPreservedHome: true
    };
  } catch (error) {
    failure = error;
  }
  try {
    await stopDaemon();
  } catch (error) {
    if (!failure) failure = error;
    else console.error("daemon cleanup failed", commandDiagnostic(error));
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    if (!failure) failure = error;
    else console.error("temporary directory cleanup failed", commandDiagnostic(error));
  }
  if (failure) throw failure;
  console.log(JSON.stringify(success));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyWindowsRelease(process.argv[2], process.argv[3]);
}

import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { reapOrphanedInvocationManifest } from "@mininglamp-oss/octo-runtime-daemon";
import { probeDaemon } from "@mininglamp-oss/octo-runtime-daemon/runtime/runtime-contract";

export function temporaryDaemonEndpoint(
  directory: string,
  platform: NodeJS.Platform = process.platform
): string {
  return platform === "win32"
    ? `\\\\.\\pipe\\octo-playboard-${createHash("sha256").update(directory).digest("hex").slice(0, 16)}`
    : join(directory, "daemon.sock");
}

export async function startTemporaryDaemon(options: {
  home: string;
  profile: string;
  manifest: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}): Promise<{ socket: string; close(): Promise<void> }> {
  options.signal.throwIfAborted();
  const directory = await mkdtemp(join(await realpath(tmpdir()), "octo-playboard-"));
  const socket = temporaryDaemonEndpoint(directory);
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../../daemon/dist/index.js", import.meta.url)),
      "--execution-only",
      "--profile",
      options.profile,
      "--home",
      options.home,
      "--manifest",
      options.manifest,
      "--socket",
      socket,
      "--pid-file",
      join(directory, "daemon.pid"),
      "--state-directory",
      directory
    ],
    {
      argv0: "octo-runtime-playboard-daemon",
      env: options.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true
    }
  );
  // Neither daemon diagnostics nor readiness messages belong on stdout.
  child.stdout?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code));
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      let timer: NodeJS.Timeout | undefined;
      let timedOut = false;
      const code = await Promise.race([
        exited,
        new Promise<number | null>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
            void exited.then(resolve);
          }, 40_000);
        })
      ]).finally(() => clearTimeout(timer));
      // Reap only this invocation's manifest, including unexpected daemon death.
      const reap = await reapOrphanedInvocationManifest(join(directory, "invocations.json"));
      if (reap.reason === "daemon_alive" || reap.reason === "unsupported_identity")
        throw new Error("PLAYBOARD_DAEMON_CLEANUP_INCOMPLETE");
      await rm(directory, { recursive: true, force: true });
      if (timedOut) throw new Error("PLAYBOARD_DAEMON_SHUTDOWN_TIMEOUT");
      if (code !== 0) throw new Error("PLAYBOARD_DAEMON_EXITED_ABNORMALLY");
    })());
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("PLAYBOARD_DAEMON_START_TIMEOUT")), 30_000);
      const abort = (): void => finish(new Error("playboard daemon startup cancelled"));
      const message = (value: unknown): void => {
        if (value && typeof value === "object" && "type" in value && value.type === "daemon.ready")
          finish();
      };
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal.removeEventListener("abort", abort);
        child.removeListener("message", message);
        if (error) reject(error);
        else resolve();
      };
      child.on("message", message);
      options.signal.addEventListener("abort", abort, { once: true });
      void exited.then(() => finish(new Error("PLAYBOARD_DAEMON_START_FAILED")));
      if (options.signal.aborted) abort();
    });
    const status = await probeDaemon(socket);
    if (!status?.ready) throw new Error("PLAYBOARD_DAEMON_NOT_READY");
    options.signal.throwIfAborted();
    return { socket, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Shell-free Node.js process runner used to invoke native service managers. */
import { spawn } from "node:child_process";
import type { CommandOptions, CommandResult, CommandRunner } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_CHARS = 64 * 1024;

/**
 * Execute native manager commands with exact argv boundaries.
 *
 * Output is tail-bounded to 64 KiB per stream and timed-out commands resolve
 * with exit code 124, allowing the service layer to attach backend context.
 */
export class NodeCommandRunner implements CommandRunner {
  /** Spawn without a shell, ignore stdin, and capture bounded stdout/stderr. */
  run(
    command: string,
    args: readonly string[],
    options: CommandOptions = {}
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, timeoutMs)
          : undefined;
      timer?.unref();

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string | Buffer) => {
        stdout = appendBounded(stdout, chunk.toString());
      });
      child.stderr.on("data", (chunk: string | Buffer) => {
        stderr = appendBounded(stderr, chunk.toString());
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({
          command,
          args: [...args],
          exitCode: timedOut ? 124 : (code ?? 1),
          stdout,
          stderr: timedOut
            ? appendBounded(stderr, `\ncommand timed out after ${timeoutMs}ms`)
            : stderr
        });
      });
    });
  }
}

function appendBounded(current: string, chunk: string): string {
  return (current + chunk).slice(-MAX_CAPTURE_CHARS);
}

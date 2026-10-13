import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const enabled = process.env.OCTO_RUNTIME_DEBUG === "1";
const home =
  process.env.OCTO_HARNESS_HOME ??
  (process.platform === "win32" && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "OctoHarness")
    : join(homedir(), ".octo-harness"));
const directory = join(home, "logs");
let ready = false;
let failed = false;

/** Debug-only host log. No queue, subscriptions, capture receipts or background work. */
export function hostLog(event: string, data: unknown): void {
  if (!enabled || failed) return;
  try {
    if (!ready) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      ready = true;
    }
    appendFileSync(
      join(directory, "adapter-host.log"),
      `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, data })}\n`,
      { mode: 0o600 }
    );
  } catch {
    failed = true;
    process.stderr.write("octo-harness: unable to write adapter-host debug log\n");
  }
}

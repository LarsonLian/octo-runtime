import { HourlyLogWriter } from "@mininglamp-oss/octo-runtime-adapter-sdk";
import { homedir } from "node:os";
import { join } from "node:path";

const enabled = process.env.OCTO_RUNTIME_DEBUG === "1";
const home =
  process.env.OCTO_RUNTIME_HOME ??
  (process.platform === "win32" && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "OctoRuntime")
    : join(homedir(), ".octo-runtime"));
const directory = join(home, "logs");
let writer: HourlyLogWriter | undefined;

/** Debug-only output; retention also runs while debug is disabled. */
export function hostLog(event: string, data: unknown): void {
  writer ??= new HourlyLogWriter(directory, "adapter-host", {
    onError: () => process.stderr.write("octo-runtime: unable to maintain adapter-host debug log\n")
  });
  if (!enabled) return;
  try {
    writer.write(
      `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, data })}\n`
    );
  } catch {
    /* Diagnostics must not fail an invocation. */
  }
}

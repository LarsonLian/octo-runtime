#!/usr/bin/env node
// CLI composition owns Provider discovery; resource ownership remains in startDaemonServer().
import { inspect } from "node:util";
import { resolveDaemonRuntimePaths } from "./runtime-options.js";
import {
  startDaemonServer,
  type DaemonApplication,
  type StartDaemonServerOptions
} from "./server.js";
import { readExtraDirectory } from "@mininglamp-oss/octo-runtime-daemon";
import { join } from "node:path";
import { initializeCliOpenClaw, syncCliOpenClawToolEnvironment } from "./openclaw.js";
import { access, readdir, readFile } from "node:fs/promises";

const runtimePaths = resolveDaemonRuntimePaths();
let app: DaemonApplication | undefined;
let stopRequested = false;
let starting = true;
let closing: Promise<void> | undefined;
const stop = (): void => {
  stopRequested = true;
  if (starting || closing) return;
  closing = (app?.close() ?? Promise.resolve()).then(
    () => { process.exitCode ??= 0; },
    () => {
      console.error("daemon shutdown failed");
      process.exitCode = 1;
    }
  ).finally(() => { if (process.connected) process.disconnect(); });
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);
// A temporary daemon must also stop when its owning CLI disappears.
if (process.connected) process.once("disconnect", stop);
try {
  const home = runtimePaths.homePath!;
  if (runtimePaths.profile.toLowerCase() === "extras" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runtimePaths.profile))
    throw new Error("invalid runtime profile");
  const profiles = new Set([runtimePaths.executionOnly ? runtimePaths.profile : "default"]);
  for (const entry of runtimePaths.executionOnly ? [] : await readdir(home, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  })) {
    if (!entry.isDirectory() || entry.name.toLowerCase() === "extras" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name)) continue;
    try {
      const config: unknown = JSON.parse(
        await readFile(join(home, entry.name, "config.json"), "utf8")
      );
      if (
        config &&
        typeof config === "object" &&
        "schema_version" in config &&
        config.schema_version === 1 &&
        "profile" in config &&
        config.profile === entry.name
      )
        profiles.add(entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await access(join(home, entry.name, "adapters", "openclaw"));
        profiles.add(entry.name);
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
      }
    }
  }
  const localRuntimes: NonNullable<StartDaemonServerOptions["localRuntimes"]> = [];
  for (const profile of profiles) {
    const root = join(home, profile);
    const configured = await initializeCliOpenClaw(root);
    localRuntimes.push({
      profile,
      root,
      adapterConfigurations: {
        openclaw: { providerOptions: configured ? { OPENCLAW_RUNTIME_ROOT: root } : {} }
      }
    });
  }
  const extraDirectory = join(home, "extras");
  if (runtimePaths.consoleOutput) console.error("extras scanning", { directory: extraDirectory });
  const extras = runtimePaths.executionOnly ? [] : await readExtraDirectory(extraDirectory);
  for (const runtime of localRuntimes) {
    try {
      const result = await syncCliOpenClawToolEnvironment(runtime.root, extras);
      if (result.file)
        console.error("OpenClaw octo-cli environment", {
          ...result,
          notice: "Restart the OpenClaw Gateway manually to load dotenv changes."
        });
    } catch {
      console.error("OpenClaw: OPENCLAW_TOOL_ENV_SYNC_FAILED");
      runtime.adapterConfigurations = {
        ...runtime.adapterConfigurations,
        openclaw: { providerOptions: {} }
      };
    }
  }
  if (runtimePaths.consoleOutput)
    console.error("extras discovered", {
      count: extras.length,
      entries: extras.map(({ name, enabled }) => ({ name, enabled: enabled !== false }))
    });
  app = await startDaemonServer({ ...runtimePaths, localRuntimes, extras });
  if (!stopRequested && process.connected)
    process.send?.({ type: "daemon.ready" }, (error: Error | null) => { if (error) stop(); });
} catch (error) {
  const verbose = process.argv.includes("--verbose");
  const message = error instanceof Error ? error.message : String(error);
  console.error(verbose ? inspect(error, { depth: null, colors: false }) : `❌ ${message}`);
  process.exitCode = 1;
} finally {
  starting = false;
  if (stopRequested) stop();
  else if (!app && process.connected) process.disconnect();
}

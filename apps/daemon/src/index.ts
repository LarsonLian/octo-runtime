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
import { initializeCliOpenClaw } from "./openclaw.js";
import { access, readdir, readFile } from "node:fs/promises";

const runtimePaths = resolveDaemonRuntimePaths();
let app: DaemonApplication | undefined;
try {
  const home = runtimePaths.homePath!;
  const profiles = new Set(["default"]);
  for (const entry of await readdir(home, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  })) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name)) continue;
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
  const extraDirectory = join(home, "default", "extra");
  if (runtimePaths.consoleOutput) console.error("extras scanning", { directory: extraDirectory });
  const extras = await readExtraDirectory(extraDirectory);
  if (runtimePaths.consoleOutput) console.error("extras discovered", {
    count: extras.length,
    entries: extras.map(({ name, enabled }) => ({ name, enabled: enabled !== false }))
  });
  app = await startDaemonServer({ ...runtimePaths, localRuntimes, extras });
} catch (error) {
  const verbose = process.argv.includes("--verbose");
  const message = error instanceof Error ? error.message : String(error);
  console.error(verbose ? inspect(error, { depth: null, colors: false }) : `❌ ${message}`);
  process.exitCode = 1;
}

if (app) {
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    // The signal handler must return immediately; the actual cleanup still runs
    // serially through this single close() promise.
    void app.close().then(
      () => process.exit(0),
      (error) => {
        console.error("daemon shutdown failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        console.error(
          JSON.stringify({
            event: "daemon.shutdown.failed",
            error: error instanceof Error ? error.message : String(error)
          })
        );
        process.exit(1);
      }
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
}

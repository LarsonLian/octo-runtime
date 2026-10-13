import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createServiceBackend,
  type ServiceBackend,
  type ServiceSpec
} from "@mininglamp-oss/octo-harness-cross-service";
import type { HarnessPaths } from "./state.js";

export const HARNESS_SERVICE_ID = "cn.mininglamp.octo-harness.daemon";

export interface ServiceControlOptions {
  backend?: ServiceBackend;
  daemonEntrypoint?: string;
  nodeExecutable?: string;
  systemHome?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
}

export function resolveServiceControl(options: ServiceControlOptions = {}): {
  backend: ServiceBackend;
  spec(paths: HarnessPaths, enabled?: boolean, daemonArgs?: string[]): ServiceSpec;
} {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const daemonEntrypoint = resolve(options.daemonEntrypoint
    ?? fileURLToPath(new URL("../../daemon/dist/launcher.js", import.meta.url)));
  const nodeExecutable = resolve(options.nodeExecutable ?? process.execPath);
  const backend = options.backend ?? createServiceBackend({
    platform,
    homeDirectory: options.systemHome ?? homedir()
  });
  return {
    backend,
    spec(paths: HarnessPaths, enabled = true, daemonArgs: string[] = []): ServiceSpec {
      const output = platform === "win32"
        ? {}
        : {
            stdoutPath: resolve(paths.logs, "service.out.log"),
            stderrPath: resolve(paths.logs, "service.err.log")
          };
      return {
        id: HARNESS_SERVICE_ID,
        description: "Octo Harness daemon",
        command: nodeExecutable,
        args: [daemonEntrypoint, "--home", paths.home, ...daemonArgs],
        workingDirectory: paths.home,
        environment: {
          ...(environment.PATH || environment.Path ? { PATH: environment.PATH ?? environment.Path ?? "" } : {}),
          ...(environment.OCTO_RUNTIME_DEBUG === "1" ? { OCTO_RUNTIME_DEBUG: "1" } : {})
        },
        enabled,
        restart: { policy: "on-failure", delaySeconds: 5, maxBurst: 5 },
        timeoutStopSeconds: 45,
        names: {
          launchdLabel: HARNESS_SERVICE_ID,
          systemdUnit: `${HARNESS_SERVICE_ID}.service`,
          windowsTaskName: "\\OctoHarness.daemon"
        },
        ...output
      };
    }
  };
}

export async function verifyServiceProgram(spec: ServiceSpec): Promise<void> {
  await Promise.all([access(spec.command), access(spec.args?.[0] ?? "")]);
  await mkdir(spec.workingDirectory, { recursive: true, mode: 0o700 });
  await mkdir(dirname(spec.stdoutPath ?? resolve(spec.workingDirectory, "logs", "service.out.log")), {
    recursive: true,
    mode: 0o700
  });
}

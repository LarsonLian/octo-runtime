import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createServiceBackend,
  type ServiceBackend,
  type ServiceSpec
} from "@mininglamp-oss/octo-runtime-cross-service";
import type { RuntimePaths } from "./state.js";

export const RUNTIME_SERVICE_ID = "cn.mininglamp.octo-runtime.daemon";

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
  spec(paths: RuntimePaths, enabled?: boolean, daemonArgs?: string[]): ServiceSpec;
} {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const daemonEntrypoint = resolve(
    options.daemonEntrypoint ??
      fileURLToPath(new URL("../../daemon/dist/launcher.js", import.meta.url))
  );
  const nodeExecutable = resolve(options.nodeExecutable ?? process.execPath);
  const backend =
    options.backend ??
    createServiceBackend({
      platform,
      homeDirectory: options.systemHome ?? homedir()
    });
  return {
    backend,
    spec(paths: RuntimePaths, enabled = true, daemonArgs: string[] = []): ServiceSpec {
      return {
        id: RUNTIME_SERVICE_ID,
        description: "Octo Runtime daemon",
        command: nodeExecutable,
        args: [daemonEntrypoint, "--home", paths.home, "--managed-logs", ...daemonArgs],
        workingDirectory: paths.home,
        environment: {
          ...(environment.PATH || environment.Path
            ? { PATH: environment.PATH ?? environment.Path ?? "" }
            : {}),
          ...(environment.OCTO_RUNTIME_DEBUG === "1" ? { OCTO_RUNTIME_DEBUG: "1" } : {})
        },
        enabled,
        restart: { policy: "on-failure", delaySeconds: 5, maxBurst: 5 },
        timeoutStopSeconds: 45,
        names: {
          launchdLabel: RUNTIME_SERVICE_ID,
          systemdUnit: `${RUNTIME_SERVICE_ID}.service`,
          windowsTaskName: "\\OctoRuntime.daemon"
        }
      };
    }
  };
}

export async function verifyServiceProgram(spec: ServiceSpec): Promise<void> {
  await Promise.all([access(spec.command), access(spec.args?.[0] ?? "")]);
  await mkdir(spec.workingDirectory, { recursive: true, mode: 0o700 });
  await mkdir(
    dirname(spec.stdoutPath ?? resolve(spec.workingDirectory, "logs", "service.out.log")),
    {
      recursive: true,
      mode: 0o700
    }
  );
}

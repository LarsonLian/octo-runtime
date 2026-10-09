import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  defineAdapter,
  probeCommand,
  type AdapterInvocationContext,
  type InvokeRequest,
  type ProbeResult
} from "@mininglamp-oss/octo-harness-adapter-sdk";
import {
  runZcodeAppServerTurn,
  type ZcodeAppServerCommand,
  type ZcodeAppServerSpawn
} from "./app-server.js";

export {
  normalizeZcodeEvent,
  runZcodeAppServerTurn,
  ZcodeAppServerProcessError,
  ZcodeAppServerRpcError,
  ZcodeEventNormalizer,
  type ZcodeAppServerCommand,
  type ZcodeAppServerSpawn,
  type ZcodeSessionEvent
} from "./app-server.js";

const DEFAULT_APP_SERVER_ARGS = [
  "app-server",
  "--stdio",
  "--disallowed-tools",
  "CronCreate CronList CronUpdate CronDelete"
];

/** Resolve the CLI embedded in ZCode Desktop when no PATH command is installed. */
export function discoverZcodeBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = nonEmptyString(env.ZCODE_BIN);
  if (configured) return resolve(configured);

  const pathCommand = findOnPath("zcode", env);
  if (pathCommand) return pathCommand;

  const home = homedir();
  const candidates = process.platform === "win32"
    ? [join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "ZCode", "resources", "glm", "zcode.cjs")]
    : process.platform === "darwin"
      ? [
          "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
          join(home, "Applications", "ZCode.app", "Contents", "Resources", "glm", "zcode.cjs")
        ]
      : [
          "/opt/ZCode/resources/glm/zcode.cjs",
          "/usr/share/zcode/resources/glm/zcode.cjs"
        ];
  return candidates.find(existsSync);
}

/** Build the exact subprocess command for one invocation. */
export function buildZcodeCommand(
  request: InvokeRequest,
  command?: string,
  appServerArgs?: readonly string[]
): ZcodeAppServerCommand {
  if (command) {
    return {
      command,
      args: [...(appServerArgs ?? DEFAULT_APP_SERVER_ARGS)],
      cwd: request.workdir,
      env: { ...process.env }
    };
  }

  const zcodeBin = discoverZcodeBin();
  if (!zcodeBin) {
    return {
      command: "zcode",
      args: [...(appServerArgs ?? DEFAULT_APP_SERVER_ARGS)],
      cwd: request.workdir,
      env: { ...process.env }
    };
  }
  const args = [...(appServerArgs ?? DEFAULT_APP_SERVER_ARGS)];
  return isJavaScriptEntry(zcodeBin)
    ? { command: process.execPath, args: [zcodeBin, ...args], cwd: request.workdir, env: { ...process.env } }
    : { command: zcodeBin, args, cwd: request.workdir, env: { ...process.env } };
}

export async function probeZcodeGui(env: NodeJS.ProcessEnv = process.env): Promise<ProbeResult> {
  const zcodeBin = discoverZcodeBin(env);
  if (!zcodeBin) return probeCommand("zcode", { env });
  if (!isJavaScriptEntry(zcodeBin)) return probeCommand(zcodeBin, { env });
  if (!existsSync(zcodeBin)) return { available: false, command: zcodeBin, reason: "command_not_found" };
  let version: string | null = null;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [zcodeBin, "--version"], {
      env,
      timeout: 2_000,
      maxBuffer: 4_096,
      windowsHide: true
    });
    version = stdout.match(/(?:^|\s)v?(\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?)(?=\s|$)/)?.[1] ?? null;
  } catch {
    // Availability is distinct from version support, matching the shared probe contract.
  }
  return { available: true, command: zcodeBin, version };
}

export function createZcodeGuiAdapter({
  command,
  appServerArgs,
  spawnFn
}: {
  command?: string;
  appServerArgs?: readonly string[];
  spawnFn?: ZcodeAppServerSpawn;
} = {}) {
  return defineAdapter({
    metadata: {
      type: "zcode-gui",
      capabilities: ["react"],
      agentSources: ["provisioned"],
      executionFeatures: ["session.serialize", "session.resume_recovery", "tool.canonical"],
      processModel: "subprocess-per-invocation",
      transport: "zcode-ndjson-rpc/stdio"
    },
    probe: () => command ? probeCommand(command) : probeZcodeGui(),
    async *invoke(request: InvokeRequest, context?: AdapterInvocationContext) {
      const spec = buildZcodeCommand(request, command, appServerArgs);
      yield* runZcodeAppServerTurn({ request, spec, context, ...(spawnFn ? { spawnFn } : {}) });
    }
  });
}

function findOnPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const extensions = process.platform === "win32"
    ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")]
    : [""];
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = resolve(directory, command + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function isJavaScriptEntry(path: string): boolean {
  return [".cjs", ".mjs", ".js"].includes(extname(path).toLowerCase());
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const zcodeGuiAdapter = createZcodeGuiAdapter();
export default zcodeGuiAdapter;

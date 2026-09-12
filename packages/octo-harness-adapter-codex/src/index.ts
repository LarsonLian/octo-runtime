/**
 * Assembly entry point for the Codex adapter.
 *
 * This file only handles "how to prepare one invocation": selecting the real
 * CODEX_HOME, declaring adapter metadata, and delegating execution to the
 * app-server transport. Per-run developer instructions travel in native thread
 * params, so app-server sees the complete state database and plugin runtime.
 */
import { defineAdapter, probeCommand, type AdapterInvocationContext, type InvokeRequest } from "@mininglamp-oss/octo-harness-adapter-sdk";
import { parse, stringify } from "smol-toml";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCodexAppServerArgs,
  runCodexAppServerTurn,
  type CodexAppServerCommand,
  type CodexAppServerSpawn
} from "./app-server.js";

export {
  buildCodexAppServerArgs,
  CodexEventNormalizer,
  CodexAppServerProcessError,
  CodexAppServerRpcError,
  normalizeCodexEvent,
  runCodexAppServerTurn,
  type CodexAppServerCommand,
  type CodexAppServerNotification,
  type CodexAppServerSpawn
} from "./app-server.js";

/** Read an optional resource; only ENOENT is ignored, permission and I/O errors must surface to the caller. */
async function readOptional(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/**
 * Symlink resources that exist in the real CODEX_HOME into the temp directory.
 *
 * Only a missing source is tolerated; errors such as EACCES or a target conflict
 * must not be swallowed, otherwise we get a Codex process that looks launchable
 * but actually lacks its auth or session state.
 */
async function linkOptional(
  source: string,
  target: string,
  type: Parameters<typeof symlink>[2]
): Promise<void> {
  try {
    await symlink(source, target, type);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Construct a shadow CODEX_HOME for compatibility tests and callers that need
 * a standalone config overlay. Production app-server invocations intentionally
 * do not use it: current Codex versions keep startup state databases in HOME,
 * and a partial shadow triggers state backfill and lock waits.
 *
 * Design goals:
 * 1. harness instructions affect only this turn and never rewrite the user's
 *    real config.toml;
 * 2. auth, session rollout, skills and rules are still provided by the real HOME;
 * 3. on normal completion, failure or cancellation the caller can always delete
 *    the temp directory via cleanup.
 *
 * This is a config overlay, not filesystem or security isolation: the symlinks
 * are live aliases of the real resources, so Codex writes through these paths
 * land in the real HOME. It is also not equivalent to Aily's per-session state
 * mirror: state SQLite, hooks, the MCP bridge and the skill allowlist are not yet
 * copied; see the README for the exact boundary.
 */
export async function createCodexInvocationHome(
  instructions: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const real = env.CODEX_HOME || join(homedir(), ".codex");
  const shadow = await mkdtemp(join(tmpdir(), "octo-harness-codex-"));

  // Copy the config, then override only the private developer instructions; the real config.toml stays read-only.
  const configText = await readOptional(join(real, "config.toml"));
  const config = configText ? parse(configText) : {};
  config.developer_instructions = instructions;
  await writeFile(join(shadow, "config.toml"), stringify(config), { mode: 0o600 });

  // sessions needs a stable real path so thread/resume can find the previous turn's rollout.
  await mkdir(join(real, "sessions"), { recursive: true });
  await Promise.all([
    linkOptional(join(real, "auth.json"), join(shadow, "auth.json"), "file"),
    linkOptional(join(real, "sessions"), join(shadow, "sessions"), "dir"),
    linkOptional(join(real, "skills"), join(shadow, "skills"), "dir"),
    linkOptional(join(real, "rules"), join(shadow, "rules"), "dir")
  ]);
  return { home: shadow, cleanup: () => rm(shadow, { recursive: true, force: true }) };
}

/**
 * Convert an Octo Harness InvokeRequest into a launchable app-server process spec.
 *
 * The user prompt never appears in argv; it is written to stdin later via
 * turn/start. The parent process environment is inherited whole and only
 * The complete real CODEX_HOME is reused. Per-run instructions are sent through
 * thread/start or thread/resume `developerInstructions`, never written to the
 * user's config.toml.
 */
export function buildCodexCommand(
  req: InvokeRequest,
  command = "codex",
  appServerArgs = buildCodexAppServerArgs()
): CodexAppServerCommand {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  return {
    command,
    args: [...appServerArgs],
    cwd: req.workdir,
    env: { ...process.env, CODEX_HOME: codexHome },
    cleanup: () => undefined
  };
}

/**
 * Create the Codex adapter.
 *
 * command/appServerArgs/spawnFn are all injectable, mainly to test the real
 * stdin/stdout JSON-RPC without connecting to a real Codex service in tests. The
 * production defaults always run `codex app-server --listen stdio://`.
 * Provider observation is forwarded to the transport unchanged because only
 * the app-server layer knows the final JSON-RPC params and write/response
 * boundaries.
 */
export function createCodexAdapter({
  command = "codex",
  appServerArgs = buildCodexAppServerArgs(),
  spawnFn
}: {
  command?: string;
  appServerArgs?: string[];
  spawnFn?: CodexAppServerSpawn;
} = {}) {
  return defineAdapter({
    metadata: {
      type: "codex",
      // Thread serialization and same-turn fresh fallback are end-to-end supported.
      capabilities: ["session.serialize", "session.resume_recovery"],
      processModel: "subprocess-per-invocation",
      transport: "json-rpc-2.0/stdio"
    },
    probe: () => probeCommand(command),
    async *invoke(request: InvokeRequest, context?: AdapterInvocationContext) {
      // The transport owns cleanup as well as observation ordering, so the
      // shadow home cannot be deleted while its final RPC is still in flight.
      const spec = buildCodexCommand(request, command, appServerArgs);
      yield* runCodexAppServerTurn({ request, spec, context, ...(spawnFn ? { spawnFn } : {}) });
    }
  });
}

export const codexAdapter = createCodexAdapter();
export default codexAdapter;

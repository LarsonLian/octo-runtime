import { readFile, mkdir, writeFile, rename, lstat, chmod, rm } from "node:fs/promises";
import { parseEnv, promisify } from "node:util";
import { execFile } from "node:child_process";
import type { ExtraRegistration } from "@mininglamp-oss/octo-runtime-daemon";
import {
  configuredCredential,
  validateImBots,
  octoCliEnvironment
} from "@mininglamp-oss/octo-runtime-extra-channel-gateway";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import JSON5 from "json5";
import {
  configureOpenClawConnection,
  readOpenClawConnection,
  loadLocalOpenClawGateway,
  LocalGatewayError,
  createOpenClawAdapter,
  OPENCLAW_RUNTIME_ROOT,
  type OpenClawConnectionInput
} from "@mininglamp-oss/octo-runtime-adapter-openclaw";

export interface CliOpenClawInput extends OpenClawConnectionInput {
  openclawHome?: string;
}

/** CLI composition only: resolve discovery before entering the shared execution path. */
export async function configureCliOpenClaw(
  runtimeRoot: string,
  input: CliOpenClawInput = {},
  env: NodeJS.ProcessEnv = process.env
) {
  const explicit = Object.values(input).some((value) => value !== undefined);
  let savedConfigFile: string | undefined;
  if (!explicit) {
    const saved = await readOpenClawConnection(runtimeRoot);
    if (saved) {
      const origin = await readCliOrigin(runtimeRoot);
      if (origin?.credential_ref === saved.credential_ref) {
        input = { openclawHome: origin.openclaw_home };
        savedConfigFile = origin.openclaw_config_path;
      } else {
        await loadLocalOpenClawGateway(runtimeRoot);
        return saved;
      }
    } else {
      input = {
        openclawHome: env.OPENCLAW_HOME,
        url: env.OPENCLAW_GATEWAY_URL,
        token: env.OPENCLAW_GATEWAY_TOKEN
      };
    }
  }
  if (input.openclawHome !== undefined && (input.url !== undefined || input.token !== undefined))
    throw new LocalGatewayError("connection_sources_conflict");
  if (input.url !== undefined || input.token !== undefined)
    return configureOpenClawConnection(runtimeRoot, input);
  if (input.openclawHome !== undefined && !input.openclawHome.trim())
    throw new LocalGatewayError("openclaw_home_invalid");
  let configFile = env.OPENCLAW_CONFIG_PATH;
  if (input.openclawHome === undefined && !configFile && !env.OPENCLAW_STATE_DIR) {
    try {
      const output = await promisify(execFile)("openclaw", ["config", "file", "--json"], {
        env,
        timeout: 5000,
        maxBuffer: 64 * 1024
      });
      const discovered = record(JSON.parse(output.stdout));
      if (typeof discovered?.path === "string") configFile = discovered.path;
    } catch {
      /* An absent optional CLI falls back to the established local source. */
    }
  }
  const expand = (path: string) => resolve(path.replace(/^~(?=\/|$)/, env.HOME || homedir()));
  const home = expand(
    input.openclawHome ??
      env.OPENCLAW_STATE_DIR ??
      join(env.HOME || homedir(), env.OPENCLAW_PROFILE ? `.openclaw-${env.OPENCLAW_PROFILE}` : ".openclaw")
  );
  const activeConfig =
    savedConfigFile ??
    (input.openclawHome !== undefined
      ? join(home, "openclaw.json")
      : configFile
        ? expand(configFile)
        : join(home, "openclaw.json"));
  const connection = await readOpenClawHome(home, activeConfig);
  const saved = await configureOpenClawConnection(runtimeRoot, connection);
  const directory = join(runtimeRoot, "adapters", "openclaw");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.cli-source-${randomUUID()}.tmp`);
  await writeFile(
    temporary,
    JSON.stringify({
      openclaw_home: home,
      openclaw_config_path: activeConfig,
      credential_ref: saved.credential_ref
    }),
    { mode: 0o600 }
  );
  await rename(temporary, join(directory, "cli-source.json"));
  return saved;
}

async function readCliOrigin(
  root: string
): Promise<
  { openclaw_home: string; openclaw_config_path?: string; credential_ref: string } | undefined
> {
  try {
    const value = record(
      JSON.parse(await readFile(join(root, "adapters", "openclaw", "cli-source.json"), "utf8"))
    );
    if (typeof value?.openclaw_home !== "string" || typeof value?.credential_ref !== "string")
      throw new LocalGatewayError("cli_source_invalid");
    return {
      openclaw_home: value.openclaw_home,
      ...(typeof value.openclaw_config_path === "string"
        ? { openclaw_config_path: value.openclaw_config_path }
        : {}),
      credential_ref: value.credential_ref
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new LocalGatewayError("cli_source_invalid");
  }
}

/** CLI startup only. One instance has one shared dotenv identity; last configured Bot wins. */
export async function syncCliOpenClawToolEnvironment(
  runtimeRoot: string,
  extras: readonly ExtraRegistration[]
): Promise<{ file?: string; written: boolean; restartRequired: boolean }> {
  const channel = extras.find(
    (extra) => extra.name === "channel-gateway" && extra.enabled !== false
  );
  if (!channel || channel.config.bots === undefined)
    return { written: false, restartRequired: false };
  const bots = channel.config.bots;
  validateImBots(bots);
  let values: Record<string, string> | undefined;
  for (const bot of bots) {
    if (bot.enabled === false) continue;
    const token = configuredCredential(bot);
    if (!token) throw new Error("IM_CREDENTIALS_REQUIRED");
    values = Object.fromEntries(
      octoCliEnvironment(bot.api_url, token).env_variables.map(({ key, value }) => [key, value])
    );
  }
  if (!values) return { written: false, restartRequired: false };
  const origin = await readCliOrigin(runtimeRoot);
  const connection = await readOpenClawConnection(runtimeRoot);
  if (!origin || origin.credential_ref !== connection?.credential_ref)
    return { written: false, restartRequired: false };
  const file = join(origin.openclaw_home, ".env");
  const directory = await lstat(origin.openclaw_home);
  if (!directory.isDirectory()) throw new Error("OPENCLAW_ENV_DIRECTORY_INVALID");
  let previous = "";
  try {
    const info = await lstat(file);
    if (!info.isFile()) throw new Error("OPENCLAW_ENV_FILE_INVALID");
    previous = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Remove only complete managed assignments, including quoted multiline values.
  const retained = previous.replace(
    /^[\t ]*(?:export[\t ]+)?(?:OCTO_BOT_TOKEN|OCTO_API_BASE_URL)[\t ]*=[\t ]*(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\r\n]*)(?:[\t ]*#[^\r\n]*)?[\t ]*(?:\r?\n|$)/gm,
    ""
  );
  const content =
    retained +
    (retained && !retained.endsWith("\n") ? "\n" : "") +
    Object.entries(values)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}\n`)
      .join("");
  const before = parseEnv(previous),
    after = parseEnv(content);
  if (
    Object.entries(before).some(
      ([key, value]) => !Object.hasOwn(values, key) && after[key] !== value
    ) ||
    Object.entries(values).some(([key, value]) => after[key] !== value)
  )
    throw new Error("OPENCLAW_ENV_UPDATE_INVALID");
  if (content === previous) {
    await chmod(file, 0o600);
    return { file, written: false, restartRequired: true };
  }
  const temporary = join(origin.openclaw_home, `.octo-env-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return { file, written: true, restartRequired: true };
}

/** An absent optional Provider must not prevent the CLI daemon from starting. */
export async function initializeCliOpenClaw(
  runtimeRoot: string,
  env = process.env
): Promise<boolean> {
  try {
    await configureCliOpenClaw(runtimeRoot, {}, env);
    const probe = await createOpenClawAdapter().probe({
      providerOptions: { [OPENCLAW_RUNTIME_ROOT]: runtimeRoot }
    });
    if (!probe.available) console.error(`OpenClaw: ${probe.reason}`);
    return true;
  } catch (error) {
    if (error instanceof LocalGatewayError && error.reason === "config_not_found")
      return (await readOpenClawConnection(runtimeRoot)) === undefined;
    // Report only controlled reason codes; never echo config contents or credentials.
    if (error instanceof LocalGatewayError) {
      console.error(`OpenClaw: ${error.reason}`);
      return false;
    }
    throw error;
  }
}

async function readOpenClawHome(
  home: string,
  configFile = join(home, "openclaw.json")
): Promise<{ url: string; token: string }> {
  let source: string;
  try {
    source = await readFile(configFile, "utf8");
  } catch (error) {
    throw new LocalGatewayError(
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "config_not_found" : "config_unreadable"
    );
  }
  let config: Record<string, unknown>;
  try {
    const parsed = record(JSON5.parse(source));
    if (!parsed) throw new Error();
    config = parsed;
  } catch {
    throw new LocalGatewayError("config_invalid");
  }
  const gateway = record(config.gateway);
  if (
    Object.hasOwn(config, "$include") ||
    !gateway ||
    (gateway.mode && gateway.mode !== "local") ||
    record(gateway.tls)?.enabled
  )
    throw new LocalGatewayError("config_unsupported");
  const auth = record(gateway.auth);
  const token = auth?.token;
  if (
    (auth?.mode && auth.mode !== "token") ||
    typeof token !== "string" ||
    !token.trim() ||
    token.includes("${")
  )
    throw new LocalGatewayError("auth_config_unsupported");
  const port = gateway.port ?? 18789;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new LocalGatewayError("config_invalid");
  const bind = gateway.bind ?? "loopback";
  const host = bind === "custom" ? gateway.customBindHost : "127.0.0.1";
  const localAddresses = Object.values(networkInterfaces()).flatMap(
    (entries) => entries?.map((entry) => entry.address) ?? []
  );
  if (
    typeof bind !== "string" ||
    !["loopback", "lan", "auto", "custom"].includes(bind) ||
    typeof host !== "string" ||
    !isIP(host) ||
    !["127.0.0.1", "::1", "0.0.0.0", "::", ...localAddresses].includes(host)
  )
    throw new LocalGatewayError("local_address_unsupported");
  const localHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return { url: `ws://${isIP(localHost) === 6 ? `[${localHost}]` : localHost}:${port}`, token };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

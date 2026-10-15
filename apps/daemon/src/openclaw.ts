import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
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
  if (!explicit) {
    const saved = await readOpenClawConnection(runtimeRoot);
    if (saved) {
      const origin = await readCliOrigin(runtimeRoot);
      if (origin?.credential_ref === saved.credential_ref) {
        input = { openclawHome: origin.openclaw_home };
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
  const home = resolve(input.openclawHome ?? join(env.HOME || homedir(), ".openclaw"));
  const connection = await readOpenClawHome(home);
  const saved = await configureOpenClawConnection(runtimeRoot, connection);
  const directory = join(runtimeRoot, "adapters", "openclaw");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.cli-source-${randomUUID()}.tmp`);
  await writeFile(
    temporary,
    JSON.stringify({ openclaw_home: home, credential_ref: saved.credential_ref }),
    { mode: 0o600 }
  );
  await rename(temporary, join(directory, "cli-source.json"));
  return saved;
}

async function readCliOrigin(
  root: string
): Promise<{ openclaw_home: string; credential_ref: string } | undefined> {
  try {
    const value = record(
      JSON.parse(await readFile(join(root, "adapters", "openclaw", "cli-source.json"), "utf8"))
    );
    if (typeof value?.openclaw_home !== "string" || typeof value?.credential_ref !== "string")
      throw new LocalGatewayError("cli_source_invalid");
    return { openclaw_home: value.openclaw_home, credential_ref: value.credential_ref };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new LocalGatewayError("cli_source_invalid");
  }
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

async function readOpenClawHome(home: string): Promise<{ url: string; token: string }> {
  let source: string;
  try {
    source = await readFile(join(home, "openclaw.json"), "utf8");
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

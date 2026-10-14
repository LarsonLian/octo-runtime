import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import JSON5 from "json5";
import {
  createOpenClawDeviceIdentity,
  type OpenClawDeviceIdentity,
  type OpenClawGatewayOptions
} from "./gateway.js";

export const OPENCLAW_RUNTIME_ROOT = "OPENCLAW_RUNTIME_ROOT";
export type OpenClawConnection =
  | { schema_version: 1; source: "home"; openclaw_home: string }
  | { schema_version: 1; source: "gateway"; gateway_url: string; credential_ref: string };
export interface OpenClawConnectionInput {
  openclawHome?: string;
  url?: string;
  token?: string;
}

export class LocalGatewayError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** A connection belongs to one Runtime profile, independently of the target Agent. */
export async function configureOpenClawConnection(
  runtimeRoot: string,
  input: OpenClawConnectionInput = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<OpenClawConnection> {
  const path = connectionPath(runtimeRoot);
  const explicit = Object.values(input).some((value) => value !== undefined);
  if (!explicit) {
    const saved = await readOptional(path);
    if (saved !== undefined) return assertConnection(saved);
    input = {
      openclawHome: env.OPENCLAW_HOME,
      url: env.OPENCLAW_GATEWAY_URL,
      token: env.OPENCLAW_GATEWAY_TOKEN
    };
  }
  const connection = await connectionFromInput(runtimeRoot, input, env);
  // Concurrent initial probes must agree on the same persisted source.
  await writePrivateJson(path, connection, !explicit);
  return assertConnection(await readOptional(path));
}

async function connectionFromInput(
  runtimeRoot: string,
  input: OpenClawConnectionInput,
  env: NodeJS.ProcessEnv
): Promise<OpenClawConnection> {
  if (input.openclawHome !== undefined && (input.url !== undefined || input.token !== undefined))
    throw new LocalGatewayError("connection_sources_conflict");
  if (input.url !== undefined || input.token !== undefined) {
    if (!input.url?.trim() || !input.token?.trim())
      throw new LocalGatewayError("gateway_url_and_token_required");
    const url = normalizeOpenClawGatewayUrl(input.url);
    // A distinct credential file makes a source change atomic for concurrent readers.
    const credentialRef = `credentials/openclaw-gateway-${randomUUID()}.json`;
    await writePrivateJson(join(runtimeRoot, credentialRef), {
      schema_version: 1,
      access_token: input.token
    });
    return {
      schema_version: 1,
      source: "gateway",
      gateway_url: url,
      credential_ref: credentialRef
    };
  }
  if (input.openclawHome !== undefined && !input.openclawHome.trim())
    throw new LocalGatewayError("openclaw_home_invalid");
  return {
    schema_version: 1,
    source: "home",
    openclaw_home: resolve(input.openclawHome ?? join(env.HOME || homedir(), ".openclaw"))
  };
}

/** Re-read both the source and credentials for every probe/invocation; never reset Gateway tokens. */
export async function loadLocalOpenClawGateway(
  runtimeRoot: string
): Promise<OpenClawGatewayOptions> {
  const connection = await configureOpenClawConnection(runtimeRoot);
  let url: string, token: string;
  if (connection.source === "home") {
    ({ url, token } = await readOpenClawHome(connection.openclaw_home));
  } else {
    url = connection.gateway_url;
    const credential = record(await readOptional(join(runtimeRoot, connection.credential_ref)));
    if (
      credential?.schema_version !== 1 ||
      typeof credential.access_token !== "string" ||
      !credential.access_token.trim()
    )
      throw new LocalGatewayError("gateway_credential_invalid");
    token = credential.access_token;
  }
  const path = join(runtimeRoot, "credentials", "openclaw-device.json");
  let device = await readOptional(path);
  if (device === undefined) {
    await writePrivateJson(path, createOpenClawDeviceIdentity(), true);
    device = await readOptional(path);
  }
  assertDeviceIdentity(device);
  return { url, token, device, connectTimeoutMs: 1_000, requestTimeoutMs: 1_000 };
}

/** Trusted local options are shared by the probe and invocation paths. */
export async function resolveOpenClawGateway(
  options: Record<string, unknown> = {}
): Promise<OpenClawGatewayOptions> {
  const root = options[OPENCLAW_RUNTIME_ROOT];
  if (root !== undefined) {
    if (typeof root !== "string" || !isAbsolute(root))
      throw new LocalGatewayError("runtime_root_invalid");
    return loadLocalOpenClawGateway(root);
  }
  // Direct SDK callers may supply an already-resolved connection without a managed Runtime.
  const url = options.OPENCLAW_GATEWAY_URL;
  const token = options.OPENCLAW_GATEWAY_TOKEN;
  const device = {
    deviceId: options.OPENCLAW_GATEWAY_DEVICE_ID,
    publicKey: options.OPENCLAW_GATEWAY_PUBLIC_KEY,
    privateKey: options.OPENCLAW_GATEWAY_PRIVATE_KEY
  };
  if (typeof url !== "string" || !url || typeof token !== "string" || !token)
    throw new LocalGatewayError("runtime_configuration_missing");
  assertDeviceIdentity(device);
  return {
    url: normalizeOpenClawGatewayUrl(url),
    token,
    device,
    connectTimeoutMs: 1_000,
    requestTimeoutMs: 1_000
  };
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

export function normalizeOpenClawGatewayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocalGatewayError("gateway_url_invalid");
  }
  if (
    !["ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new LocalGatewayError("gateway_url_invalid");
  if (url.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new LocalGatewayError("remote_gateway_requires_wss");
  return url.toString();
}

function connectionPath(root: string): string {
  return join(root, "adapters", "openclaw", "connection.json");
}
function assertConnection(value: unknown): OpenClawConnection {
  const connection = record(value);
  if (connection?.schema_version !== 1) throw new LocalGatewayError("connection_config_invalid");
  if (
    connection.source === "home" &&
    typeof connection.openclaw_home === "string" &&
    isAbsolute(connection.openclaw_home)
  )
    return connection as unknown as OpenClawConnection;
  if (
    connection.source === "gateway" &&
    typeof connection.gateway_url === "string" &&
    typeof connection.credential_ref === "string" &&
    /^credentials\/openclaw-gateway-[0-9a-f-]{36}\.json$/.test(connection.credential_ref)
  ) {
    normalizeOpenClawGatewayUrl(connection.gateway_url);
    return connection as unknown as OpenClawConnection;
  }
  throw new LocalGatewayError("connection_config_invalid");
}
async function readOptional(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new LocalGatewayError("connection_file_invalid");
  }
}
async function writePrivateJson(path: string, value: unknown, createOnly = false): Promise<void> {
  const root = resolve(path, "..");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = join(root, `.openclaw-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    if (createOnly) await link(temporary, path);
    else await rename(temporary, path);
  } catch (error) {
    if (!createOnly || (error as NodeJS.ErrnoException).code !== "EEXIST")
      throw new LocalGatewayError("connection_file_unwritable");
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
function assertDeviceIdentity(value: unknown): asserts value is OpenClawDeviceIdentity {
  const identity = record(value);
  if (
    !identity ||
    ![identity.deviceId, identity.publicKey, identity.privateKey].every(
      (field) => typeof field === "string" && field.length > 0
    )
  )
    throw new LocalGatewayError("device_identity_invalid");
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function localGatewayFailure(error: unknown): string {
  if (error instanceof LocalGatewayError) return error.reason;
  const message = error instanceof Error ? error.message : "";
  if (/pair|device identity/i.test(message)) return "device_pairing_required";
  if (/auth|token|unauthorized|forbidden/i.test(message)) return "gateway_auth_rejected";
  if (/protocol|advertise/i.test(message)) return "gateway_protocol_unsupported";
  if (/agent.*missing/i.test(message)) return "provider_agent_missing";
  return "gateway_unreachable";
}

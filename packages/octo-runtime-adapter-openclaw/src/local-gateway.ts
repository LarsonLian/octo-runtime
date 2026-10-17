import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  createOpenClawDeviceIdentity,
  type OpenClawDeviceIdentity,
  type OpenClawGatewayOptions
} from "./gateway.js";

export const OPENCLAW_RUNTIME_ROOT = "OPENCLAW_RUNTIME_ROOT";
export type OpenClawConnection = {
  schema_version: 1;
  source: "gateway";
  gateway_url: string;
  credential_ref: string;
};
export interface OpenClawConnectionInput {
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
  input: OpenClawConnectionInput
): Promise<OpenClawConnection> {
  const path = connectionPath(runtimeRoot);
  if (!input.url?.trim() || !input.token?.trim())
    throw new LocalGatewayError("gateway_url_and_token_required");
  const url = normalizeOpenClawGatewayUrl(input.url);
  // A distinct credential file makes a source change atomic for concurrent readers.
  const credentialRef = `credentials/openclaw-gateway-${randomUUID()}.json`;
  await writePrivateJson(join(runtimeRoot, credentialRef), {
    schema_version: 1,
    access_token: input.token
  });
  const connection: OpenClawConnection = {
    schema_version: 1,
    source: "gateway",
    gateway_url: url,
    credential_ref: credentialRef
  };
  const devicePath = join(runtimeRoot, "credentials", "openclaw-device.json");
  await writePrivateJson(devicePath, createOpenClawDeviceIdentity(), true);
  assertDeviceIdentity(await readOptional(devicePath));
  await writePrivateJson(path, connection);
  return connection;
}

export async function readOpenClawConnection(
  runtimeRoot: string
): Promise<OpenClawConnection | undefined> {
  const saved = await readOptional(connectionPath(runtimeRoot));
  return saved === undefined ? undefined : assertConnection(saved);
}

/** Re-read both the source and credentials for every probe/invocation; never reset Gateway tokens. */
export async function loadLocalOpenClawGateway(
  runtimeRoot: string
): Promise<OpenClawGatewayOptions> {
  const connection = await readOpenClawConnection(runtimeRoot);
  if (!connection) throw new LocalGatewayError("runtime_configuration_missing");
  const url = connection.gateway_url;
  const credential = record(await readOptional(join(runtimeRoot, connection.credential_ref)));
  if (
    credential?.schema_version !== 1 ||
    typeof credential.access_token !== "string" ||
    !credential.access_token.trim()
  )
    throw new LocalGatewayError("gateway_credential_invalid");
  const token = credential.access_token;
  const path = join(runtimeRoot, "credentials", "openclaw-device.json");
  const device = await readOptional(path);
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

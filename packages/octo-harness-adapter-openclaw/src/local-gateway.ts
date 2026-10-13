import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import {
  createOpenClawDeviceIdentity,
  type OpenClawDeviceIdentity,
  type OpenClawGatewayOptions
} from "./gateway.js";

export class LocalGatewayError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Re-read on every probe and invocation so a later install or token rotation is visible. */
export async function loadLocalOpenClawGateway(home = homedir()): Promise<OpenClawGatewayOptions> {
  let source: string;
  try {
    source = await readFile(join(home, ".openclaw", "openclaw.json"), "utf8");
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
  ) {
    throw new LocalGatewayError("auth_config_unsupported");
  }
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
  ) {
    throw new LocalGatewayError("local_address_unsupported");
  }
  const localHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  const address = isIP(localHost) === 6 ? `[${localHost}]` : localHost;
  const root = join(home, ".octo-harness", "identity");
  const path = join(root, "openclaw-device.json");
  let device: unknown;
  try {
    device = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new LocalGatewayError("device_identity_invalid");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const candidate = createOpenClawDeviceIdentity();
    const temporary = join(root, `.openclaw-device-${randomUUID()}.json`);
    try {
      await writeFile(temporary, JSON.stringify(candidate), { flag: "wx", mode: 0o600 });
      await link(temporary, path);
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST")
        throw new LocalGatewayError("device_identity_unwritable");
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    try {
      device = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new LocalGatewayError("device_identity_invalid");
    }
  }
  assertDeviceIdentity(device);
  return {
    url: `ws://${address}:${port}`,
    token,
    device,
    connectTimeoutMs: 1_000,
    requestTimeoutMs: 1_000
  };
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

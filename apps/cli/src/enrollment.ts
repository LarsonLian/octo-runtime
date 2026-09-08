import { randomUUID } from "node:crypto";
import { arch, hostname, platform } from "node:os";
import type { PendingEnrollment } from "./state.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface EnrollmentOptions {
  serverUrl: string;
  enrollmentToken: string;
  profile: string;
  runtimeName: string;
  pending: PendingEnrollment;
  agentWorkUrl?: string;
  fetchImplementation?: typeof fetch;
}

export interface EnrollmentResult {
  runtimeId: string;
  credentialId: string;
  accessToken?: string;
  deviceId?: string;
  workspaceId?: string;
  octoSpaceId?: string;
  agentWorkUrl?: string;
  tenantId?: string;
  subjectId?: string;
  expiresAt?: string;
}

export function createPendingEnrollment(serverUrl: string): PendingEnrollment {
  return {
    schema_version: 1,
    attempt_id: randomUUID(),
    system_id: `system_${randomUUID()}`,
    server_url: normalizeServerUrl(serverUrl),
    created_at: new Date().toISOString()
  };
}

export async function enrollRuntime(options: EnrollmentOptions): Promise<EnrollmentResult> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const serverUrl = normalizeServerUrl(options.serverUrl);
  const agentWorkUrl = normalizeServerUrl(options.agentWorkUrl ?? serverUrl);
  const enrollmentResponse = await fetchImplementation(`${agentWorkUrl}/api/v1/devices/enroll`, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${options.enrollmentToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Cache-Control": "no-store",
      "Idempotency-Key": options.pending.attempt_id
    },
    body: JSON.stringify({ system_id: options.pending.system_id }),
    signal: AbortSignal.timeout(15_000)
  });
  const enrolled = await responseObject(enrollmentResponse, "device enrollment");
  const device = objectValue(enrolled.device);
  const credential = objectValue(enrolled.credential);
  const deviceToken = stringValue(credential?.token);
  const deviceId = stringValue(device?.id);
  const octoSpaceId = stringValue(device?.octo_space_id);
  const ownerUserId = stringValue(device?.owner_user_id);
  const credentialId = stringValue(credential?.id);
  if (!deviceToken || !deviceId || !octoSpaceId || !ownerUserId || !credentialId) {
    throw new Error("device enrollment response is missing credential or Octo binding");
  }

  const registerResponse = await fetchImplementation(`${agentWorkUrl}/api/v1/runtime/register`, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${deviceToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify({
      name: options.runtimeName,
      device: { os: platform(), arch: arch(), hostname: hostname() },
      runtime_version: "0.1.0",
      protocol_version: 1,
      capabilities: { adapters: [] }
    }),
    signal: AbortSignal.timeout(15_000)
  });
  const registered = await responseObject(registerResponse, "Runtime registration");
  const runtime = objectValue(registered.runtime);
  const runtimeId = stringValue(runtime?.id);
  if (!runtimeId) throw new Error("Runtime registration response is missing runtime.id");
  return {
    runtimeId,
    credentialId,
    accessToken: deviceToken,
    deviceId,
    octoSpaceId,
    agentWorkUrl,
    tenantId: octoSpaceId,
    subjectId: ownerUserId
  };
}

async function responseObject(response: Response, name: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new Error(`${name} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  const decoded = parseObject(text, `${name} response`);
  if (!response.ok) {
    const error = objectValue(decoded.error);
    const message = stringValue(error?.message) ?? stringValue(decoded.error) ?? response.statusText;
    const code = stringValue(error?.code);
    throw new Error(`${name} failed (${response.status}${code ? ` ${code}` : ""}): ${bounded(message)}`);
  }
  return objectValue(decoded.data) ?? decoded;
}

export function normalizeServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch (error) {
    throw new Error("--server-url must be an absolute URL", { cause: error });
  }
  if (!(["https:", "http:"] as const).includes(url.protocol as "https:" | "http:")) {
    throw new Error("--server-url must use HTTPS (HTTP is allowed only for loopback development)");
  }
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("--server-url must use HTTPS except for a loopback development server");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("--server-url must not contain credentials, query parameters, or a fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function parseObject(value: string, name: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    const object = objectValue(parsed);
    if (!object) throw new Error(`${name} must be a JSON object`);
    return object;
  } catch (error) {
    throw new Error(`invalid ${name}`, { cause: error });
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bounded(value: string): string {
  return value.trim().slice(0, 512) || "request rejected";
}

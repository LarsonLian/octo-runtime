import { readFileSync } from "node:fs";
import { arch, hostname, platform } from "node:os";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MIN_AGENT_WORK_PROTOCOL_VERSION = 1;
const MAX_AGENT_WORK_PROTOCOL_VERSION = 1;
export const RUNTIME_VERSION = packageVersion();

export interface EnrollmentOptions {
  serverUrl: string;
  enrollmentToken: string;
  profile: string;
  runtimeName: string;
  machineId: string;
  runtimeId?: string;
  runtimeToken?: string;
  agentWorkUrl?: string;
  fetchImplementation?: typeof fetch;
}

export interface EnrollmentResult {
  runtimeId: string;
  credentialId: string;
  accessToken?: string;
  octoSpaceId?: string;
  ownerRef?: string;
  agentWorkUrl?: string;
  expiresAt?: string;
}

export async function enrollRuntime(options: EnrollmentOptions): Promise<EnrollmentResult> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const serverUrl = normalizeServerUrl(options.serverUrl);
  const agentWorkUrl = normalizeServerUrl(options.agentWorkUrl ?? `${serverUrl}/agentworker`);
  const enrollmentResponse = await fetchImplementation(`${agentWorkUrl}/api/v1/runtimes/enroll`, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${options.enrollmentToken}`,
      ...(options.runtimeToken ? { "X-Runtime-Token": options.runtimeToken } : {}),
      "Content-Type": "application/json",
      Accept: "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify({ machine_id: options.machineId, ...(options.runtimeId ? { runtime_id: options.runtimeId } : {}) }),
    signal: AbortSignal.timeout(15_000)
  });
  const enrolled = await responseObject(enrollmentResponse, "runtime enrollment");
  const enrolledRuntime = objectValue(enrolled.runtime);
  const credential = objectValue(enrolled.credential);
  const runtimeToken = stringValue(credential?.token);
  const enrolledRuntimeId = stringValue(enrolledRuntime?.id);
  const octoSpaceId = stringValue(enrolledRuntime?.octo_space_id);
  const ownerRef = stringValue(enrolledRuntime?.owner_ref);
  const credentialId = stringValue(credential?.id);
  if (!runtimeToken || !enrolledRuntimeId || !octoSpaceId || !ownerRef || !/^(uid|org):[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(ownerRef) || !credentialId) {
    throw new Error("runtime enrollment response is missing credential or Octo binding");
  }
  if (options.runtimeId && enrolledRuntimeId !== options.runtimeId) throw new Error("enrollment returned a different Runtime identity");

  const registerResponse = await fetchImplementation(`${agentWorkUrl}/api/v1/runtime/register`, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${runtimeToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify({
      name: options.runtimeName,
      device: { os: platform(), arch: arch(), hostname: hostname() },
      runtime_version: RUNTIME_VERSION,
      protocol_version: MAX_AGENT_WORK_PROTOCOL_VERSION,
      protocol_version_min: MIN_AGENT_WORK_PROTOCOL_VERSION,
      protocol_version_max: MAX_AGENT_WORK_PROTOCOL_VERSION,
      capabilities: { adapters: [] }
    }),
    signal: AbortSignal.timeout(15_000)
  });
  const registered = await responseObject(registerResponse, "Runtime registration");
  const runtime = objectValue(registered.runtime);
  const runtimeId = stringValue(runtime?.id);
  if (!runtimeId) throw new Error("Runtime registration response is missing runtime.id");
  if (runtimeId !== enrolledRuntimeId) throw new Error("Runtime registration changed the enrolled identity");
  return {
    runtimeId,
    credentialId,
    accessToken: runtimeToken,
    octoSpaceId,
    agentWorkUrl,
    ownerRef
  };
}

function packageVersion(): string {
  const metadata = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  if (typeof metadata.version !== "string" || !metadata.version.trim()) {
    throw new Error("Octo Harness package version is missing");
  }
  return metadata.version;
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

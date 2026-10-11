import { RUNTIME_RUN_CONTRACT } from "@mininglamp-oss/octo-harness-protocol";
import { readFileSync } from "node:fs";
import { collectRuntimeDeviceInfo } from "@mininglamp-oss/octo-harness-daemon-app";
import {
  REQUEST_ID_HEADER,
  createRequestId,
  responseRequestId
} from "@mininglamp-oss/octo-harness-observability";
import { assertProfileName } from "./state.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MIN_AGENT_WORK_PROTOCOL_VERSION = 2;
const MAX_AGENT_WORK_PROTOCOL_VERSION = 2;
export const RUNTIME_VERSION = packageVersion();

export interface EnrollmentOptions {
  serverUrl: string;
  enrollmentToken: string;
  profile: string;
  runtimeName: string;
  machineId: string;
  runtimeKey?: string;
  runtimeToken?: string;
  agentWorkUrl?: string;
  fetchImplementation?: typeof fetch;
}

export interface EnrollmentResult {
  profile: string;
  runtimeKey: string;
  credentialId: string;
  accessToken?: string;
  octoSpaceId?: string;
  agentWorkUrl?: string;
  expiresAt?: string;
}

export async function enrollRuntime(options: EnrollmentOptions): Promise<EnrollmentResult> {
  const result = await exchangeRuntimeEnrollment(options);
  await registerEnrolledRuntime(options, result);
  return result;
}

export async function exchangeRuntimeEnrollment(options: EnrollmentOptions): Promise<EnrollmentResult> {
  try {
    return await exchangeRuntimeEnrollmentOnce(options);
  } catch (error) {
    if (!options.runtimeKey || !options.runtimeToken || !isInvalidRuntimeRenewal(error)) throw error;
    return exchangeRuntimeEnrollmentOnce({ ...options, runtimeKey: undefined, runtimeToken: undefined });
  }
}

async function exchangeRuntimeEnrollmentOnce(options: EnrollmentOptions): Promise<EnrollmentResult> {
  assertProfileName(options.profile);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const serverUrl = normalizeServerUrl(options.serverUrl);
  const agentWorkUrl = normalizeServerUrl(options.agentWorkUrl ?? `${serverUrl}/agentworker/api`);
  const { value: enrolled, requestId: enrollmentRequestId } = await requestObject(fetchImplementation, `${agentWorkUrl}/v1/runtimes/enroll`, "runtime enrollment", {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${options.enrollmentToken}`,
      ...(options.runtimeToken ? { "X-Runtime-Token": options.runtimeToken } : {}),
      "Content-Type": "application/json",
      Accept: "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify({ profile: options.profile, machine_id: options.machineId, ...(options.runtimeKey ? { runtime_key: options.runtimeKey } : {}) }),
    signal: AbortSignal.timeout(15_000)
  });
  const enrolledRuntime = objectValue(enrolled.runtime);
  const credential = objectValue(enrolled.credential);
  const runtimeToken = stringValue(credential?.token);
  const enrolledRuntimeId = stringValue(enrolledRuntime?.runtime_key);
  const octoSpaceId = stringValue(enrolledRuntime?.octo_space_id);
  const credentialId = stringValue(credential?.runtime_credential_key);
  if (!runtimeToken || !enrolledRuntimeId || !credentialId) {
    throw new Error(`runtime enrollment response is missing credential or Runtime identity (request_id=${enrollmentRequestId})`);
  }
  if (options.runtimeKey && enrolledRuntimeId !== options.runtimeKey) throw new Error(`enrollment returned a different Runtime identity (request_id=${enrollmentRequestId})`);
  if (enrolledRuntime?.profile !== options.profile) throw new Error(`runtime enrollment returned a different or missing profile (request_id=${enrollmentRequestId})`);

  return {
    profile: options.profile,
    runtimeKey: enrolledRuntimeId,
    credentialId,
    accessToken: runtimeToken,
    octoSpaceId,
    agentWorkUrl
  };
}

export async function registerEnrolledRuntime(options: EnrollmentOptions, enrollment: EnrollmentResult): Promise<void> {
  assertProfileName(options.profile);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const agentWorkUrl = normalizeServerUrl(enrollment.agentWorkUrl ?? options.agentWorkUrl ?? `${normalizeServerUrl(options.serverUrl)}/agentworker/api`);
  if (!enrollment.accessToken) throw new Error("Runtime registration requires an enrolled Runtime credential");
  const { value: registered, requestId: registrationRequestId } = await requestObject(fetchImplementation, `${agentWorkUrl}/v1/runtime/register`, "Runtime registration", {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${enrollment.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify({
      profile: options.profile,
      name: options.runtimeName,
      device: collectRuntimeDeviceInfo(),
      runtime_version: RUNTIME_VERSION,
      protocol_version: MAX_AGENT_WORK_PROTOCOL_VERSION,
      protocol_version_min: MIN_AGENT_WORK_PROTOCOL_VERSION,
      protocol_version_max: MAX_AGENT_WORK_PROTOCOL_VERSION,
      capabilities: { run_contract: RUNTIME_RUN_CONTRACT, adapters: [] }
    }),
    signal: AbortSignal.timeout(15_000)
  });
  const runtime = objectValue(registered.runtime);
  const runtimeKey = stringValue(runtime?.runtime_key);
  if (!runtimeKey) throw new Error(`Runtime registration response is missing runtime.runtime_key (request_id=${registrationRequestId})`);
  if (runtimeKey !== enrollment.runtimeKey) throw new Error(`Runtime registration changed the enrolled identity (request_id=${registrationRequestId})`);
  if (runtime?.profile !== options.profile) throw new Error(`Runtime registration changed or omitted the enrolled profile (request_id=${registrationRequestId})`);
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

async function requestObject(
  fetchImplementation: typeof fetch,
  url: string,
  name: string,
  init: RequestInit
): Promise<{ value: Record<string, unknown>; requestId: string }> {
  const requestId = createRequestId();
  const headers = { ...(init.headers as Record<string, string> | undefined), [REQUEST_ID_HEADER]: requestId };
  let response: Response;
  try {
    response = await fetchImplementation(url, { ...init, headers });
  } catch (error) {
    throw new Error(`${name} request failed (request_id=${requestId})`, { cause: error });
  }
  const responseId = responseRequestId(response, requestId);
  return { value: await responseObject(response, name, responseId), requestId: responseId };
}

async function responseObject(response: Response, name: string, requestId: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new Error(`${name} response exceeds ${MAX_RESPONSE_BYTES} bytes (request_id=${requestId})`);
  }
  let decoded: Record<string, unknown>;
  try {
    decoded = parseObject(text, `${name} response`);
  } catch (error) {
    throw new Error(`invalid ${name} response (request_id=${requestId})`, { cause: error });
  }
  if (!response.ok) {
    const error = objectValue(decoded.error);
    const message = stringValue(error?.message) ?? stringValue(decoded.error) ?? response.statusText;
    const code = stringValue(error?.code);
    const details = objectValue(error?.details);
    const reasonCode = stringValue(details?.reason_code);
    throw new HttpResponseError(
      `${name} failed (${response.status}${code ? ` ${code}` : ""}, request_id=${requestId}): ${bounded(message)}`,
      response.status,
      code,
      reasonCode
    );
  }
  return objectValue(decoded.data) ?? decoded;
}

class HttpResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly reasonCode?: string
  ) {
    super(message);
    this.name = "HttpResponseError";
  }
}

function isInvalidRuntimeRenewal(error: unknown): boolean {
  return error instanceof HttpResponseError &&
    error.status === 401 &&
    error.reasonCode === "ENROLLMENT_INVALID";
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

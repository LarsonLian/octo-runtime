import { hostname } from "node:os";
import { collectRuntimeDeviceInfo } from "./device-info.js";
import { RUNTIME_RUN_CONTRACT } from "@mininglamp-oss/octo-harness-protocol";
import { DaemonRuntimeError } from "@mininglamp-oss/octo-harness-daemon/runtime/errors";
import {
  readJsonOptional,
  removeFile,
  writeJsonAtomic,
  type DaemonProfilePaths,
  type MachineIdentity
} from "@mininglamp-oss/octo-harness-daemon/runtime/home";
import { ensureLocalRuntime } from "@mininglamp-oss/octo-harness-daemon/runtime/identity";
import type {
  AccountSubject,
  AuthorizedTenant
} from "@mininglamp-oss/octo-harness-daemon/runtime/types";
import { DAEMON_RUNTIME_VERSION } from "@mininglamp-oss/octo-harness-daemon/runtime/version";

const REQUEST_TIMEOUT_MS = 15_000;
const PROTOCOL_VERSION = 2;
export interface WorkerTenant extends AuthorizedTenant {
  serverUrl?: string;
  agentWorkUrl?: string;
  businessServiceBindings?: Partial<
    Record<"task" | "discussion", { serviceSubjectId: string; url: string }>
  >;
}
interface RuntimeCredential {
  schema_version: 1;
  access_token: string;
  issued_at: string;
  expires_at?: string;
}
export interface EnrollmentResult {
  runtimeId: string;
  credentialId: string;
  reused: boolean;
}

export async function ensureTenantEnrollment(options: {
  subject: AccountSubject;
  tenant: WorkerTenant;
  profile: DaemonProfilePaths;
  machine: MachineIdentity;
  getHumanToken(): string | Promise<string>;
  fetchImplementation?: typeof fetch;
  signal: AbortSignal;
}): Promise<EnrollmentResult> {
  if (!options.tenant.agentWorkUrl || !options.tenant.serverUrl)
    throw new DaemonRuntimeError(
      "URL_REQUIRED",
      "enrollment",
      false,
      "Registration requires explicit server URLs"
    );
  const baseUrl = normalizeUrl(options.tenant.agentWorkUrl);
  normalizeUrl(options.tenant.serverUrl);
  const identity = ensureLocalRuntime(options.profile, options.tenant);
  const configuration = readJsonOptional<Record<string, unknown>>(options.profile.configFile);
  writeJsonAtomic(options.profile.configFile, {
    ...configuration,
    server_url: options.tenant.serverUrl,
    agent_work_url: options.tenant.agentWorkUrl,
    business_service_bindings: options.tenant.businessServiceBindings
  });
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const saved = readJsonOptional<RuntimeCredential>(options.profile.credentialFile);
  if (saved?.schema_version === 1 && saved.access_token && identity.credential_id) {
    try {
      await registerRuntime(
        fetchImplementation,
        baseUrl,
        options.profile.name,
        identity.runtime_id,
        saved.access_token,
        options.signal
      );
      return { runtimeId: identity.runtime_id, credentialId: identity.credential_id, reused: true };
    } catch (error) {
      if (!(error instanceof HttpError) || (error.status !== 401 && error.status !== 403))
        throw error;
    }
  }
  const humanToken = String(await options.getHumanToken()).trim();
  if (!humanToken)
    throw new DaemonRuntimeError(
      "HUMAN_TOKEN_MISSING",
      "enrollment",
      false,
      "Human Token is unavailable"
    );
  const grant = await requestObject(
    fetchImplementation,
    endpoint(baseUrl, "/v1/runtime_enrollments"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Token: humanToken,
        "X-Space-ID": options.tenant.id
      },
      body: JSON.stringify({ kind: "local", owner_subject_type: "user" }),
      signal: options.signal
    },
    "enrollment grant"
  );
  const enrollmentToken = requiredString(grant.enrollment_token, "enrollment_token");
  if (!enrollmentToken.startsWith("octo_enroll_"))
    throw new DaemonRuntimeError(
      "PROTOCOL_INVALID",
      "enrollment",
      false,
      "Worker returned an invalid enrollment token"
    );
  const enrolled = await requestObject(
    fetchImplementation,
    endpoint(baseUrl, "/v1/runtimes/enroll"),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${enrollmentToken}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        profile: options.profile.name,
        machine_id: options.machine.machine_id,
        runtime_id: identity.runtime_id
      }),
      signal: options.signal
    },
    "runtime enrollment"
  );
  const runtime = objectValue(enrolled.runtime);
  const credential = objectValue(enrolled.credential);
  const runtimeId = requiredString(runtime?.runtime_id, "runtime.runtime_id");
  const credentialId = requiredString(
    credential?.runtime_credential_id,
    "credential.runtime_credential_id"
  );
  const runtimeToken = requiredString(credential?.token, "credential.token");
  if (
    runtimeId !== identity.runtime_id ||
    runtime?.profile !== options.profile.name ||
    runtime.octo_space_id !== options.tenant.id ||
    runtime.owner_subject_type !== "user" ||
    runtime.owner_subject_id !== options.subject.id
  ) {
    throw new DaemonRuntimeError(
      "BINDING_MISMATCH",
      "enrollment",
      false,
      "Worker returned a Runtime bound to another identity, profile, Space, or user"
    );
  }
  options.signal.throwIfAborted();
  const now = new Date().toISOString();
  writeJsonAtomic(
    options.profile.credentialFile,
    {
      schema_version: 1,
      access_token: runtimeToken,
      issued_at: now,
      ...(typeof credential?.expires_at === "string" ? { expires_at: credential.expires_at } : {})
    } satisfies RuntimeCredential,
    true
  );
  writeJsonAtomic(options.profile.identityFile, {
    ...identity,
    credential_id: credentialId,
    enrolled_at: now
  });
  await registerRuntime(
    fetchImplementation,
    baseUrl,
    options.profile.name,
    runtimeId,
    runtimeToken,
    options.signal
  );
  return { runtimeId, credentialId, reused: false };
}

export function resetTenantEnrollment(profile: DaemonProfilePaths): void {
  removeFile(profile.credentialFile);
  const identity = readJsonOptional<Record<string, unknown>>(profile.identityFile);
  if (identity) {
    delete identity.credential_id;
    delete identity.enrolled_at;
    writeJsonAtomic(profile.identityFile, identity);
  }
}

async function registerRuntime(
  fetchImplementation: typeof fetch,
  baseUrl: string,
  profile: string,
  runtimeId: string,
  runtimeToken: string,
  signal: AbortSignal
): Promise<void> {
  const registered = await requestObject(
    fetchImplementation,
    endpoint(baseUrl, "/v1/runtime/register"),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtimeToken}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        profile,
        name: hostname() || "Octo Harness Runtime",
        device: collectRuntimeDeviceInfo(),
        runtime_version: DAEMON_RUNTIME_VERSION,
        protocol_version: PROTOCOL_VERSION,
        protocol_version_min: PROTOCOL_VERSION,
        protocol_version_max: PROTOCOL_VERSION,
        capabilities: { run_contract: RUNTIME_RUN_CONTRACT, adapters: [] }
      }),
      signal
    },
    "Runtime registration"
  );
  const runtime = objectValue(registered.runtime);
  if (runtime?.runtime_id !== runtimeId || runtime.profile !== profile)
    throw new DaemonRuntimeError(
      "BINDING_MISMATCH",
      "enrollment",
      false,
      "Runtime registration returned another identity"
    );
}

async function requestObject(
  fetchImplementation: typeof fetch,
  url: string,
  init: RequestInit,
  name: string
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    response = await fetchImplementation(url, { ...init, redirect: "error", signal });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new DaemonRuntimeError("NETWORK", "enrollment", true, `${name} request failed`, {
      cause: error
    });
  }
  const text = await response.text();
  let decoded: Record<string, unknown>;
  try {
    decoded = text ? (objectValue(JSON.parse(text)) ?? {}) : {};
  } catch (error) {
    throw new DaemonRuntimeError(
      "PROTOCOL_INVALID",
      "enrollment",
      false,
      `${name} returned invalid JSON`,
      { cause: error }
    );
  }
  if (!response.ok) {
    const detail = objectValue(decoded.error);
    const details = objectValue(detail?.details);
    const code = diagnosticCode(detail?.code);
    const reasonCode = diagnosticCode(details?.reason_code);
    throw new HttpError(
      response.status,
      code,
      reasonCode,
      `${name} failed (${response.status}${code ? ` ${code}` : ""}${reasonCode ? `/${reasonCode}` : ""})`
    );
  }
  return objectValue(decoded.data) ?? decoded;
}

class HttpError extends DaemonRuntimeError {
  constructor(
    readonly status: number,
    readonly responseCode: string | undefined,
    readonly responseReasonCode: string | undefined,
    message: string
  ) {
    super(
      status === 401 || status === 403 ? "AUTH_REJECTED" : "HTTP_ERROR",
      "enrollment",
      status >= 500 || status === 429,
      message
    );
  }
}

function diagnosticCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(value) ? value : undefined;
}

function endpoint(base: string, path: string): string {
  return `${normalizeUrl(base)}${path}`;
}

function normalizeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch (error) {
    throw new DaemonRuntimeError(
      "URL_INVALID",
      "enrollment",
      false,
      "server URL must be absolute",
      { cause: error }
    );
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))
  ) {
    throw new DaemonRuntimeError(
      "URL_INVALID",
      "enrollment",
      false,
      "server URL must use HTTPS except for loopback development"
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new DaemonRuntimeError(
      "URL_INVALID",
      "enrollment",
      false,
      "server URL must not include credentials, query, or fragment"
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new DaemonRuntimeError(
    "PROTOCOL_INVALID",
    "enrollment",
    false,
    `response is missing ${name}`
  );
}

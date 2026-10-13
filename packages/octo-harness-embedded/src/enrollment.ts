import { hostname } from "node:os";
import {
  collectRuntimeDeviceInfo,
  RUNTIME_RUN_CONTRACT
} from "@mininglamp-oss/octo-harness-daemon";
import { EmbeddedHarnessError } from "./errors.js";
import {
  readJsonOptional,
  removeFile,
  writeJsonAtomic,
  type EmbeddedProfilePaths,
  type MachineIdentity
} from "./home.js";
import type { AccountSubject, AuthorizedTenant } from "./types.js";
import { EMBEDDED_HARNESS_VERSION } from "./version.js";

const REQUEST_TIMEOUT_MS = 15_000;
const PROTOCOL_VERSION = 2;

interface ProfileConfiguration {
  business_service_bindings?: AuthorizedTenant["businessServiceBindings"];
  schema_version: 1;
  profile: string;
  server_url: string;
  agent_work_url: string;
  octo_space_id: string;
  runtime_name: string;
  agent_identity: string;
  agent_name?: string;
}

interface RuntimeIdentity {
  schema_version: 1;
  profile: string;
  runtime_id: string;
  credential_id: string;
  octo_space_id: string;
  enrolled_at: string;
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
  tenant: AuthorizedTenant;
  profile: EmbeddedProfilePaths;
  machine: MachineIdentity;
  getHumanToken(): string | Promise<string>;
  fetchImplementation?: typeof fetch;
  signal: AbortSignal;
}): Promise<EnrollmentResult> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const agentIdentity = options.tenant.agentIdentity ?? "main";
  const agentName = options.tenant.agentName;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(agentIdentity) || (agentName !== undefined && (!agentName || agentName.trim() !== agentName || Buffer.byteLength(agentName) > 255))) throw new EmbeddedHarnessError("INVALID_ARGUMENT", "enrollment", false, "Invalid Agent identity or name");
  const saved = readProfile(options.profile);
  if (isHealthy(saved, options.tenant, options.profile.name)) {
    if (
      JSON.stringify(saved.config.business_service_bindings) !==
      JSON.stringify(options.tenant.businessServiceBindings) || saved.config.agent_identity !== agentIdentity || saved.config.agent_name !== agentName
    ) {
      writeJsonAtomic(options.profile.configFile, {
        ...saved.config,
        agent_identity: agentIdentity, agent_name: agentName,
        business_service_bindings: options.tenant.businessServiceBindings
      });
    }
    try {
      await registerRuntime(
        fetchImplementation,
        options.tenant.agentWorkUrl,
        {
          profile: options.profile.name,
          runtimeId: saved.identity.runtime_id,
          runtimeToken: saved.credential.access_token, agentIdentity, agentName
        },
        options.signal
      );
      return {
        runtimeId: saved.identity.runtime_id,
        credentialId: saved.identity.credential_id,
        reused: true
      };
    } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
        // A definitive credential rejection is repaired below.
      } else if (
        error instanceof EmbeddedHarnessError &&
        (error.code === "NETWORK" || error.retryable)
      ) {
        return {
          runtimeId: saved.identity.runtime_id,
          credentialId: saved.identity.credential_id,
          reused: true
        };
      } else {
        throw error;
      }
    }
  }

  const humanToken = String(await options.getHumanToken()).trim();
  if (!humanToken)
    throw new EmbeddedHarnessError(
      "HUMAN_TOKEN_MISSING",
      "enrollment",
      false,
      "Human Token is unavailable"
    );
  const grant = await requestObject(
    fetchImplementation,
    endpoint(options.tenant.agentWorkUrl, "/v1/runtime_enrollments"),
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
  if (!enrollmentToken.startsWith("octo_enroll_")) {
    throw new EmbeddedHarnessError(
      "PROTOCOL_INVALID",
      "enrollment",
      false,
      "Worker returned an invalid enrollment token"
    );
  }

  const existingRuntimeId = saved.identity?.runtime_id;
  const existingRuntimeToken = saved.credential?.access_token;
  let enrolled: Record<string, unknown>;
  try {
    enrolled = await exchangeEnrollment(
      fetchImplementation,
      options,
      enrollmentToken,
      existingRuntimeId,
      existingRuntimeToken
    );
  } catch (error) {
    if (
      !(error instanceof HttpError) ||
      error.status !== 401 ||
      !existingRuntimeId ||
      !existingRuntimeToken
    )
      throw error;
    enrolled = await exchangeEnrollment(fetchImplementation, options, enrollmentToken);
  }

  const runtime = objectValue(enrolled.runtime);
  const credential = objectValue(enrolled.credential);
  const runtimeId = requiredString(runtime?.runtime_id, "runtime.runtime_id");
  const credentialId = requiredString(
    credential?.runtime_credential_id,
    "credential.runtime_credential_id"
  );
  const runtimeToken = requiredString(credential?.token, "credential.token");
  const octoSpaceId = requiredString(runtime?.octo_space_id, "runtime.octo_space_id");
  const ownerType = requiredString(
    runtime?.owner_subject_type ?? runtime?.subject_type,
    "runtime.owner_subject_type"
  );
  const ownerId = requiredString(
    runtime?.owner_subject_id ?? runtime?.subject_id,
    "runtime.owner_subject_id"
  );
  if (
    runtime?.profile !== options.profile.name ||
    octoSpaceId !== options.tenant.id ||
    ownerType !== "user" ||
    ownerId !== options.subject.id
  ) {
    throw new EmbeddedHarnessError(
      "BINDING_MISMATCH",
      "enrollment",
      false,
      "Worker returned a Runtime bound to another profile, Space, or user"
    );
  }

  await registerRuntime(
    fetchImplementation,
    options.tenant.agentWorkUrl,
    {
      profile: options.profile.name,
      runtimeId,
      runtimeToken, agentIdentity, agentName
    },
    options.signal
  );

  const now = new Date().toISOString();
  const runtimeName = hostname() || "Octo Harness Runtime";
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
  writeJsonAtomic(options.profile.configFile, {
    schema_version: 1,
    profile: options.profile.name,
    server_url: normalizeUrl(options.tenant.serverUrl),
    agent_work_url: normalizeUrl(options.tenant.agentWorkUrl),
    ...(options.tenant.businessServiceBindings
      ? { business_service_bindings: options.tenant.businessServiceBindings }
      : {}),
    octo_space_id: octoSpaceId,
    runtime_name: runtimeName,
    agent_identity: agentIdentity, agent_name: agentName
  } satisfies ProfileConfiguration);
  writeJsonAtomic(options.profile.identityFile, {
    schema_version: 1,
    profile: options.profile.name,
    runtime_id: runtimeId,
    credential_id: credentialId,
    octo_space_id: octoSpaceId,
    enrolled_at: now
  } satisfies RuntimeIdentity);
  return { runtimeId, credentialId, reused: false };
}

export function resetTenantEnrollment(profile: EmbeddedProfilePaths): void {
  removeFile(profile.identityFile);
  removeFile(profile.credentialFile);
}

function readProfile(profile: EmbeddedProfilePaths): {
  config?: ProfileConfiguration;
  identity?: RuntimeIdentity;
  credential?: RuntimeCredential;
} {
  return {
    config: readJsonOptional<ProfileConfiguration>(profile.configFile),
    identity: readJsonOptional<RuntimeIdentity>(profile.identityFile),
    credential: readJsonOptional<RuntimeCredential>(profile.credentialFile)
  };
}

function isHealthy(
  saved: ReturnType<typeof readProfile>,
  tenant: AuthorizedTenant,
  profile: string
): saved is {
  config: ProfileConfiguration;
  identity: RuntimeIdentity;
  credential: RuntimeCredential;
} {
  return (
    saved.config?.schema_version === 1 &&
    saved.config.profile === profile &&
    saved.config.octo_space_id === tenant.id &&
    saved.config.agent_work_url === normalizeUrl(tenant.agentWorkUrl) &&
    saved.identity?.schema_version === 1 &&
    saved.identity.profile === profile &&
    saved.identity.octo_space_id === tenant.id &&
    Boolean(saved.identity.runtime_id) &&
    Boolean(saved.identity.credential_id) &&
    saved.credential?.schema_version === 1 &&
    Boolean(saved.credential.access_token)
  );
}

async function exchangeEnrollment(
  fetchImplementation: typeof fetch,
  options: Parameters<typeof ensureTenantEnrollment>[0],
  enrollmentToken: string,
  runtimeId?: string,
  runtimeToken?: string
): Promise<Record<string, unknown>> {
  return requestObject(
    fetchImplementation,
    endpoint(options.tenant.agentWorkUrl, "/v1/runtimes/enroll"),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${enrollmentToken}`,
        ...(runtimeToken ? { "X-Runtime-Token": runtimeToken } : {}),
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        profile: options.profile.name,
        machine_id: options.machine.machine_id,
        ...(runtimeId ? { runtime_id: runtimeId } : {})
      }),
      signal: options.signal
    },
    "runtime enrollment"
  );
}

async function registerRuntime(
  fetchImplementation: typeof fetch,
  agentWorkUrl: string,
  runtime: { profile: string; runtimeId: string; runtimeToken: string; agentIdentity: string; agentName?: string },
  signal: AbortSignal
): Promise<void> {
  const registered = await requestObject(
    fetchImplementation,
    endpoint(agentWorkUrl, "/v1/runtime/register"),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtime.runtimeToken}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        profile: runtime.profile,
        agent_identity: runtime.agentIdentity,
        ...(runtime.agentName !== undefined ? { agent_name: runtime.agentName } : {}),
        name: hostname() || "Octo Harness Runtime",
        device: collectRuntimeDeviceInfo(),
        runtime_version: EMBEDDED_HARNESS_VERSION,
        protocol_version: PROTOCOL_VERSION,
        protocol_version_min: PROTOCOL_VERSION,
        protocol_version_max: PROTOCOL_VERSION,
        capabilities: { run_contract: RUNTIME_RUN_CONTRACT, adapters: [] }
      }),
      signal
    },
    "Runtime registration"
  );
  const registeredRuntime = objectValue(registered.runtime);
  if (
    registeredRuntime?.runtime_id !== runtime.runtimeId ||
    registeredRuntime.profile !== runtime.profile
  ) {
    throw new EmbeddedHarnessError(
      "BINDING_MISMATCH",
      "enrollment",
      false,
      "Runtime registration returned another identity"
    );
  }
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
    throw new EmbeddedHarnessError("NETWORK", "enrollment", true, `${name} request failed`, {
      cause: error
    });
  }
  const text = await response.text();
  let decoded: Record<string, unknown>;
  try {
    decoded = text ? (objectValue(JSON.parse(text)) ?? {}) : {};
  } catch (error) {
    throw new EmbeddedHarnessError(
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

class HttpError extends EmbeddedHarnessError {
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
    throw new EmbeddedHarnessError(
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
    throw new EmbeddedHarnessError(
      "URL_INVALID",
      "enrollment",
      false,
      "server URL must use HTTPS except for loopback development"
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new EmbeddedHarnessError(
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
  throw new EmbeddedHarnessError(
    "PROTOCOL_INVALID",
    "enrollment",
    false,
    `response is missing ${name}`
  );
}

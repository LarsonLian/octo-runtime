import { randomUUID } from "node:crypto";
import type { FailureAction, FailureEnvelope, FailureSource } from "./generated/protocol-types.js";

export type FailureDomain = "runtime" | "adapter" | "provider" | "system";

export interface FailureClassificationContext {
  stage: string;
  source?: FailureSource;
  defaultDomain: FailureDomain;
  diagnosticId?: string;
  occurredAt?: string;
  /** Only trusted downstream boundaries may retain a previously validated envelope. */
  preserveExisting?: boolean;
}

interface CatalogEntry {
  category: string;
  message: string;
  messageKey: string;
  retryable: boolean;
  retryAfterMs?: number;
  action: FailureAction;
}

/** Harness-owned subset of the global catalog in improvement 70-01. */
export const FAILURE_CATALOG = Object.freeze({
  "OH-RUN-2002": entry("runtime_admission", "运行环境正在维护，本轮任务未启动，请稍后重试。", "error.runtime.draining", true, "retry_later", 30_000),
  "OH-RUN-2003": entry("runtime_capacity", "运行环境当前繁忙，暂时无法接收新任务。", "error.runtime.capacity", true, "retry_later", 30_000),
  "OH-RUN-2008": entry("runtime_local_store", "运行设备存储异常，本轮任务已安全结束。", "error.runtime.local_store", true, "check_runtime"),
  "OH-ADP-3002": entry("adapter_dependency", "未找到 Agent 命令或必要程序。", "error.adapter.command_not_found", false, "install_dependency"),
  "OH-ADP-3003": entry("adapter_permission", "Agent 进程没有访问所需资源的权限。", "error.adapter.permission_denied", false, "fix_permissions"),
  "OH-ADP-3004": entry("adapter_invocation", "Agent 适配器启动或执行失败。", "error.adapter.invocation_failed", false, "contact_admin"),
  "OH-ADP-3005": entry("adapter_protocol", "Agent 返回了无法识别的协议数据。", "error.adapter.protocol_invalid", false, "contact_admin"),
  "OH-ADP-3006": entry("adapter_timeout", "Agent 响应超时。", "error.adapter.timeout", true, "retry"),
  "OH-PRV-4001": entry("provider_authentication", "模型服务凭据无效或已失效。", "error.provider.credentials_invalid", false, "update_credentials"),
  "OH-PRV-4002": entry("provider_authorization", "当前账号无权使用所选模型或组织。", "error.provider.permission_denied", false, "contact_admin"),
  "OH-PRV-4003": entry("provider_model", "所选模型不存在或当前不可用。", "error.provider.model_not_found", false, "change_model"),
  "OH-PRV-4004": entry("provider_quota", "模型调用额度不足。", "error.provider.quota_exhausted", false, "contact_admin"),
  "OH-PRV-4005": entry("provider_rate_limit", "模型服务请求过于频繁，请稍后重试。", "error.provider.rate_limited", true, "retry_later", 30_000),
  "OH-PRV-4006": entry("provider_availability", "模型服务暂时不可用。", "error.provider.unavailable", true, "retry_later", 30_000),
  "OH-PRV-4007": entry("provider_client_policy", "当前授权方式不允许此客户端调用。", "error.provider.client_not_allowed", false, "update_credentials"),
  "OH-PRV-4008": entry("provider_configuration", "此 Agent 绑定的 Provider 配置已被删除或不可用。", "error.provider.configuration_missing", false, "change_model"),
  "OH-PRV-4099": entry("provider_unknown", "模型服务调用失败，暂时无法识别具体原因。", "error.provider.unknown", true, "retry"),
  "OH-SYS-9001": entry("system_unknown", "系统发生未知错误。", "error.system.unknown", true, "retry")
} satisfies Record<string, CatalogEntry>);

export type PublicFailureCode = keyof typeof FAILURE_CATALOG;

/** Classify untrusted adapter/provider error data without copying raw messages or secrets into the result. */
export function classifyFailure(input: unknown, context: FailureClassificationContext): FailureEnvelope {
  const evidence = failureEvidence(input);
  const classification = classify(evidence, context.defaultDomain);
  const catalog = FAILURE_CATALOG[classification.code];
  return {
    schemaVersion: 1,
    code: classification.code,
    reasonCode: classification.reasonCode,
    category: catalog.category,
    stage: context.stage,
    messageKey: catalog.messageKey,
    params: {},
    retryable: catalog.retryable,
    ...(catalog.retryAfterMs === undefined ? {} : { retryAfterMs: catalog.retryAfterMs }),
    action: catalog.action,
    diagnosticId: context.diagnosticId ?? `diag_${randomUUID().replaceAll("-", "")}`,
    source: context.source ?? { component: "octo-harness" },
    cause: {
      reasonCode: classification.reasonCode,
      ...(evidence.httpStatus === undefined ? {} : { httpStatus: evidence.httpStatus })
    },
    occurredAt: context.occurredAt ?? new Date().toISOString()
  };
}

/**
 * Produce the backwards-compatible terminal payload (`code`/`message`) plus
 * the structured envelope. Only allowlisted metadata survives this boundary.
 */
export function failurePayload(
  input: unknown,
  context: FailureClassificationContext
): Record<string, unknown> & { failure: FailureEnvelope } {
  const record = asRecord(input) ?? {};
  const existing = context.preserveExisting && isFailureEnvelope(record.failure) ? record.failure : undefined;
  const classified = existing ?? classifyFailure(input, context);
  const timeoutStage = safeTimeoutStage(record.timeoutStage);
  const timeoutMs = safeTimeoutMs(record.timeoutMs);
  const failure = timeoutStage || timeoutMs !== undefined
    ? {
        ...classified,
        params: {
          ...classified.params,
          ...(timeoutStage ? { timeoutStage } : {}),
          ...(timeoutMs === undefined ? {} : { timeoutMs })
        }
      }
    : classified;
  const adapterType = safeAdapterType(record.adapterType) ?? failure.source.adapter;
  const legacyCode = safeReasonCode(record.code) ?? failure.reasonCode;
  return {
    code: legacyCode,
    message: failureMessage(failure.code),
    ...(adapterType ? { adapterType } : {}),
    failure
  };
}

function safeTimeoutStage(value: unknown): string | undefined {
  return typeof value === "string" && ["starting", "model_active", "tool_active"].includes(value)
    ? value
    : undefined;
}

function safeTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 86_400_000
    ? value
    : undefined;
}

export function failureMessage(code: string): string {
  return isPublicFailureCode(code) ? FAILURE_CATALOG[code].message : FAILURE_CATALOG["OH-SYS-9001"].message;
}

export function isFailureEnvelope(value: unknown): value is FailureEnvelope {
  const record = asRecord(value);
  if (!record) return false;
  const source = asRecord(record.source);
  const action = asRecord(record.action);
  if (!source || !action) return false;
  return record.schemaVersion === 1
    && typeof record.code === "string" && /^OH-[A-Z]{3}-\d{4}$/.test(record.code)
    && typeof record.reasonCode === "string" && record.reasonCode.length > 0
    && typeof record.category === "string" && record.category.length > 0
    && typeof record.stage === "string" && record.stage.length > 0
    && typeof record.messageKey === "string" && record.messageKey.length > 0
    && asRecord(record.params) !== undefined
    && typeof record.retryable === "boolean"
    && typeof record.diagnosticId === "string" && /^diag_[0-9a-f]{32}$/.test(record.diagnosticId)
    && (source.component === "octo-harness" || source.component === "octo-agent-worker")
    && typeof action.type === "string" && typeof action.labelKey === "string"
    && typeof record.occurredAt === "string" && !Number.isNaN(Date.parse(record.occurredAt));
}

function entry(
  category: string,
  message: string,
  messageKey: string,
  retryable: boolean,
  actionType: FailureAction["type"],
  retryAfterMs?: number
): CatalogEntry {
  return {
    category,
    message,
    messageKey,
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    action: { type: actionType, labelKey: `action.${actionType}` }
  };
}

interface FailureEvidence {
  fingerprint: string;
  explicitCode?: string;
  httpStatus?: number;
}

function failureEvidence(input: unknown): FailureEvidence {
  const values: string[] = [];
  let explicitCode: string | undefined;
  let httpStatus: number | undefined;
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || value === null || value === undefined) return;
    if (value instanceof Error) {
      const code = safeReasonCode((value as NodeJS.ErrnoException).code);
      if (code) explicitCode ??= code;
      values.push(value.name, value.message, code ?? "");
      visit(value.cause, depth + 1);
      return;
    }
    if (typeof value === "string" || typeof value === "number") {
      values.push(String(value));
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    for (const key of ["code", "reasonCode", "reason_code"] as const) {
      const code = safeReasonCode(record[key]);
      if (code) {
        explicitCode ??= code;
        values.push(code);
      }
    }
    for (const key of ["status", "statusCode", "httpStatus"] as const) {
      const status = numericHttpStatus(record[key]);
      if (status) httpStatus ??= status;
    }
    for (const key of ["message", "reason", "type", "name", "error", "providerError", "data", "cause"] as const) {
      visit(record[key], depth + 1);
    }
  };
  visit(input, 0);
  return { fingerprint: values.join(" ").toLowerCase().slice(0, 12_000), explicitCode, httpStatus };
}

function classify(evidence: FailureEvidence, defaultDomain: FailureDomain): { code: PublicFailureCode; reasonCode: string } {
  const text = evidence.fingerprint;
  const explicit = evidence.explicitCode?.toUpperCase();
  if (explicit === "RUNTIME_DRAINING") return result("OH-RUN-2002", "RUNTIME_DRAINING");
  if (["OUTBOX_HARD_LIMIT", "OUTBOX_BACKPRESSURE", "RUNTIME_CAPACITY_EXHAUSTED"].includes(explicit ?? "")) {
    return result("OH-RUN-2003", explicit ?? "RUNTIME_CAPACITY_EXHAUSTED");
  }
  if (["LOCAL_STORE_FULL", "LOCAL_STORE_UNAVAILABLE"].includes(explicit ?? "")) {
    return result("OH-RUN-2008", explicit ?? "LOCAL_STORE_UNAVAILABLE");
  }
  if (explicit === "ENOENT" || text.includes("command not found") || text.includes("executable not found")) {
    return result("OH-ADP-3002", explicit === "ENOENT" ? "ENOENT" : "COMMAND_NOT_FOUND");
  }
  if (explicit === "EPERM" || explicit === "EACCES" || text.includes("permission denied")) {
    return result("OH-ADP-3003", explicit === "EPERM" || explicit === "EACCES" ? explicit : "EACCES");
  }
  if (isProtocolFailure(explicit, text)) return result("OH-ADP-3005", "ADAPTER_PROTOCOL_ERROR");
  if (isAdapterTimeout(explicit, text, defaultDomain)) return result("OH-ADP-3006", "ADAPTER_TIMEOUT");

  if (explicit === "PROVIDER_CONFIG_MISSING" || containsAny(text, ["provider_config_missing", "provider configuration missing"])) {
    return result("OH-PRV-4008", "PROVIDER_CONFIG_MISSING");
  }

  const status = evidence.httpStatus;
  if (status === 401 || containsAny(text, ["invalid_api_key", "invalid api key", "token_expired", "unauthorized"])) {
    return result("OH-PRV-4001", status === 401 ? "PROVIDER_HTTP_401" : "PROVIDER_CREDENTIAL_INVALID");
  }
  if (containsAny(text, ["official_clients_only", "official clients only", "client_not_allowed"])) {
    return result("OH-PRV-4007", "PROVIDER_CLIENT_NOT_ALLOWED");
  }
  if (status === 403 || containsAny(text, ["permission_denied", "forbidden"])) {
    return result("OH-PRV-4002", status === 403 ? "PROVIDER_HTTP_403" : "PROVIDER_PERMISSION_DENIED");
  }
  if (containsAny(text, ["model_not_found", "model not found", "unknown model"]) || status === 404) {
    return result("OH-PRV-4003", "PROVIDER_MODEL_NOT_FOUND");
  }
  if (containsAny(text, ["insufficient_quota", "quota exceeded", "quota_exhausted", "balance_exhausted", "billing limit"])) {
    return result("OH-PRV-4004", "PROVIDER_QUOTA_EXHAUSTED");
  }
  if (status === 429 || containsAny(text, ["rate_limit", "rate limit", "too many requests"])) {
    return result("OH-PRV-4005", "PROVIDER_RATE_LIMITED");
  }
  if ((status !== undefined && status >= 500) || containsAny(text, ["provider_unavailable", "service unavailable", "bad gateway", "gateway timeout"])) {
    return result("OH-PRV-4006", "PROVIDER_UNAVAILABLE");
  }
  if (defaultDomain === "provider" && containsAny(text, ["timeout", "timed out", "etimedout", "econnreset"])) {
    return result("OH-PRV-4006", "PROVIDER_TIMEOUT");
  }
  if (defaultDomain === "adapter") {
    return result("OH-ADP-3004", explicit === "ADAPTER_INVOCATION_FAILED" ? explicit : "ADAPTER_INVOCATION_FAILED");
  }
  if (defaultDomain === "runtime") return result("OH-SYS-9001", "RUNTIME_ERROR_UNMAPPED");
  if (defaultDomain === "provider") return result("OH-PRV-4099", "PROVIDER_ERROR");
  return result("OH-SYS-9001", "INTERNAL_ERROR");
}

function isProtocolFailure(code: string | undefined, text: string): boolean {
  return code === "INVALID_JSON"
    || code?.endsWith("_RPC_ERROR") === true
    || containsAny(text, ["invalid json", "protocol error", "rpc error", "unsupported canonical event"]);
}

function isAdapterTimeout(code: string | undefined, text: string, domain: FailureDomain): boolean {
  if (code === "ADAPTER_TIMEOUT" || code === "RPC_TIMEOUT") return true;
  return domain === "adapter" && containsAny(text, ["timeout", "timed out", "etimedout"]);
}

function result(code: PublicFailureCode, reasonCode: string): { code: PublicFailureCode; reasonCode: string } {
  return { code, reasonCode };
}

function isPublicFailureCode(value: string): value is PublicFailureCode {
  return Object.hasOwn(FAILURE_CATALOG, value);
}

function safeReasonCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 128);
  return normalized.length > 0 ? normalized : undefined;
}

function safeAdapterType(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) return undefined;
  return value;
}

function numericHttpStatus(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(numeric) && numeric >= 100 && numeric <= 599 ? numeric : undefined;
}

function containsAny(value: string, candidates: string[]): boolean {
  return candidates.some(candidate => value.includes(candidate));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

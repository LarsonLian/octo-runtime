import { randomUUID } from "node:crypto";
import type { FailureAction, FailureEnvelope, FailureSource } from "./generated/protocol-types.js";

export type FailureDomain = "runtime" | "adapter" | "provider" | "system";

export interface FailureClassificationContext {
  stage: string;
  source?: FailureSource;
  defaultDomain: FailureDomain;
  /** Agent Work Run identity; standard arun IDs deterministically own the diagnostic UUID. */
  runId?: string;
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

/** Runtime-owned subset of the global catalog in improvement 70-01. */
export const FAILURE_CATALOG = Object.freeze({
  "OH-INP-5001": entry(
    "input_modality",
    "所选模型或运行方式不支持图片输入，请更换模型或移除图片。",
    "error.input.unsupported_modality",
    false,
    "change_model"
  ),
  "OH-INP-5002": entry(
    "input_limit",
    "图片数量或大小超过本次输入限制。",
    "error.input.image_limit_exceeded",
    false,
    "retry"
  ),
  "OH-INP-5003": entry(
    "input_resource",
    "本次输入的图片暂时无法读取。",
    "error.input.artifact_unavailable",
    true,
    "retry"
  ),
  "OH-INP-5004": entry(
    "input_integrity",
    "图片内容与提交的资源记录不一致，请重新添加图片。",
    "error.input.artifact_integrity_mismatch",
    false,
    "retry"
  ),
  "OH-INP-5005": entry(
    "input_permission",
    "当前执行没有读取图片的权限。",
    "error.input.artifact_access_denied",
    false,
    "fix_permissions"
  ),
  "OH-RUN-2002": entry(
    "runtime_admission",
    "运行环境正在维护，本轮任务未启动，请稍后重试。",
    "error.runtime.draining",
    true,
    "retry_later",
    30_000
  ),
  "OH-RUN-2003": entry(
    "runtime_capacity",
    "运行环境当前繁忙，暂时无法接收新任务。",
    "error.runtime.capacity",
    true,
    "retry_later",
    30_000
  ),
  "OH-RUN-2004": entry(
    "session_queue_capacity",
    "当前会话的排队任务已满，请稍后重试。",
    "error.runtime.session_queue_capacity",
    true,
    "retry_later",
    30_000
  ),
  "OH-RUN-2005": entry(
    "channel_delivery_unknown",
    "回复已尝试发送，但未收到消息服务的确认，可能已送达。请先检查聊天记录，避免重复提交任务。",
    "error.channel.delivery_unknown",
    false,
    "contact_admin"
  ),
  "OH-RUN-2008": entry(
    "runtime_local_store",
    "运行设备存储异常，本轮任务已安全结束。",
    "error.runtime.local_store",
    true,
    "check_runtime"
  ),
  "OH-RUN-2009": entry(
    "runtime_stream_capacity",
    "运行输出队列超过容量限制，本轮任务已停止。请检查运行设备的输出容量配置。",
    "error.runtime.stream_queue_capacity",
    false,
    "check_runtime"
  ),
  "OH-ADP-3002": entry(
    "adapter_dependency",
    "未找到 Agent 命令或必要程序。",
    "error.adapter.command_not_found",
    false,
    "install_dependency"
  ),
  "OH-ADP-3003": entry(
    "adapter_permission",
    "Agent 进程没有访问所需资源的权限。",
    "error.adapter.permission_denied",
    false,
    "fix_permissions"
  ),
  "OH-ADP-3004": entry(
    "adapter_invocation",
    "Agent 适配器启动或执行失败。",
    "error.adapter.invocation_failed",
    false,
    "contact_admin"
  ),
  "OH-ADP-3005": entry(
    "adapter_protocol",
    "Agent 返回了无法识别的协议数据。",
    "error.adapter.protocol_invalid",
    false,
    "contact_admin"
  ),
  "OH-ADP-3006": entry(
    "adapter_timeout",
    "Agent 响应超时。",
    "error.adapter.timeout",
    true,
    "retry"
  ),
  "OH-ADP-3007": entry(
    "adapter_start_timeout",
    "Agent 启动等待超时。",
    "error.adapter.first_frame_timeout",
    true,
    "retry"
  ),
  "OH-ADP-3008": entry(
    "adapter_model_idle",
    "Agent 长时间没有新的执行进展，任务已停止。",
    "error.adapter.model_idle_timeout",
    true,
    "retry"
  ),
  "OH-ADP-3009": entry(
    "adapter_tool_idle",
    "工具长时间没有新的执行进展，任务已停止。",
    "error.adapter.tool_idle_timeout",
    true,
    "retry"
  ),
  "OH-ADP-3010": entry(
    "adapter_tool_deadline",
    "工具执行已达到单次运行时限。",
    "error.adapter.tool_deadline",
    true,
    "retry"
  ),
  "OH-ADP-3011": entry(
    "adapter_run_deadline",
    "任务已达到总运行时限。",
    "error.adapter.run_deadline",
    true,
    "retry"
  ),
  "OH-ADP-3012": entry(
    "adapter_cleanup_timeout",
    "Agent 结束清理超时，请检查运行环境。",
    "error.adapter.cleanup_timeout",
    false,
    "check_runtime"
  ),
  "OH-ADP-3013": entry(
    "adapter_rpc_timeout",
    "Agent 协议请求响应超时。",
    "error.adapter.rpc_timeout",
    true,
    "check_runtime"
  ),
  "OH-ADP-3014": entry(
    "adapter_frame_capacity",
    "Agent 输出帧超过运行时容量限制，本轮任务已停止。",
    "error.adapter.host_frame_too_large",
    false,
    "check_runtime"
  ),
  "OH-PRV-4001": entry(
    "provider_authentication",
    "模型服务凭据无效或已失效。",
    "error.provider.credentials_invalid",
    false,
    "update_credentials"
  ),
  "OH-PRV-4002": entry(
    "provider_authorization",
    "当前账号无权使用所选模型或组织。",
    "error.provider.permission_denied",
    false,
    "contact_admin"
  ),
  "OH-PRV-4003": entry(
    "provider_model",
    "所选模型不存在或当前不可用。",
    "error.provider.model_not_found",
    false,
    "change_model"
  ),
  "OH-PRV-4004": entry(
    "provider_quota",
    "模型调用额度不足。",
    "error.provider.quota_exhausted",
    false,
    "contact_admin"
  ),
  "OH-PRV-4005": entry(
    "provider_rate_limit",
    "模型服务请求过于频繁，请稍后重试。",
    "error.provider.rate_limited",
    true,
    "retry_later",
    30_000
  ),
  "OH-PRV-4006": entry(
    "provider_availability",
    "模型服务暂时不可用。",
    "error.provider.unavailable",
    true,
    "retry_later",
    30_000
  ),
  "OH-PRV-4007": entry(
    "provider_client_policy",
    "当前授权方式不允许此客户端调用。",
    "error.provider.client_not_allowed",
    false,
    "update_credentials"
  ),
  "OH-PRV-4008": entry(
    "provider_configuration",
    "此 Agent 绑定的 Provider 配置已被删除或不可用。",
    "error.provider.configuration_missing",
    false,
    "change_model"
  ),
  "OH-PRV-4009": entry(
    "provider_message_capacity",
    "模型服务返回的单条消息超过运行时容量限制，本轮任务已停止。",
    "error.provider.message_too_large",
    false,
    "check_runtime"
  ),
  "OH-PRV-4099": entry(
    "provider_unknown",
    "模型服务调用失败，暂时无法识别具体原因。",
    "error.provider.unknown",
    true,
    "retry"
  ),
  "OH-SYS-9001": entry(
    "system_unknown",
    "系统发生未知错误。",
    "error.system.unknown",
    true,
    "retry"
  )
} satisfies Record<string, CatalogEntry>);

export type PublicFailureCode = keyof typeof FAILURE_CATALOG;

/** Classify untrusted adapter/provider error data without copying raw messages or secrets into the result. */
export function classifyFailure(
  input: unknown,
  context: FailureClassificationContext
): FailureEnvelope {
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
    params:
      classification.reasonCode === "CODEX_FINALIZATION_TIMEOUT"
        ? {
            configParameter: "execution_profile.agent_config.providerOptions.finalizationTimeoutMs"
          }
        : timeoutConfiguration(classification.code, context.source?.adapter),
    retryable:
      classification.reasonCode === "CODEX_FINALIZATION_TIMEOUT" ? false : catalog.retryable,
    ...(catalog.retryAfterMs === undefined ? {} : { retryAfterMs: catalog.retryAfterMs }),
    action: catalog.action,
    diagnosticId: diagnosticIdForContext(context),
    source: context.source ?? { component: "octo-runtime" },
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
  const existing =
    context.preserveExisting && isFailureEnvelope(record.failure) ? record.failure : undefined;
  const runDiagnosticId = diagnosticIdFromRunId(context.runId);
  const classified = existing
    ? runDiagnosticId === undefined
      ? existing
      : { ...existing, diagnosticId: runDiagnosticId }
    : classifyFailure(input, context);
  // Adapters may already have normalized a failure; revalidate only the safe
  // timeout fields so Host normalization does not erase their evidence.
  const upstreamParams = asRecord(asRecord(record.failure)?.params) ?? {};
  const timeoutStage = safeTimeoutStage(record.timeoutStage ?? upstreamParams.timeoutStage);
  const timeoutMs = safeTimeoutMs(record.timeoutMs ?? upstreamParams.timeoutMs);
  const reason = record.timeoutReason ?? upstreamParams.timeoutReason;
  const timeoutReason =
    typeof reason === "string" &&
    [
      "first_frame",
      "model_silence",
      "tool_idle",
      "tool_deadline",
      "run_deadline",
      "cleanup_timeout",
      "rpc_timeout"
    ].includes(reason)
      ? reason
      : undefined;
  const baseFailure =
    timeoutStage || timeoutMs !== undefined
      ? {
          ...classified,
          params: {
            ...classified.params,
            ...(timeoutStage ? { timeoutStage } : {}),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            ...(timeoutReason ? { timeoutReason } : {}),
            ...safeWatchdogEvidence(record.watchdog ?? upstreamParams)
          }
        }
      : classified;
  const capacity = safeCapacityEvidence(record);
  const failure =
    Object.keys(capacity).length > 0
      ? { ...baseFailure, params: { ...baseFailure.params, ...capacity } }
      : baseFailure;
  const adapterType = safeAdapterType(record.adapterType) ?? failure.source.adapter;
  const legacyCode = safeReasonCode(record.code) ?? failure.reasonCode;
  return {
    code: legacyCode,
    message: failureMessage(failure.code),
    ...(adapterType ? { adapterType } : {}),
    failure
  };
}

function diagnosticIdForContext(context: FailureClassificationContext): string {
  return (
    diagnosticIdFromRunId(context.runId) ??
    context.diagnosticId ??
    `diag_${randomUUID().replaceAll("-", "")}`
  );
}

function diagnosticIdFromRunId(runId: string | undefined): string | undefined {
  const match = /^run_([0-9a-f]{32})$/.exec(runId ?? "");
  return match ? `diag_${match[1]}` : undefined;
}

function safeTimeoutStage(value: unknown): string | undefined {
  return typeof value === "string" &&
    ["starting", "model_active", "tool_active", "run_deadline", "cleanup", "rpc"].includes(value)
    ? value
    : undefined;
}

function timeoutConfiguration(code: string, adapter?: string): Record<string, string> {
  const fields: Record<string, string> = {
    "OH-ADP-3007": "first_frame_timeout_ms",
    "OH-ADP-3008": "model_idle_timeout_ms",
    "OH-ADP-3009": "tool_timeout_ms",
    "OH-ADP-3010": "tool_wall_timeout_ms",
    "OH-ADP-3011": "run_timeout_ms",
    "OH-ADP-3012": "cancel_grace_ms"
  };
  if (fields[code]) return { configParameter: `execution_profile.runtime_limits.${fields[code]}` };
  if (code === "OH-ADP-3013" && adapter === "codex")
    return {
      configParameter: "execution_profile.agent_config.providerOptions.appServerRequestTimeoutMs"
    };
  return {};
}

function safeWatchdogEvidence(value: unknown): Record<string, unknown> {
  const input = asRecord(value) ?? {};
  const result: Record<string, unknown> = {};
  for (const key of [
    "elapsedMs",
    "phaseAgeMs",
    "lastCanonicalAgeMs",
    "lastProgressAgeMs",
    "lastTransportAgeMs",
    "openToolCount",
    "retryCount"
  ]) {
    const v = input[key];
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 86_400_000)
      result[key] = v;
  }
  if (input.activitySupport === "native_progress" || input.activitySupport === "canonical_only")
    result.activitySupport = input.activitySupport;
  return result;
}

export function safeCapacityEvidence(value: unknown): Record<string, string | number> {
  const input = asRecord(value) ?? {};
  const result: Record<string, string | number> = {};
  if (typeof input.boundary === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(input.boundary))
    result.boundary = input.boundary;
  for (const key of ["measuredBytes", "limitBytes", "itemCount", "limitItems"] as const) {
    const entry = input[key];
    if (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0) result[key] = entry;
  }
  return result;
}

function safeTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 86_400_000
    ? value
    : undefined;
}

export function failureMessage(code: string): string {
  return isPublicFailureCode(code)
    ? FAILURE_CATALOG[code].message
    : FAILURE_CATALOG["OH-SYS-9001"].message;
}

export function isFailureEnvelope(value: unknown): value is FailureEnvelope {
  const record = asRecord(value);
  if (!record) return false;
  const source = asRecord(record.source);
  const action = asRecord(record.action);
  if (!source || !action) return false;
  return (
    record.schemaVersion === 1 &&
    typeof record.code === "string" &&
    /^OH-[A-Z]{3}-\d{4}$/.test(record.code) &&
    typeof record.reasonCode === "string" &&
    record.reasonCode.length > 0 &&
    typeof record.category === "string" &&
    record.category.length > 0 &&
    typeof record.stage === "string" &&
    record.stage.length > 0 &&
    typeof record.messageKey === "string" &&
    record.messageKey.length > 0 &&
    asRecord(record.params) !== undefined &&
    typeof record.retryable === "boolean" &&
    typeof record.diagnosticId === "string" &&
    /^diag_[0-9a-f]{32}$/.test(record.diagnosticId) &&
    (source.component === "octo-runtime" || source.component === "octo-agent-worker") &&
    typeof action.type === "string" &&
    typeof action.labelKey === "string" &&
    typeof record.occurredAt === "string" &&
    !Number.isNaN(Date.parse(record.occurredAt))
  );
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
    for (const key of [
      "message",
      "reason",
      "type",
      "name",
      "error",
      "providerError",
      "data",
      "cause"
    ] as const) {
      visit(record[key], depth + 1);
    }
  };
  visit(input, 0);
  return { fingerprint: values.join(" ").toLowerCase().slice(0, 12_000), explicitCode, httpStatus };
}

function classify(
  evidence: FailureEvidence,
  defaultDomain: FailureDomain
): { code: PublicFailureCode; reasonCode: string } {
  const text = evidence.fingerprint;
  const explicit = evidence.explicitCode?.toUpperCase();
  for (const [reason, code] of Object.entries({
    UNSUPPORTED_INPUT_MODALITY: "OH-INP-5001",
    IMAGE_RECOVERY_INPUT_REQUIRED: "OH-INP-5001",
    IMAGE_LIMIT_EXCEEDED: "OH-INP-5002",
    ARTIFACT_UNAVAILABLE: "OH-INP-5003",
    ARTIFACT_INTEGRITY_MISMATCH: "OH-INP-5004",
    ARTIFACT_ACCESS_DENIED: "OH-INP-5005"
  })) {
    if (explicit === reason || text.includes(reason.toLowerCase()))
      return result(code as PublicFailureCode, reason);
  }
  const timeouts: Record<string, PublicFailureCode> = {
    ADAPTER_FIRST_FRAME_TIMEOUT: "OH-ADP-3007",
    ADAPTER_MODEL_IDLE_TIMEOUT: "OH-ADP-3008",
    ADAPTER_TOOL_IDLE_TIMEOUT: "OH-ADP-3009",
    ADAPTER_TOOL_DEADLINE: "OH-ADP-3010",
    ADAPTER_RUN_DEADLINE: "OH-ADP-3011",
    ADAPTER_CLEANUP_TIMEOUT: "OH-ADP-3012",
    RPC_TIMEOUT: "OH-ADP-3013",
    CODEX_FINALIZATION_TIMEOUT: "OH-ADP-3013"
  };
  if (explicit && timeouts[explicit]) return result(timeouts[explicit], explicit);
  if (explicit === "PROVIDER_MESSAGE_TOO_LARGE")
    return result("OH-PRV-4009", "PROVIDER_MESSAGE_TOO_LARGE");
  if (explicit === "HOST_FRAME_TOO_LARGE") return result("OH-ADP-3014", "HOST_FRAME_TOO_LARGE");
  if (
    [
      "STREAM_QUEUE_ITEM_TOO_LARGE",
      "STREAM_QUEUE_BYTES_EXCEEDED",
      "STREAM_QUEUE_ITEMS_EXCEEDED"
    ].includes(explicit ?? "")
  )
    return result("OH-RUN-2009", explicit!);
  if (explicit === "RUNTIME_DRAINING") return result("OH-RUN-2002", "RUNTIME_DRAINING");
  if (explicit === "IM_SESSION_QUEUE_FULL") return result("OH-RUN-2004", explicit);
  if (explicit === "IM_DELIVERY_UNKNOWN") return result("OH-RUN-2005", explicit);
  if (
    [
      "OUTBOX_HARD_LIMIT",
      "OUTBOX_BACKPRESSURE",
      "RUNTIME_CAPACITY_EXHAUSTED",
      "IM_BOT_WORKING_FULL"
    ].includes(explicit ?? "")
  ) {
    return result("OH-RUN-2003", explicit ?? "RUNTIME_CAPACITY_EXHAUSTED");
  }
  if (["LOCAL_STORE_FULL", "LOCAL_STORE_UNAVAILABLE"].includes(explicit ?? "")) {
    return result("OH-RUN-2008", explicit ?? "LOCAL_STORE_UNAVAILABLE");
  }
  if (
    explicit === "ENOENT" ||
    text.includes("command not found") ||
    text.includes("executable not found")
  ) {
    return result("OH-ADP-3002", explicit === "ENOENT" ? "ENOENT" : "COMMAND_NOT_FOUND");
  }
  if (explicit === "EPERM" || explicit === "EACCES" || text.includes("permission denied")) {
    return result(
      "OH-ADP-3003",
      explicit === "EPERM" || explicit === "EACCES" ? explicit : "EACCES"
    );
  }
  if (isProtocolFailure(explicit, text)) return result("OH-ADP-3005", "ADAPTER_PROTOCOL_ERROR");
  if (isAdapterTimeout(explicit, text, defaultDomain))
    return result("OH-ADP-3006", "ADAPTER_TIMEOUT");

  if (
    explicit === "PROVIDER_CONFIG_MISSING" ||
    containsAny(text, ["provider_config_missing", "provider configuration missing"])
  ) {
    return result("OH-PRV-4008", "PROVIDER_CONFIG_MISSING");
  }

  const status = evidence.httpStatus;
  if (
    status === 401 ||
    containsAny(text, ["invalid_api_key", "invalid api key", "token_expired", "unauthorized"])
  ) {
    return result(
      "OH-PRV-4001",
      status === 401 ? "PROVIDER_HTTP_401" : "PROVIDER_CREDENTIAL_INVALID"
    );
  }
  if (containsAny(text, ["official_clients_only", "official clients only", "client_not_allowed"])) {
    return result("OH-PRV-4007", "PROVIDER_CLIENT_NOT_ALLOWED");
  }
  if (status === 403 || containsAny(text, ["permission_denied", "forbidden"])) {
    return result(
      "OH-PRV-4002",
      status === 403 ? "PROVIDER_HTTP_403" : "PROVIDER_PERMISSION_DENIED"
    );
  }
  if (
    containsAny(text, ["model_not_found", "model not found", "unknown model"]) ||
    status === 404
  ) {
    return result("OH-PRV-4003", "PROVIDER_MODEL_NOT_FOUND");
  }
  if (
    containsAny(text, [
      "insufficient_quota",
      "quota exceeded",
      "quota_exhausted",
      "balance_exhausted",
      "billing limit"
    ])
  ) {
    return result("OH-PRV-4004", "PROVIDER_QUOTA_EXHAUSTED");
  }
  if (status === 429 || containsAny(text, ["rate_limit", "rate limit", "too many requests"])) {
    return result("OH-PRV-4005", "PROVIDER_RATE_LIMITED");
  }
  if (
    (status !== undefined && status >= 500) ||
    containsAny(text, [
      "provider_unavailable",
      "service unavailable",
      "bad gateway",
      "gateway timeout"
    ])
  ) {
    return result("OH-PRV-4006", "PROVIDER_UNAVAILABLE");
  }
  if (
    defaultDomain === "provider" &&
    (hasTimeoutEvidence(explicit, text) || explicit === "ECONNRESET" || /\beconnreset\b/.test(text))
  ) {
    return result("OH-PRV-4006", "PROVIDER_TIMEOUT");
  }
  if (defaultDomain === "adapter") {
    return result(
      "OH-ADP-3004",
      explicit === "ADAPTER_INVOCATION_FAILED" ? explicit : "ADAPTER_INVOCATION_FAILED"
    );
  }
  if (defaultDomain === "runtime") return result("OH-SYS-9001", "RUNTIME_ERROR_UNMAPPED");
  if (defaultDomain === "provider") return result("OH-PRV-4099", "PROVIDER_ERROR");
  return result("OH-SYS-9001", "INTERNAL_ERROR");
}

function isProtocolFailure(code: string | undefined, text: string): boolean {
  return (
    code === "INVALID_JSON" ||
    code?.endsWith("_RPC_ERROR") === true ||
    containsAny(text, [
      "invalid json",
      "protocol error",
      "rpc error",
      "unsupported canonical event"
    ])
  );
}

function isAdapterTimeout(code: string | undefined, text: string, domain: FailureDomain): boolean {
  if (code === "ADAPTER_TIMEOUT" || code === "RPC_TIMEOUT") return true;
  return domain === "adapter" && hasTimeoutEvidence(code, text);
}

function hasTimeoutEvidence(code: string | undefined, text: string): boolean {
  if (code === "ETIMEDOUT" || code === "TIMEOUT" || code?.endsWith("_TIMEOUT")) return true;
  // Keep timeout words and error identifiers, but exclude fields such as tool_timeout_sec.
  return /\b(?:[a-z0-9]+_)*timeout(?:error)?\b|\btimed\s+out\b|\betimedout\b/.test(text);
}

function result(
  code: PublicFailureCode,
  reasonCode: string
): { code: PublicFailureCode; reasonCode: string } {
  return { code, reasonCode };
}

function isPublicFailureCode(value: string): value is PublicFailureCode {
  return Object.hasOwn(FAILURE_CATALOG, value);
}

function safeReasonCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .slice(0, 128);
  return normalized.length > 0 ? normalized : undefined;
}

function safeAdapterType(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))
    return undefined;
  return value;
}

function numericHttpStatus(value: unknown): number | undefined {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{3}$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isInteger(numeric) && numeric >= 100 && numeric <= 599 ? numeric : undefined;
}

function containsAny(value: string, candidates: string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

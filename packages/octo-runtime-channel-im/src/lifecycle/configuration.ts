/** One configuration contract for SDK, CLI stdin and im.json. */
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { assertApprovalMode, assertContextEnvelope } from "@mininglamp-oss/octo-runtime-protocol";
import type { ImBotConfig } from "../contracts.js";

export function validateImConfig(config: ImBotConfig): void {
  if (!config || typeof config !== "object" || !["octo", "wecom"].includes(config.type))
    throw new Error("IM_TYPE_INVALID");
  if (typeof config.bot_id !== "string" || !config.bot_id.trim())
    throw new Error("IM_BOT_ID_REQUIRED");
  const adapter = config.adapter;
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter))
    throw new Error("IM_ADAPTER_REQUIRED");
  if (
    Object.keys(adapter).some(
      (key) => !["adapter_type", "workdir", "model", "effort", "provider_agent_id"].includes(key)
    )
  )
    throw new Error("IM_ADAPTER_UNKNOWN_FIELD");
  for (const value of [
    adapter.adapter_type,
    adapter.model,
    adapter.effort,
    adapter.provider_agent_id
  ])
    if (value !== undefined && (typeof value !== "string" || !value.trim()))
      throw new Error("IM_EXECUTION_CONFIG_INVALID");
  if (adapter.adapter_type === "openclaw") {
    if (adapter.workdir !== undefined) throw new Error("IM_OPENCLAW_WORKDIR_UNSUPPORTED");
    if (
      adapter.provider_agent_id !== undefined &&
      !/^[a-z0-9_][a-z0-9_-]{0,63}$/.test(adapter.provider_agent_id)
    )
      throw new Error("IM_PROVIDER_AGENT_ID_INVALID");
  } else {
    if (typeof adapter.workdir !== "string" || !isAbsolute(adapter.workdir))
      throw new Error("IM_WORKDIR_ABSOLUTE_REQUIRED");
    if (adapter.provider_agent_id !== undefined)
      throw new Error("IM_PROVIDER_AGENT_ID_UNSUPPORTED");
  }
  if (config.context !== undefined) assertContextEnvelope(config.context);
  assertApprovalMode(config.approval_mode ?? "full_access");
  if (
    config.allowed_sender_ids !== undefined &&
    (!Array.isArray(config.allowed_sender_ids) ||
      config.allowed_sender_ids.some((id) => typeof id !== "string" || !id))
  )
    throw new Error("IM_CONFIG_INVALID");
  if (
    config.run_timeout_ms !== undefined &&
    (!Number.isInteger(config.run_timeout_ms) ||
      config.run_timeout_ms < 1 ||
      config.run_timeout_ms > 600_000)
  )
    throw new Error("IM_CONFIG_INVALID");
  if (config.enabled !== undefined && typeof config.enabled !== "boolean")
    throw new Error("IM_CONFIG_INVALID");
  const fields = [
    "bot_id",
    "type",
    "enabled",
    "adapter",
    "context",
    "approval_mode",
    "run_timeout_ms",
    "allowed_sender_ids"
  ];
  if (config.type === "octo") {
    fields.push(
      "api_url",
      "bf_token",
      "bf_token_file",
      "group_ids",
      "group_rules",
      "history_limit",
      "cards",
      "typing"
    );
    if (typeof config.api_url !== "string" || !config.api_url.trim())
      throw new Error("IM_API_URL_INVALID");
    validateUrl(config.api_url, "https:", "http:");
    if (
      config.group_ids !== undefined &&
      (!Array.isArray(config.group_ids) ||
        config.group_ids.some((id) => typeof id !== "string" || !id))
    )
      throw new Error("IM_CONFIG_INVALID");
    if (
      config.history_limit !== undefined &&
      (!Number.isInteger(config.history_limit) ||
        config.history_limit < 0 ||
        config.history_limit > 100)
    )
      throw new Error("IM_CONFIG_INVALID");
    for (const key of ["cards", "typing", "group_rules"] as const)
      if (config[key] !== undefined && typeof config[key] !== "boolean")
        throw new Error("IM_CONFIG_INVALID");
    validateCredential(config.bf_token, config.bf_token_file);
  } else {
    fields.push("app_secret", "app_secret_file", "ws_url");
    validateUrl(config.ws_url ?? "wss://openws.work.weixin.qq.com", "wss:", "ws:");
    validateCredential(config.app_secret, config.app_secret_file);
  }
  if (Object.keys(config).some((key) => !fields.includes(key)))
    throw new Error("IM_CONFIG_UNKNOWN_FIELD");
}

/** Stable local lookup key, not a caller-supplied identity or authorization token. */
export function imBotIdentity(config: ImBotConfig): string {
  const identity =
    config.type === "octo"
      ? ["octo", new URL(config.api_url).href.replace(/\/+$/, ""), config.bot_id]
      : ["wecom", new URL(config.ws_url ?? "wss://openws.work.weixin.qq.com").href, config.bot_id];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function validateCredential(value?: string, file?: string): void {
  if (value !== undefined && typeof value !== "string") throw new Error("IM_CREDENTIAL_INVALID");
  if (file !== undefined && (typeof file !== "string" || !file.trim()))
    throw new Error("IM_CREDENTIAL_INVALID");
  if (value?.trim() && file?.trim()) throw new Error("IM_CREDENTIAL_SOURCE_CONFLICT");
}

function validateUrl(value: string, secure: string, local: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("IM_API_URL_INVALID");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== secure &&
      !(url.protocol === local && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
  )
    throw new Error("IM_API_URL_INVALID");
}

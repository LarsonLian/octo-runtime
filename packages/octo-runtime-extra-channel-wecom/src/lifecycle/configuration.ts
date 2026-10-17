/** WeCom 插件内部的 Bot 配置合同。 */
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { assertApprovalMode, assertContextEnvelope } from "@mininglamp-oss/octo-runtime-protocol";
import type { ImBotConfig } from "../contracts.js";

export function validateImBots(value: unknown): asserts value is ImBotConfig[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error("IM_CONFIG_LIST_REQUIRED");
  const identities = new Set<string>();
  for (const bot of value as ImBotConfig[]) {
    validateImConfig(bot);
    const identity = imBotIdentity(bot);
    if (identities.has(identity)) throw new Error("IM_BOT_DUPLICATED");
    identities.add(identity);
  }
}

export function configuredCredential(config: ImBotConfig): string | undefined {
  return config.app_secret?.trim() || undefined;
}

export function validateImConfig(config: ImBotConfig): void {
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("IM_CONFIG_INVALID");
  if (typeof config.bot_id !== "string" || !config.bot_id.trim())
    throw new Error("IM_BOT_ID_REQUIRED");
  if (
    config.bot_name !== undefined &&
    (typeof config.bot_name !== "string" || !config.bot_name.trim())
  )
    throw new Error("IM_BOT_NAME_INVALID");
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
    "bot_name",
    "enabled",
    "adapter",
    "context",
    "approval_mode",
    "run_timeout_ms",
    "allowed_sender_ids"
  ];
  fields.push("app_secret", "ws_url");
  validateUrl(config.ws_url ?? "wss://openws.work.weixin.qq.com", "wss:", "ws:");
  if (config.app_secret !== undefined && typeof config.app_secret !== "string")
    throw new Error("IM_CREDENTIAL_INVALID");
  if (Object.keys(config).some((key) => !fields.includes(key)))
    throw new Error("IM_CONFIG_UNKNOWN_FIELD");
}

/** Stable local lookup key, not a caller-supplied identity or authorization token. */
export function imBotIdentity(config: ImBotConfig): string {
  const identity = [
    "wecom",
    new URL(config.ws_url ?? "wss://openws.work.weixin.qq.com").href,
    config.bot_id
  ];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
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

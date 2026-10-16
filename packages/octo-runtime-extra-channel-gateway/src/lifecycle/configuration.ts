/** Octo 插件内部的 Bot 配置合同。 */
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  assertApprovalMode,
  assertContextEnvelope,
  assertJsonByteLimit
} from "@mininglamp-oss/octo-runtime-protocol";
import type { ImBotConfig } from "../contracts.js";

export const IM_MAX_BOTS = 64;
export const IM_MAX_CONFIG_OPERATIONS = 64;
export const IM_MAX_CONFIG_BYTES = 256 * 1024;

export function validateImBots(value: unknown): asserts value is ImBotConfig[] {
  if (!Array.isArray(value) || value.length > IM_MAX_BOTS)
    throw new Error("IM_CONFIG_LIST_REQUIRED");
  const identities = new Set<string>();
  for (const bot of value as ImBotConfig[]) {
    validateImConfig(bot);
    const identity = imBotIdentity(bot);
    if (identities.has(identity)) throw new Error("IM_BOT_DUPLICATED");
    identities.add(identity);
  }
}

export function configuredCredential(config: ImBotConfig): string | undefined {
  return config.bf_token?.trim() || undefined;
}

export function validateImConfig(config: ImBotConfig): void {
  assertJsonByteLimit(config, IM_MAX_CONFIG_BYTES, "IM_CONFIG_TOO_LARGE");
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
  for (const value of [
    adapter.adapter_type,
    adapter.model,
    adapter.effort,
    adapter.provider_agent_id
  ])
    if (value !== undefined && (typeof value !== "string" || !value.trim()))
      throw new Error("IM_EXECUTION_CONFIG_INVALID");
  if (
    adapter.workdir === undefined &&
    (config.bot_id === "." ||
      config.bot_id === ".." ||
      /[/\\]/.test(config.bot_id) ||
      config.bot_id.includes("\0"))
  )
    throw new Error("IM_BOT_ID_PATH_INVALID");
  if (adapter.adapter_type === "openclaw") {
    if (adapter.workdir !== undefined) throw new Error("IM_OPENCLAW_WORKDIR_UNSUPPORTED");
    if (
      adapter.provider_agent_id !== undefined &&
      !/^[a-z0-9_][a-z0-9_-]{0,63}$/.test(adapter.provider_agent_id)
    )
      throw new Error("IM_PROVIDER_AGENT_ID_INVALID");
  } else {
    if (
      adapter.workdir !== undefined &&
      (typeof adapter.workdir !== "string" || !isAbsolute(adapter.workdir))
    )
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
      config.run_timeout_ms < 100 ||
      config.run_timeout_ms > 86_400_000)
  )
    throw new Error("IM_CONFIG_INVALID");
  if (config.codex_retry !== undefined) {
    const retry = config.codex_retry;
    if (!retry || typeof retry !== "object" || Array.isArray(retry))
      throw new Error("IM_RETRY_CONFIG_INVALID");
    if (retry.enabled !== undefined && typeof retry.enabled !== "boolean")
      throw new Error("IM_RETRY_CONFIG_INVALID");
    const bounds = {
      max_consecutive_retries: [0, 100],
      max_total_retries: [0, 100],
      recovery_timeout_ms: [100, 3_600_000],
      initial_delay_ms: [100, 60_000],
      max_delay_ms: [100, 300_000]
    } as const;
    for (const field of Object.keys(bounds) as (keyof typeof bounds)[]) {
      const value = retry[field];
      if (
        value !== undefined &&
        (!Number.isInteger(value) || value < bounds[field][0] || value > bounds[field][1])
      )
        throw new Error("IM_RETRY_CONFIG_INVALID");
    }
    if ((retry.initial_delay_ms ?? 2_000) > (retry.max_delay_ms ?? 30_000))
      throw new Error("IM_RETRY_CONFIG_INVALID");
  }
  if (config.enabled !== undefined && typeof config.enabled !== "boolean")
    throw new Error("IM_CONFIG_INVALID");
  if (typeof config.api_url !== "string" || !config.api_url.trim())
    throw new Error("IM_API_URL_INVALID");
  validateUrl(config.api_url, "https:", "http:");
  if (
    config.group_ids !== undefined &&
    (!Array.isArray(config.group_ids) ||
      config.group_ids.some((id) => typeof id !== "string" || !id))
  )
    throw new Error("IM_CONFIG_INVALID");
  for (const key of ["cards", "typing", "group_rules"] as const)
    if (config[key] !== undefined && typeof config[key] !== "boolean")
      throw new Error("IM_CONFIG_INVALID");
  if (config.bf_token !== undefined && typeof config.bf_token !== "string")
    throw new Error("IM_CREDENTIAL_INVALID");
}

/** Stable local lookup key, not a caller-supplied identity or authorization token. */
export function imBotIdentity(config: ImBotConfig): string {
  const identity = ["octo", new URL(config.api_url).href.replace(/\/+$/, ""), config.bot_id];
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

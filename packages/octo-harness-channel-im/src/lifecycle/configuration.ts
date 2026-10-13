/**
 * 配置边界：在建立连接前校验字段、执行设置和平台身份。
 * 身份包含服务地址与空间，防止不同环境的同名 Bot 被误当作同一个连接。
 */
import { isAbsolute } from "node:path";
import { assertApprovalMode, assertContextEnvelope } from "@mininglamp-oss/octo-harness-protocol";
import type { ImBotConfig } from "../contracts.js";

export function validateImConfig(config: ImBotConfig): void {
  if (!config || typeof config !== "object" || !["octo", "wecom"].includes(config.type))
    throw new Error("IM_TYPE_INVALID");
  if (typeof config.id !== "string" || !config.id.trim()) throw new Error("IM_CONFIG_INVALID");
  if (
    config.adapterType !== undefined &&
    (typeof config.adapterType !== "string" || !config.adapterType.trim())
  )
    throw new Error("IM_CONFIG_INVALID");
  if (
    config.workdir !== undefined &&
    (typeof config.workdir !== "string" || !isAbsolute(config.workdir))
  )
    throw new Error("IM_EXECUTION_CONFIG_INVALID");
  if (config.context !== undefined) assertContextEnvelope(config.context);
  assertApprovalMode(config.approvalMode ?? "full_access");
  if (
    config.allowedSenderIds !== undefined &&
    (!Array.isArray(config.allowedSenderIds) ||
      config.allowedSenderIds.some((id) => typeof id !== "string" || !id))
  )
    throw new Error("IM_CONFIG_INVALID");
  if (
    config.runTimeoutMs !== undefined &&
    (!Number.isInteger(config.runTimeoutMs) ||
      config.runTimeoutMs < 1 ||
      config.runTimeoutMs > 600_000)
  )
    throw new Error("IM_CONFIG_INVALID");
  if (config.enabled !== undefined && typeof config.enabled !== "boolean")
    throw new Error("IM_CONFIG_INVALID");
  const fields = [
    "id",
    "type",
    "enabled",
    "adapterType",
    "workdir",
    "model",
    "context",
    "approvalMode",
    "runTimeoutMs",
    "allowedSenderIds"
  ];
  if (config.type === "octo") {
    fields.push(
      "apiUrl",
      "botId",
      "spaceId",
      "token",
      "tokenFile",
      "groupIds",
      "groupRules",
      "historyLimit",
      "cards",
      "typing"
    );
    for (const key of ["botId", "spaceId", "apiUrl"] as const)
      if (typeof config[key] !== "string" || !config[key].trim())
        throw new Error("IM_CONFIG_INVALID");
    const url = new URL(config.apiUrl);
    validateUrl(url, "https:", "http:");
    if (
      config.groupIds !== undefined &&
      (!Array.isArray(config.groupIds) ||
        config.groupIds.some((id) => typeof id !== "string" || !id))
    )
      throw new Error("IM_CONFIG_INVALID");
    if (
      config.historyLimit !== undefined &&
      (!Number.isInteger(config.historyLimit) ||
        config.historyLimit < 0 ||
        config.historyLimit > 100)
    )
      throw new Error("IM_CONFIG_INVALID");
    for (const key of ["cards", "typing", "groupRules"] as const)
      if (config[key] !== undefined && typeof config[key] !== "boolean")
        throw new Error("IM_CONFIG_INVALID");
    validateCredential(config.token, config.tokenFile);
  } else {
    fields.push("appBot", "appSecret", "appSecretFile", "wsUrl");
    if (typeof config.appBot !== "string" || !config.appBot.trim())
      throw new Error("IM_CONFIG_INVALID");
    validateUrl(new URL(config.wsUrl ?? "wss://openws.work.weixin.qq.com"), "wss:", "ws:");
    validateCredential(config.appSecret, config.appSecretFile);
  }
  if (Object.keys(config).some((key) => !fields.includes(key)))
    throw new Error("IM_CONFIG_UNKNOWN_FIELD");
}

function validateCredential(value?: string, file?: string): void {
  if (value !== undefined && typeof value !== "string") throw new Error("IM_CREDENTIAL_INVALID");
  if (file !== undefined && typeof file !== "string") throw new Error("IM_CREDENTIAL_INVALID");
  if (value?.trim() && file?.trim()) throw new Error("IM_CREDENTIAL_SOURCE_CONFLICT");
}

function validateUrl(url: URL, secure: string, local: string): void {
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

export function imBotIdentity(config: ImBotConfig): string {
  return config.type === "octo"
    ? ["octo", new URL(config.apiUrl).href.replace(/\/+$/, ""), config.spaceId, config.botId].join(
        "\0"
      )
    : [
        "wecom",
        new URL(config.wsUrl ?? "wss://openws.work.weixin.qq.com").href,
        config.appBot
      ].join("\0");
}

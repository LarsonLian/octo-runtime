/** 插件内部的 Bot 列表校验与凭据文件读取。 */
import { readFileSync, statSync } from "node:fs";
import type { ImBotConfig } from "../contracts.js";
import { imBotIdentity, validateImConfig, IM_MAX_BOTS } from "./configuration.js";

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

function checkPrivateFile(file: string): void {
  const info = statSync(file);
  if (!info.isFile() || (process.platform !== "win32" && info.mode & 0o077))
    throw new Error("IM_CREDENTIAL_PERMISSIONS_REQUIRE_0600");
}
export function configuredCredential(config: ImBotConfig): string | undefined {
  const value = config.bf_token;
  if (value?.trim()) return value.trim();
  const file = config.bf_token_file;
  if (!file) return;
  try {
    checkPrivateFile(file);
    return readFileSync(file, "utf8").trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

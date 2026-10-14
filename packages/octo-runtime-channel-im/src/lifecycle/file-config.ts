/** CLI file adapter. SDK never discovers files unless its host selects this adapter. */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ImBotConfig } from "../contracts.js";
import { imBotIdentity, validateImConfig } from "./configuration.js";

export function validateImBots(value: unknown): asserts value is ImBotConfig[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error("IM_CONFIG_LIST_REQUIRED");
  const identities = new Set<string>();
  for (const bot of value) {
    validateImConfig(bot);
    const identity = imBotIdentity(bot);
    if (identities.has(identity)) throw new Error("IM_BOT_DUPLICATED");
    identities.add(identity);
  }
}

/** Reads a JSON array, without rewriting defaults or allocating workspaces. */
export function readImBots(home: string): ImBotConfig[] {
  const file = resolve(home, "im.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("IM_CONFIG_JSON_INVALID");
  }
  validateImBots(value);
  if (value.some((bot) => (bot.type === "octo" ? !!bot.bf_token : !!bot.app_secret)))
    checkPrivateFile(file);
  return value;
}

export function loadImBots(home: string): ImBotConfig[] {
  return readImBots(home).map((bot) =>
    bot.type === "octo"
      ? {
          ...bot,
          ...(bot.bf_token_file ? { bf_token_file: resolve(home, bot.bf_token_file) } : {})
        }
      : {
          ...bot,
          ...(bot.app_secret_file ? { app_secret_file: resolve(home, bot.app_secret_file) } : {})
        }
  );
}

function checkPrivateFile(file: string): void {
  const info = statSync(file);
  if (!info.isFile() || (process.platform !== "win32" && info.mode & 0o077))
    throw new Error("IM_CREDENTIAL_PERMISSIONS_REQUIRE_0600");
}
export function configuredCredential(config: ImBotConfig): string | undefined {
  const value = config.type === "octo" ? config.bf_token : config.app_secret;
  if (value?.trim()) return value.trim();
  const file = config.type === "octo" ? config.bf_token_file : config.app_secret_file;
  if (!file) return;
  try {
    checkPrivateFile(file);
    return readFileSync(file, "utf8").trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

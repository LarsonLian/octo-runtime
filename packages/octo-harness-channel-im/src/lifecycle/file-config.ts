/**
 * 可选文件适配：读取宿主显式指定 Home 下的 im.json，并处理文件凭据与默认值。
 * 这是 CLI 可复用的接入政策；公共 runtime 和 SDK 不会自动扫描 Home/accounts。
 */
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { assertApprovalMode } from "@mininglamp-oss/octo-harness-protocol";
import type { ImBotConfig } from "../contracts.js";
import { imBotIdentity, validateImConfig } from "./configuration.js";

/** 显式文件入口：由宿主选择 Home；公共 IM runtime 不发现目录或套用宿主聊天设置。 */
export function loadImBots(home: string): ImBotConfig[] {
  const file = resolve(home, "im.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const config = JSON.parse(text) as { bots?: ImBotConfig[] };
  if (
    !config ||
    !Array.isArray(config.bots) ||
    config.bots.length > 16 ||
    Object.keys(config).some((key) => key !== "bots")
  )
    throw new Error("IM_CONFIG_INVALID");
  const ids = new Set<string>(),
    identities = new Set<string>();
  const createdDirectories: string[] = [];
  const bots = config.bots.map((bot) => {
    validateImConfig(bot);
    const identity = imBotIdentity(bot);
    if (ids.has(bot.id) || identities.has(identity)) throw new Error("IM_BOT_DUPLICATED");
    ids.add(bot.id);
    identities.add(identity);
    if ((bot.type === "octo" && bot.token) || (bot.type === "wecom" && bot.appSecret))
      checkPrivateFile(file);
    const adapter = bot.context?.items.find(
      (item) => item.namespace === "octo.execution" && item.name === "adapter"
    )?.payload.type;
    const workspace = bot.context?.items.find(
      (item) => item.namespace === "octo.execution" && item.name === "workspace"
    )?.payload.path;
    const approval = bot.context?.items.find(
      (item) => item.namespace === "octo.security" && item.name === "approval_policy"
    )?.payload.mode;
    if (approval !== undefined) assertApprovalMode(approval);
    const allocated = resolve(
      home,
      "workspaces",
      "im",
      createHash("sha256").update(bot.id).digest("hex").slice(0, 24)
    );
    const normalized = {
      ...bot,
      enabled: bot.enabled ?? false,
      adapterType: bot.adapterType ?? (typeof adapter === "string" ? adapter : "codex"),
      approvalMode: bot.approvalMode ?? approval ?? "full_access",
      workdir: bot.workdir ?? (typeof workspace === "string" ? workspace : allocated)
    };
    if (normalized.enabled && normalized.workdir === allocated) createdDirectories.push(allocated);
    return normalized;
  });
  // 先完成整份校验再补默认值，避免部分有效配置带来部分写入。
  if (JSON.stringify(config.bots) !== JSON.stringify(bots)) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ bots }, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx"
      });
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  for (const directory of createdDirectories)
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  return bots.map((bot) =>
    bot.type === "octo"
      ? { ...bot, ...(bot.tokenFile?.trim() ? { tokenFile: resolve(home, bot.tokenFile) } : {}) }
      : {
          ...bot,
          ...(bot.appSecretFile?.trim() ? { appSecretFile: resolve(home, bot.appSecretFile) } : {})
        }
  );
}

function checkPrivateFile(file: string): void {
  const info = statSync(file);
  if (!info.isFile() || (process.platform !== "win32" && info.mode & 0o077))
    throw new Error("IM_CREDENTIAL_PERMISSIONS_REQUIRE_0600");
}
export function configuredCredential(config: ImBotConfig): string | undefined {
  const value = config.type === "octo" ? config.token : config.appSecret;
  if (value?.trim()) return value.trim();
  const file = config.type === "octo" ? config.tokenFile : config.appSecretFile;
  if (!file?.trim()) return;
  try {
    checkPrivateFile(file);
    return readFileSync(file, "utf8").trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

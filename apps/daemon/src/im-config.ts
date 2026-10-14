import { join } from "node:path";
import { homedir } from "node:os";
import {
  configureOpenClawConnection,
  loadLocalOpenClawGateway
} from "@mininglamp-oss/octo-runtime-adapter-openclaw";
/**
 * CLI 接入政策：在 CLI 选定的 Home 中加载 IM 配置，并提供文件凭据读取能力。
 * SDK 客户应用自行装配配置与目录；文件暂未出现时允许账号等待凭据。
 */
import { configuredCredential, loadImBots } from "@mininglamp-oss/octo-runtime-extra-channel-gateway";
import type { ImBotConfig, ImCredentialSource } from "@mininglamp-oss/octo-runtime-extra-channel-gateway";
import { configuredCredential as wecomCredential, loadImBots as loadWecomBots, type WecomBotConfig, type ImCredentialSource as WecomCredentialSource } from "@mininglamp-oss/octo-runtime-extra-channel-wecom";

/** CLI 选择 Home/im.json；公共 runtime 只消费显式配置与宿主凭据能力。 */
export function loadCliImConfiguration(home: string): {
  imBots: ImBotConfig[];
  imCredentials: ImCredentialSource;
  wecomBots: WecomBotConfig[];
  wecomCredentials: WecomCredentialSource;
} {
  return {
    wecomBots: loadWecomBots(home),
    wecomCredentials: (config) => Promise.resolve(wecomCredential(config)),
    imBots: loadImBots(home),
    imCredentials: (config) => {
      try {
        return Promise.resolve(configuredCredential(config));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return Promise.resolve(undefined);
        return Promise.reject(
          error instanceof Error ? error : new Error("IM_CREDENTIAL_READ_FAILED", { cause: error })
        );
      }
    }
  };
}

/** CLI owns discovery; shared daemon and SDK only consume host-selected configuration. */
export async function initializeCliImAdapters(
  home: string,
  bots: (ImBotConfig | WecomBotConfig)[],
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!bots.some((bot) => bot.enabled !== false && bot.adapter.adapter_type === "openclaw")) return;
  const runtimeRoot = join(home, "default");
  await configureOpenClawConnection(
    runtimeRoot,
    { openclawHome: env.OPENCLAW_HOME || join(env.HOME || homedir(), ".openclaw") },
    env
  );
  await loadLocalOpenClawGateway(runtimeRoot);
}

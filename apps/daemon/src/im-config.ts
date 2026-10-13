/**
 * CLI 接入政策：在 CLI 选定的 Home 中加载 IM 配置，并提供文件凭据读取能力。
 * SDK 客户应用自行装配配置与目录；文件暂未出现时允许账号等待凭据。
 */
import { configuredCredential, loadImBots } from "@mininglamp-oss/octo-harness-channel-im";
import type { ImBotConfig, ImCredentialSource } from "@mininglamp-oss/octo-harness-channel-im";

/** CLI 选择 Home/im.json；公共 runtime 只消费显式配置与宿主凭据能力。 */
export function loadCliImConfiguration(home: string): {
  imBots: ImBotConfig[];
  imCredentials: ImCredentialSource;
} {
  return {
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

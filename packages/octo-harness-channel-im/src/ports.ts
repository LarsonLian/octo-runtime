/**
 * 宿主依赖入口：注入执行能力、凭据来源和脱敏诊断。
 * SDK 应用自行决定账号目录和凭据生命周期，通道无需依赖 CLI 或具体 Provider。
 */
import type { ImBotConfig, ImExecutionPort } from "./contracts.js";

export type ImCredentialSource = (
  config: ImBotConfig,
  signal: AbortSignal
) => Promise<string | undefined>;
export interface ImModuleDependencies {
  host: ImExecutionPort;
  credentials?: ImCredentialSource;
  onDiagnostic?: (code: string, identity: { endpointId: string; runId?: string }) => void;
}

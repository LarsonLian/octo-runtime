/**
 * 宿主依赖入口：注入执行能力、凭据来源和脱敏诊断。
 * SDK 应用自行决定账号目录和凭据生命周期，通道无需依赖 CLI 或具体 Provider。
 */
import type { ImBotConfig, ImExecutionPort } from "./contracts.js";
import type { ImSessionStore } from "./application/session-store.js";
import type { RuntimeLog, JsonObject } from "@mininglamp-oss/octo-runtime-daemon";
import type { ContextItem } from "@mininglamp-oss/octo-runtime-protocol";

export type ImCredentialSource = (
  config: ImBotConfig,
  signal: AbortSignal
) => Promise<string | undefined>;
export interface ImModuleDependencies {
  prepareContexts?: (config: JsonObject, signal: AbortSignal) => Promise<ContextItem[]>;
  log?: RuntimeLog;
  host: ImExecutionPort;
  /** Owning Extra/manager lifetime; aborts connections, execution and delivery. */
  signal?: AbortSignal;
  authorizeSpace?: (spaceId: string) => void;
  credentials?: ImCredentialSource;
  sessions?: ImSessionStore;
  onDiagnostic?: (code: string, identity: { endpointId: string; runId?: string }) => void;
}

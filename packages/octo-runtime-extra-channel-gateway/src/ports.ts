/**
 * 宿主依赖入口：注入执行能力、凭据来源和脱敏诊断。
 * SDK 应用自行决定账号目录和凭据生命周期，通道无需依赖 CLI 或具体 Provider。
 */
import type { ImBotConfig, ImExecutionPort } from "./contracts.js";
import type { ImSessionStore } from "./application/session-store.js";
import type {
  ChannelDependencies,
  RuntimeLog,
  JsonObject
} from "@mininglamp-oss/octo-runtime-daemon";
import type { ContextItem } from "@mininglamp-oss/octo-runtime-protocol";

export type ImCredentialSource = (
  config: ImBotConfig,
  signal: AbortSignal
) => Promise<string | undefined>;
/** Gateway 专属宿主依赖；函数和返回句柄只留在宿主 Node 进程，不进入配置或 IPC。 */
export interface GatewayDependencies extends ChannelDependencies {
  /** 每个启用 Bot 调用一次，配置为已校验的独立快照，保留宿主 scope 扩展字段。
   * 返回独立句柄，所有权交给 Gateway；close 只释放该句柄，不关闭宿主共享数据库。
   * 工厂及读写同步，失败直接报告；不回退内存。异步释放允许返回 Promise。
   */
  readonly createSessionStore?: (config: JsonObject) => ImSessionStore;
}
export interface ImModuleDependencies {
  createSessionStore?: GatewayDependencies["createSessionStore"];
  prepareContexts?: (config: JsonObject, signal: AbortSignal) => Promise<ContextItem[]>;
  log?: RuntimeLog;
  host: ImExecutionPort;
  /** Owning Extra/manager lifetime; aborts connections, execution and delivery. */
  signal?: AbortSignal;
  authorizeSpace?: (spaceId: string) => void;
  credentials?: ImCredentialSource;
  /** 直接注入是借用，不由 Runtime/Manager 关闭；与 createSessionStore 互斥。 */
  sessions?: ImSessionStore;
  onDiagnostic?: (code: string, identity: { endpointId: string; runId?: string }) => void;
}

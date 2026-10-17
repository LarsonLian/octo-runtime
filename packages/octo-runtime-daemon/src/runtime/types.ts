import type {
  InputInvoke,
  InputFrames,
  NativeInteractionResponse,
  InteractionResponse
} from "@mininglamp-oss/octo-runtime-protocol";
import type { HostedAdapterMetadata } from "@mininglamp-oss/octo-runtime-adapter-host";
import type { ExtraDescriptor } from "../extra-config.js";
import type { ExtraPluginModule, ExtraStatus, JsonObject } from "../extras.js";
import type { RuntimeLoggingOptions } from "@mininglamp-oss/octo-runtime-adapter-sdk";
export type { RuntimeLoggingOptions } from "@mininglamp-oss/octo-runtime-adapter-sdk";
export interface DaemonModuleDescriptor {
  id: string;
  module: string;
  exportName: string;
}

export type DaemonPhase =
  | "idle"
  | "preparing-home"
  | "enrolling"
  | "starting"
  | "running"
  | "degraded"
  | "stopping"
  | "stopped"
  | "error";

export interface DaemonDistribution {
  nodePath?: string;
  runnerPath?: string;
  /** 显式 JSON 覆盖的兼容入口；SDK 默认不读取清单，也不读取 CLI 的默认资源。 */
  manifestPath?: string;
  /** 宿主选择的独立 Host JS 入口：在该子进程中直接 import 并注册 Adapter，不能在 main 中执行。 */
  adapterHostEntrypoint?: string;
}

export interface DaemonRuntimeOptions {
  logging?: RuntimeLoggingOptions;
  appId: string;
  home: string;
  distribution?: DaemonDistribution;
  development?: boolean;
  modules?: readonly DaemonModuleDescriptor[];
  extras?: readonly ExtraDescriptor[];
  startupTimeoutMs?: number;
  healthPollIntervalMs?: number;
  platform?: NodeJS.Platform;
}

export interface AccountSubject {
  type: "user";
  id: string;
}

export interface AuthorizedTenant {
  id: string;
  name?: string;
}

export interface StartAccountOptions {
  subject: AccountSubject;
  tenants: readonly AuthorizedTenant[];
}

export interface ProfileHealth {
  tenantId: string;
  profile: string;
  runtimeId?: string;
  state: "pending" | "ready" | "offline";
  reasonCode?: string;
  observedAt: number;
}

export interface DaemonProblem {
  code: string;
  scope: "distribution" | "home" | "enrollment" | "daemon" | "profile" | "shutdown";
  retryable: boolean;
  profile?: string;
  message: string;
}

export interface DaemonHealth {
  phase: DaemonPhase;
  generation: number;
  accountKey?: string;
  machineId?: string;
  home: string;
  local: {
    ready: boolean;
    pid?: number;
    adapterHostReady: boolean;
    socketReachable: boolean;
  };
  modules: Record<string, unknown>;
  extras?: Record<string, ExtraStatus>;
  profiles: readonly ProfileHealth[];
  problem?: DaemonProblem;
  observedAt: number;
}

export interface DaemonRuntime {
  /** 加载可序列化声明；适用于 JSON 配置，由 daemon runner 装配插件。 */
  loadExtra(descriptor: ExtraDescriptor): Promise<Record<string, ExtraStatus>>;
  /**
   * 在宿主 Node 进程加载完整 Extra，可注入 loadContexts 等业务函数。
   * 适用于 Buddy/自研 CLI 从内存、数据库或 HTTP 动态读取每轮 Context；
   * 更新函数读取的数据无需重载插件，替换函数引用或 JSON 配置则先 unload 再 load。
   * dependencies 不进入 JSON/IPC；SDK 提供执行端口，复用原 daemon 与独立 AdapterHost，
   * 并负责状态、取消及卸载/退出清理。宿主不创建插件内部对象。
   * .octospec/tasks/sdk-host-extra-contexts/brief.md
   */
  loadExtra<D extends object>(
    module: ExtraPluginModule<D>,
    config: JsonObject,
    dependencies: Readonly<D>
  ): Promise<Record<string, ExtraStatus>>;
  /** 停止整个 Extra 并等待清理；清理失败不得继续加载同名实例。 */
  unloadExtra(name: string): Promise<Record<string, ExtraStatus>>;
  extraStatus(): Promise<Record<string, ExtraStatus>>;
  extraStatus(name: string): Promise<JsonObject>;
  startModule(id: string, config: unknown): Promise<unknown>;
  stopModule(id: string): Promise<void>;
  requestModule<T = unknown>(
    id: string,
    method: string,
    params?: Record<string, unknown>
  ): Promise<T>;
  invoke: InputInvoke;
  invokeFrames: InputFrames;
  listAdapters(runtimeId?: string): Promise<HostedAdapterMetadata[]>;
  cancelRun(runId: string): Promise<{ cancelled: boolean }>;
  respondRun(runId: string, response: InteractionResponse): Promise<void>;
  respondNativeRun(runId: string, response: NativeInteractionResponse): Promise<void>;
  subscribeRun(input: {
    runId: string;
    streamId?: string;
    afterSeq?: number;
    signal?: AbortSignal;
  }): AsyncIterable<Record<string, unknown>>;
  startAccount(options: StartAccountOptions): Promise<DaemonHealth>;
  reconcileTenants(tenants: readonly AuthorizedTenant[]): Promise<DaemonHealth>;
  stop(reason?: "logout" | "account-switch" | "quit" | "reconfigure"): Promise<void>;
  health(): DaemonHealth;
  onHealth(listener: (health: DaemonHealth) => void): () => void;
}

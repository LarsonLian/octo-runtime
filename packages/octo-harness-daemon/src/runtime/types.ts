import type {
  HostInvoke,
  HostFrame,
  HostInvokeOptions,
  NativeInteractionResponse,
  InvokeRequest,
  InteractionResponse
} from "@mininglamp-oss/octo-harness-protocol";
import type { HostedAdapterMetadata } from "@mininglamp-oss/octo-harness-adapter-host";
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
  manifestPath?: string;
  adapterHostEntrypoint?: string;
}

export interface DaemonRuntimeOptions {
  appId: string;
  home: string;
  distribution?: DaemonDistribution;
  development?: boolean;
  modules?: readonly DaemonModuleDescriptor[];
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
  profiles: readonly ProfileHealth[];
  problem?: DaemonProblem;
  observedAt: number;
}

export interface DaemonRuntime {
  startModule(id: string, config: unknown): Promise<unknown>;
  stopModule(id: string): Promise<void>;
  requestModule<T = unknown>(
    id: string,
    method: string,
    params?: Record<string, unknown>
  ): Promise<T>;
  invoke: HostInvoke;
  invokeFrames(
    adapterType: string,
    request: InvokeRequest,
    options?: HostInvokeOptions
  ): AsyncGenerator<HostFrame>;
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

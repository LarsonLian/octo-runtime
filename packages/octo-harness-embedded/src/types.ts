import type {
  HostInvoke,
  HostFrame,
  HostInvokeOptions,
  NativeInteractionResponse,
  InvokeRequest,
  InteractionResponse
} from "@mininglamp-oss/octo-harness-protocol";
import type { HostedAdapterMetadata } from "@mininglamp-oss/octo-harness-adapter-host";
import type { ImBotConfig } from "@mininglamp-oss/octo-harness-daemon";

export type EmbeddedPhase =
  | "idle"
  | "preparing-home"
  | "enrolling"
  | "starting"
  | "running"
  | "degraded"
  | "stopping"
  | "stopped"
  | "error";

export interface EmbeddedDistribution {
  nodePath?: string;
  runnerPath?: string;
  manifestPath?: string;
  adapterHostEntrypoint?: string;
}

export interface EmbeddedHarnessOptions {
  appId: string;
  home: string;
  distribution?: EmbeddedDistribution;
  development?: boolean;
  fetchImplementation?: typeof fetch;
  startupTimeoutMs?: number;
  healthPollIntervalMs?: number;
  platform?: NodeJS.Platform;
}

export interface AccountSubject {
  type: "user";
  id: string;
}

export interface AuthorizedTenant {
  agentIdentity?: string;
  agentName?: string;
  id: string;
  name?: string;
  serverUrl: string;
  agentWorkUrl: string;
  /** Trusted host configuration for Harness-owned material and output transport. */
  businessServiceBindings?: Partial<
    Record<"task" | "discussion", { serviceSubjectId: string; url: string }>
  >;
}

export interface StartAccountOptions {
  subject: AccountSubject;
  tenants: readonly AuthorizedTenant[];
  getHumanToken(): string | Promise<string>;
}

export interface ProfileHealth {
  tenantId: string;
  profile: string;
  runtimeId?: string;
  state: "pending" | "enrolling" | "connecting" | "online" | "offline" | "unauthorized" | "error";
  reasonCode?: string;
  observedAt: number;
}

export interface EmbeddedProblem {
  code: string;
  scope: "distribution" | "home" | "enrollment" | "daemon" | "profile" | "shutdown";
  retryable: boolean;
  profile?: string;
  message: string;
}

export interface EmbeddedHealth {
  phase: EmbeddedPhase;
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
  cloud: {
    totalProfiles: number;
    connectedProfiles: number;
    allConnected: boolean;
  };
  profiles: readonly ProfileHealth[];
  problem?: EmbeddedProblem;
  observedAt: number;
}

export interface EmbeddedHarness {
  upsertImBot(config: ImBotConfig, revision: number): Promise<Record<string, unknown>>;
  removeImBot(id: string, revision: number): Promise<void>;
  imStatus(): Promise<Record<string, unknown>[]>;
  invoke: HostInvoke;
  invokeFrames(
    adapterType: string,
    request: InvokeRequest,
    options?: HostInvokeOptions
  ): AsyncGenerator<HostFrame>;
  listAdapters(): Promise<HostedAdapterMetadata[]>;
  cancelRun(runId: string): Promise<{ cancelled: boolean }>;
  respondRun(runId: string, response: InteractionResponse): Promise<void>;
  respondNativeRun(runId: string, response: NativeInteractionResponse): Promise<void>;
  subscribeRun(input: {
    runId: string;
    streamId?: string;
    afterSeq?: number;
    signal?: AbortSignal;
  }): AsyncIterable<Record<string, unknown>>;
  startAccount(options: StartAccountOptions): Promise<EmbeddedHealth>;
  reconcileTenants(tenants: readonly AuthorizedTenant[]): Promise<EmbeddedHealth>;
  resetTenant(tenantId: string): Promise<EmbeddedHealth>;
  stop(reason?: "logout" | "account-switch" | "quit" | "reconfigure"): Promise<void>;
  health(): EmbeddedHealth;
  onHealth(listener: (health: EmbeddedHealth) => void): () => void;
}

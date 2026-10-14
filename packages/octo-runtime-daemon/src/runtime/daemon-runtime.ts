import { createInputInvoke } from "@mininglamp-oss/octo-runtime-core";
import { subscribeDaemonRun, invokeDaemonRun } from "./run-stream.js";
import { callDaemon } from "./runtime-contract.js";
import {
  type HostFrame,
  type HostInvokeOptions,
  type NativeInteractionResponse,
  type InvokeRequest,
  type InteractionResponse
} from "@mininglamp-oss/octo-runtime-protocol";
import type { HostedAdapterMetadata } from "@mininglamp-oss/octo-runtime-adapter-host";
import { DaemonRuntimeError, asDaemonRuntimeError } from "./errors.js";
import { ensureLocalRuntime } from "./identity.js";
import {
  accountKeyFor,
  accountPaths,
  acquireOwnerLock,
  daemonHomePaths,
  ensureAccount,
  ensureDaemonHome,
  profileNameFor,
  profilePaths,
  type DaemonAccountPaths,
  type DaemonHomePaths,
  type OwnerLock
} from "./home.js";
import {
  runtimeStatus,
  startManagedDaemon,
  stopManagedDaemon,
  type SupervisedRuntime
} from "./supervisor.js";
import type {
  AuthorizedTenant,
  DaemonRuntime,
  DaemonRuntimeOptions,
  DaemonHealth,
  DaemonProblem,
  ProfileHealth,
  StartAccountOptions
} from "./types.js";

interface ActiveAccount {
  input: StartAccountOptions;
  account: DaemonAccountPaths;
  tenantProfiles: Map<string, string>;
  supervised: SupervisedRuntime;
  signature: string;
}

export class NodeDaemonRuntime implements DaemonRuntime {
  readonly invoke = createInputInvoke((type, request, options) =>
    this.invokeFrames(type, request, options)
  );
  readonly #options: DaemonRuntimeOptions;
  readonly #paths: DaemonHomePaths;
  readonly #listeners = new Set<(health: DaemonHealth) => void>();
  #snapshot: DaemonHealth;
  #generation = 0;
  #queue: Promise<void> = Promise.resolve();
  #active?: ActiveAccount;
  #ownerLock?: OwnerLock;
  #abort?: AbortController;
  #pollTimer?: NodeJS.Timeout;

  constructor(options: DaemonRuntimeOptions) {
    this.#options = options;
    this.#paths = daemonHomePaths(options.home, options.platform);
    this.#snapshot = emptyHealth(this.#paths.home);
  }

  startAccount(options: StartAccountOptions): Promise<DaemonHealth> {
    return this.#enqueue(() => this.#startAccount(options));
  }

  reconcileTenants(tenants: readonly AuthorizedTenant[]): Promise<DaemonHealth> {
    return this.#enqueue(async () => {
      if (!this.#active)
        throw new DaemonRuntimeError(
          "ACCOUNT_NOT_RUNNING",
          "daemon",
          false,
          "no embedded account is active"
        );
      return this.#startAccount({ ...this.#active.input, tenants });
    });
  }

  stop(reason: "logout" | "account-switch" | "quit" | "reconfigure" = "quit"): Promise<void> {
    return this.#enqueue(() => this.#stop(reason));
  }

  health(): DaemonHealth {
    return this.#snapshot;
  }

  startModule(id: string, config: unknown): Promise<unknown> {
    const snapshot = structuredClone(config);
    return this.#enqueue(async () => {
      if (!this.#active) throw new Error("HOST_NOT_RUNNING");
      return callDaemon(this.#active.supervised.paths.socket, {
        method: "module.start",
        params: { id, config: snapshot }
      });
    });
  }

  stopModule(id: string): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.#active) throw new Error("HOST_NOT_RUNNING");
      await callDaemon(this.#active.supervised.paths.socket, {
        method: "module.stop",
        params: { id }
      });
    });
  }

  requestModule<T = unknown>(
    id: string,
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    const snapshot = params ? structuredClone(params) : undefined;
    if (!this.#active) return Promise.reject(new Error("HOST_NOT_RUNNING"));
    return callDaemon<T>(
      this.#active.supervised.paths.socket,
      { method: "module.request", params: { id, method, params: snapshot } },
      60_000
    );
  }

  async *invokeFrames(
    adapterType: string,
    request: InvokeRequest,
    options: HostInvokeOptions = {}
  ): AsyncGenerator<HostFrame> {
    if (!this.#active) throw new Error("HOST_NOT_RUNNING");
    yield* invokeDaemonRun(this.#active.supervised.paths.socket, adapterType, request, options);
  }

  listAdapters(runtimeId?: string): Promise<HostedAdapterMetadata[]> {
    if (!this.#active) return Promise.reject(new Error("HOST_NOT_RUNNING"));
    return callDaemon(this.#active.supervised.paths.socket, {
      method: "adapter.list",
      params: runtimeId ? { runtimeId } : undefined
    });
  }

  cancelRun(runId: string): Promise<{ cancelled: boolean }> {
    if (!this.#active) return Promise.reject(new Error("HOST_NOT_RUNNING"));
    return callDaemon(this.#active.supervised.paths.socket, {
      method: "agent_run.cancel",
      params: { run_id: runId }
    });
  }

  async respondRun(runId: string, response: InteractionResponse): Promise<void> {
    if (!this.#active) throw new Error("HOST_NOT_RUNNING");
    await callDaemon(this.#active.supervised.paths.socket, {
      method: "agent_run.respond",
      params: { run_id: runId, response }
    });
  }
  async respondNativeRun(runId: string, response: NativeInteractionResponse): Promise<void> {
    if (!this.#active) throw new Error("HOST_NOT_RUNNING");
    await callDaemon(this.#active.supervised.paths.socket, {
      method: "agent_run.native.respond",
      params: { run_id: runId, response }
    });
  }

  async *subscribeRun(input: {
    runId: string;
    streamId?: string;
    afterSeq?: number;
    signal?: AbortSignal;
  }): AsyncIterable<Record<string, unknown>> {
    const active = this.#active;
    if (!active) throw new Error("HOST_NOT_RUNNING");
    yield* subscribeDaemonRun(active.supervised.paths.socket, input);
  }

  onHealth(listener: (health: DaemonHealth) => void): () => void {
    this.#listeners.add(listener);
    this.#notify(listener, this.#snapshot);
    return () => this.#listeners.delete(listener);
  }

  async #startAccount(input: StartAccountOptions): Promise<DaemonHealth> {
    const tenants = validateTenants(input.tenants);
    const accountKey = accountKeyFor(input.subject.type, input.subject.id);
    const signature = tenantSignature(accountKey, tenants);
    if (this.#active?.signature === signature) {
      this.#active.input = { ...input, tenants };
      const status = await runtimeStatus(this.#active.supervised);
      if (status?.ready) {
        this.#applyDaemonStatus(status);
        return this.#snapshot;
      }
      await this.#stop("reconfigure");
    }
    if (this.#active) await this.#stop("account-switch");

    const generation = ++this.#generation;
    const abort = new AbortController();
    this.#abort = abort;
    this.#emit({
      ...emptyHealth(this.#paths.home, generation),
      phase: "preparing-home",
      accountKey
    });
    let lock: OwnerLock | undefined;
    try {
      lock = acquireOwnerLock(this.#paths);
      this.#ownerLock = lock;
      const machine = ensureDaemonHome(this.#paths);
      const account = accountPaths(this.#paths, accountKey);
      const tenantProfiles = new Map(
        tenants.map((tenant) => [tenant.id, profileNameFor(this.#options.appId, tenant.id)])
      );
      ensureAccount(account, [...tenantProfiles.values()]);
      this.#emit({
        ...this.#snapshot,
        machineId: machine.machine_id,
        profiles: tenants.map((tenant) => ({
          ...profileHealth(tenant.id, tenantProfiles.get(tenant.id)!, "offline"),
          runtimeId: ensureLocalRuntime(
            profilePaths(account, tenantProfiles.get(tenant.id)!),
            tenant
          ).runtime_id
        })),
        observedAt: Date.now()
      });

      this.#emit({ ...this.#snapshot, phase: "starting", observedAt: Date.now() });
      const started = await startManagedDaemon({
        sdk: this.#options,
        paths: this.#paths,
        account,
        profiles: [...tenantProfiles.values()],
        subject: input.subject,
        nonce: lock.nonce
      });
      this.#active = {
        input: { ...input, tenants },
        account,
        tenantProfiles,
        supervised: started.supervised,
        signature
      };
      started.supervised.child.once("exit", () => {
        if (
          generation !== this.#generation ||
          this.#snapshot.phase === "stopping" ||
          this.#snapshot.phase === "stopped"
        )
          return;
        this.#emitError(
          new DaemonRuntimeError(
            "DAEMON_EXITED",
            "daemon",
            true,
            "embedded runtime exited unexpectedly"
          )
        );
      });
      this.#applyDaemonStatus(started.status);
      this.#pollTimer = setInterval(() => {
        void this.#refreshHealth();
      }, this.#options.healthPollIntervalMs ?? 5_000);
      this.#pollTimer.unref();
      return this.#snapshot;
    } catch (error) {
      abort.abort(error);
      if (!this.#active) {
        lock?.release();
        if (this.#ownerLock === lock) this.#ownerLock = undefined;
      }
      const embeddedError = asDaemonRuntimeError(error, {
        code: "START_FAILED",
        scope: "daemon",
        retryable: true
      });
      this.#emitError(embeddedError);
      throw embeddedError;
    }
  }

  async #stop(reason: "logout" | "account-switch" | "quit" | "reconfigure"): Promise<void> {
    ++this.#generation;
    this.#abort?.abort(new Error(`embedded account stopped: ${reason}`));
    this.#abort = undefined;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
    const active = this.#active;
    this.#emit({ ...this.#snapshot, phase: "stopping", observedAt: Date.now() });
    if (active) await stopManagedDaemon(active.supervised);
    this.#active = undefined;
    this.#ownerLock?.release();
    this.#ownerLock = undefined;
    this.#emit({
      ...emptyHealth(this.#paths.home, this.#generation),
      phase: "stopped"
    });
  }

  async #refreshHealth(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    const status = await runtimeStatus(active.supervised);
    if (!status) {
      this.#emitError(
        new DaemonRuntimeError(
          "DAEMON_UNREACHABLE",
          "daemon",
          true,
          "embedded daemon is not reachable"
        )
      );
      return;
    }
    this.#applyDaemonStatus(status);
  }

  #applyDaemonStatus(status: Awaited<ReturnType<typeof runtimeStatus>> & {}): void {
    const profiles = this.#snapshot.profiles.map((profile) => ({
      ...profile,
      state: status.ready ? ("ready" as const) : ("offline" as const),
      observedAt: Date.now()
    }));
    this.#emit({
      ...this.#snapshot,
      phase: status.ready === true ? "running" : "error",
      local: {
        ready: status.ready === true,
        pid: status.pid,
        adapterHostReady: status.adapterHost?.state === "ready",
        socketReachable: true
      },
      modules: status.modules ?? {},
      extras: status.extras ?? {},
      profiles,
      problem: undefined,
      observedAt: Date.now()
    });
  }

  #emitError(error: DaemonRuntimeError): void {
    const problem: DaemonProblem = {
      code: error.code,
      scope: error.scope,
      retryable: error.retryable,
      message: error.message
    };
    this.#emit({ ...this.#snapshot, phase: "error", problem, observedAt: Date.now() });
  }

  #emit(health: DaemonHealth): void {
    this.#snapshot = health;
    for (const listener of this.#listeners) this.#notify(listener, health);
  }

  #notify(listener: (health: DaemonHealth) => void, health: DaemonHealth): void {
    try {
      listener(health);
    } catch {
      // Consumers cannot break lifecycle progress.
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function emptyHealth(home: string, generation = 0): DaemonHealth {
  return {
    phase: "idle",
    generation,
    home,
    local: { ready: false, adapterHostReady: false, socketReachable: false },
    modules: {},
    profiles: [],
    observedAt: Date.now()
  };
}

function profileHealth(
  tenantId: string,
  profile: string,
  state: ProfileHealth["state"]
): ProfileHealth {
  return { tenantId, profile, state, observedAt: Date.now() };
}

function validateTenants(tenants: readonly AuthorizedTenant[]): AuthorizedTenant[] {
  if (tenants.length === 0)
    throw new DaemonRuntimeError(
      "TENANTS_EMPTY",
      "home",
      false,
      "at least one authorized tenant is required"
    );
  const ids = new Set<string>();
  return tenants.map((tenant) => {
    const id = tenant.id.trim();
    if (!id || ids.has(id))
      throw new DaemonRuntimeError(
        "TENANT_INVALID",
        "home",
        false,
        `tenant id is empty or duplicated: ${id}`
      );
    ids.add(id);
    return { ...tenant, id };
  });
}

function tenantSignature(accountKey: string, tenants: readonly AuthorizedTenant[]): string {
  return JSON.stringify([
    accountKey,
    ...tenants
      .map((tenant) => [tenant.id, tenant.name ?? ""])
      .sort((left, right) => left[0].localeCompare(right[0]))
  ]);
}

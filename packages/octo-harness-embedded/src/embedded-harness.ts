import { randomUUID } from "node:crypto";
import { subscribeDaemonRun, invokeDaemonRun } from "./run-stream.js";
import { callDaemon } from "./runtime-contract.js";
import type { CanonicalEvent, InvokeRequest, InteractionResponse } from "@mininglamp-oss/octo-harness-protocol";
import type { HostedAdapterMetadata } from "@mininglamp-oss/octo-harness-adapter-host";
import { EmbeddedHarnessError, asEmbeddedError } from "./errors.js";
import { ensureTenantEnrollment, resetTenantEnrollment } from "./enrollment.js";
import {
  accountKeyFor,
  accountPaths,
  acquireOwnerLock,
  embeddedHomePaths,
  ensureAccount,
  ensureEmbeddedHome,
  profileNameFor,
  profilePaths,
  type EmbeddedAccountPaths,
  type EmbeddedHomePaths,
  type OwnerLock
} from "./home.js";
import {
  runtimeStatus,
  startEmbeddedRuntime,
  stopEmbeddedRuntime,
  type SupervisedRuntime
} from "./supervisor.js";
import type {
  AuthorizedTenant,
  EmbeddedHarness,
  EmbeddedHarnessOptions,
  EmbeddedHealth,
  EmbeddedProblem,
  ProfileHealth,
  StartAccountOptions
} from "./types.js";

interface ActiveAccount {
  input: StartAccountOptions;
  account: EmbeddedAccountPaths;
  tenantProfiles: Map<string, string>;
  supervised: SupervisedRuntime;
  signature: string;
}

export class NodeEmbeddedHarness implements EmbeddedHarness {
  readonly #options: EmbeddedHarnessOptions;
  readonly #paths: EmbeddedHomePaths;
  readonly #listeners = new Set<(health: EmbeddedHealth) => void>();
  #snapshot: EmbeddedHealth;
  #generation = 0;
  #queue: Promise<void> = Promise.resolve();
  #active?: ActiveAccount;
  #ownerLock?: OwnerLock;
  #abort?: AbortController;
  #pollTimer?: NodeJS.Timeout;

  constructor(options: EmbeddedHarnessOptions) {
    this.#options = options;
    this.#paths = embeddedHomePaths(options.home, options.platform);
    this.#snapshot = emptyHealth(this.#paths.home);
  }

  startAccount(options: StartAccountOptions): Promise<EmbeddedHealth> {
    return this.#enqueue(() => this.#startAccount(options));
  }

  reconcileTenants(tenants: readonly AuthorizedTenant[]): Promise<EmbeddedHealth> {
    return this.#enqueue(async () => {
      if (!this.#active) throw new EmbeddedHarnessError("ACCOUNT_NOT_RUNNING", "daemon", false, "no embedded account is active");
      return this.#startAccount({ ...this.#active.input, tenants });
    });
  }

  resetTenant(tenantId: string): Promise<EmbeddedHealth> {
    return this.#enqueue(async () => {
      const active = this.#active;
      if (!active) throw new EmbeddedHarnessError("ACCOUNT_NOT_RUNNING", "daemon", false, "no embedded account is active");
      const profile = active.tenantProfiles.get(tenantId);
      if (!profile) throw new EmbeddedHarnessError("TENANT_NOT_ACTIVE", "profile", false, `tenant is not active: ${tenantId}`);
      const input = active.input;
      const account = active.account;
      await this.#stop("reconfigure");
      resetTenantEnrollment(profilePaths(account, profile));
      return this.#startAccount(input);
    });
  }

  stop(reason: "logout" | "account-switch" | "quit" | "reconfigure" = "quit"): Promise<void> {
    return this.#enqueue(() => this.#stop(reason));
  }

  health(): EmbeddedHealth {
    return this.#snapshot;
  }

  async *invoke(adapterType: string, request: InvokeRequest): AsyncIterable<CanonicalEvent> {
    if (!this.#active) throw new Error("HOST_NOT_RUNNING");
    yield* invokeDaemonRun(this.#active.supervised.paths.socket, adapterType, request);
  }

  listAdapters(): Promise<HostedAdapterMetadata[]> {
    if (!this.#active) return Promise.reject(new Error("HOST_NOT_RUNNING"));
    return callDaemon(this.#active.supervised.paths.socket, { method: "adapter.list" });
  }

  cancelRun(runId: string): Promise<{ cancelled: boolean }> {
    if (!this.#active) return Promise.reject(new Error("HOST_NOT_RUNNING"));
    return callDaemon(this.#active.supervised.paths.socket, { method: "agent_run.cancel", params: { run_id: runId } });
  }

  async respondRun(runId: string, response: InteractionResponse): Promise<void> {
    if (!this.#active) throw new Error("HOST_NOT_RUNNING");
    await callDaemon(this.#active.supervised.paths.socket, { method: "agent_run.respond", params: { run_id: runId, response } });
  }

  async *subscribeRun(input: { runId: string; streamId?: string; afterSeq?: number; signal?: AbortSignal }): AsyncIterable<Record<string, unknown>> {
    const active=this.#active;
    if (!active) throw new Error("HOST_NOT_RUNNING");
    yield* subscribeDaemonRun(active.supervised.paths.socket,input);
  }

  onHealth(listener: (health: EmbeddedHealth) => void): () => void {
    this.#listeners.add(listener);
    this.#notify(listener, this.#snapshot);
    return () => this.#listeners.delete(listener);
  }

  async #startAccount(input: StartAccountOptions): Promise<EmbeddedHealth> {
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
      const machine = ensureEmbeddedHome(this.#paths);
      const account = accountPaths(this.#paths, accountKey);
      const tenantProfiles = new Map(tenants.map(tenant => [tenant.id, profileNameFor(this.#options.appId, tenant.id)]));
      ensureAccount(account, [...tenantProfiles.values()]);
      this.#emit({
        ...this.#snapshot,
        machineId: machine.machine_id,
        profiles: tenants.map(tenant => profileHealth(tenant.id, tenantProfiles.get(tenant.id)!, "pending")),
        cloud: { totalProfiles: tenants.length, connectedProfiles: 0, allConnected: false },
        observedAt: Date.now()
      });

      const successful: string[] = [];
      let firstEnrollmentError: EmbeddedHarnessError | undefined;
      for (const tenant of tenants) {
        if (abort.signal.aborted || generation !== this.#generation) throw abort.signal.reason;
        const profile = tenantProfiles.get(tenant.id)!;
        this.#patchProfile(tenant.id, { state: "enrolling", observedAt: Date.now() });
        this.#emit({ ...this.#snapshot, phase: "enrolling", observedAt: Date.now() });
        try {
          const enrolled = await ensureTenantEnrollment({
            subject: input.subject,
            tenant,
            profile: profilePaths(account, profile),
            machine,
            getHumanToken: input.getHumanToken,
            fetchImplementation: this.#options.fetchImplementation,
            signal: abort.signal
          });
          successful.push(profile);
          this.#patchProfile(tenant.id, {
            runtimeId: enrolled.runtimeId,
            state: "connecting",
            reasonCode: undefined,
            observedAt: Date.now()
          });
        } catch (error) {
          const embeddedError = asEmbeddedError(error, { code: "ENROLLMENT_FAILED", scope: "enrollment", retryable: true });
          firstEnrollmentError ??= embeddedError;
          this.#patchProfile(tenant.id, {
            state: embeddedError.code === "AUTH_REJECTED" ? "unauthorized" : "error",
            reasonCode: embeddedError.code,
            observedAt: Date.now()
          });
          this.#emit({
            ...this.#snapshot,
            problem: {
              code: embeddedError.code,
              scope: embeddedError.scope,
              retryable: embeddedError.retryable,
              profile,
              message: embeddedError.message
            },
            observedAt: Date.now()
          });
        }
      }
      if (successful.length === 0) throw firstEnrollmentError ?? new EmbeddedHarnessError("NO_PROFILES", "enrollment", false, "no tenant profile could be enrolled");
      ensureAccount(account, successful);
      this.#emit({ ...this.#snapshot, phase: "starting", observedAt: Date.now() });
      const started = await startEmbeddedRuntime({
        sdk: this.#options,
        paths: this.#paths,
        account,
        profiles: successful,
        nonce: lock.nonce
      });
      this.#active = { input: { ...input, tenants }, account, tenantProfiles, supervised: started.supervised, signature };
      started.supervised.child.once("exit", () => {
        if (generation !== this.#generation || this.#snapshot.phase === "stopping" || this.#snapshot.phase === "stopped") return;
        this.#emitError(new EmbeddedHarnessError("DAEMON_EXITED", "daemon", true, "embedded runtime exited unexpectedly"));
      });
      this.#applyDaemonStatus(started.status);
      this.#pollTimer = setInterval(() => { void this.#refreshHealth(); }, this.#options.healthPollIntervalMs ?? 5_000);
      this.#pollTimer.unref();
      return this.#snapshot;
    } catch (error) {
      abort.abort(error);
      if (!this.#active) {
        lock?.release();
        if (this.#ownerLock === lock) this.#ownerLock = undefined;
      }
      const embeddedError = asEmbeddedError(error, { code: "START_FAILED", scope: "daemon", retryable: true });
      this.#emitError(embeddedError);
      throw embeddedError;
    }
  }

  async #stop(_reason: "logout" | "account-switch" | "quit" | "reconfigure"): Promise<void> {
    ++this.#generation;
    this.#abort?.abort(new Error("embedded account stopped"));
    this.#abort = undefined;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
    const active = this.#active;
    this.#emit({ ...this.#snapshot, phase: "stopping", observedAt: Date.now() });
    if (active) await stopEmbeddedRuntime(active.supervised);
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
      this.#emitError(new EmbeddedHarnessError("DAEMON_UNREACHABLE", "daemon", true, "embedded daemon is not reachable"));
      return;
    }
    this.#applyDaemonStatus(status);
  }

  #applyDaemonStatus(status: Awaited<ReturnType<typeof runtimeStatus>> & {}): void {
    const runtimes = status.agentWork?.runtimes ?? [];
    let connected = 0;
    const profiles = this.#snapshot.profiles.map(profile => {
      const runtime = runtimes.find(item => item.profile === profile.profile || item.runtimeId === profile.runtimeId);
      if (runtime?.connected) connected += 1;
      if (profile.state === "error" || profile.state === "unauthorized") return profile;
      return {
        ...profile,
        state: runtime?.connected ? "online" as const : "offline" as const,
        reasonCode: runtime?.error ? "RUNTIME_CONNECTION_FAILED" : undefined,
        observedAt: Date.now()
      };
    });
    const allConnected = profiles.length > 0 && connected === profiles.length;
    const hasProfileFailure = profiles.some(profile => profile.state === "error" || profile.state === "unauthorized");
    this.#emit({
      ...this.#snapshot,
      phase: allConnected && !hasProfileFailure ? "running" : "degraded",
      local: {
        ready: status.ready === true,
        pid: status.pid,
        adapterHostReady: status.adapterHost?.state === "ready",
        socketReachable: true
      },
      cloud: {
        totalProfiles: profiles.length,
        connectedProfiles: connected,
        allConnected
      },
      profiles,
      problem: hasProfileFailure ? this.#snapshot.problem : undefined,
      observedAt: Date.now()
    });
  }

  #patchProfile(tenantId: string, patch: Partial<ProfileHealth>): void {
    this.#emit({
      ...this.#snapshot,
      profiles: this.#snapshot.profiles.map(profile => profile.tenantId === tenantId ? { ...profile, ...patch } : profile),
      observedAt: Date.now()
    });
  }

  #emitError(error: EmbeddedHarnessError): void {
    const problem: EmbeddedProblem = {
      code: error.code,
      scope: error.scope,
      retryable: error.retryable,
      message: error.message
    };
    this.#emit({ ...this.#snapshot, phase: "error", problem, observedAt: Date.now() });
  }

  #emit(health: EmbeddedHealth): void {
    this.#snapshot = health;
    for (const listener of this.#listeners) this.#notify(listener, health);
  }

  #notify(listener: (health: EmbeddedHealth) => void, health: EmbeddedHealth): void {
    try {
      listener(health);
    } catch {
      // Consumers cannot break lifecycle progress.
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function emptyHealth(home: string, generation = 0): EmbeddedHealth {
  return {
    phase: "idle",
    generation,
    home,
    local: { ready: false, adapterHostReady: false, socketReachable: false },
    cloud: { totalProfiles: 0, connectedProfiles: 0, allConnected: false },
    profiles: [],
    observedAt: Date.now()
  };
}

function profileHealth(tenantId: string, profile: string, state: ProfileHealth["state"]): ProfileHealth {
  return { tenantId, profile, state, observedAt: Date.now() };
}

function validateTenants(tenants: readonly AuthorizedTenant[]): AuthorizedTenant[] {
  if (tenants.length === 0) throw new EmbeddedHarnessError("TENANTS_EMPTY", "home", false, "at least one authorized tenant is required");
  const ids = new Set<string>();
  return tenants.map(tenant => {
    const id = tenant.id.trim();
    if (!id || ids.has(id)) throw new EmbeddedHarnessError("TENANT_INVALID", "home", false, `tenant id is empty or duplicated: ${id}`);
    ids.add(id);
    return { ...tenant, id };
  });
}

function tenantSignature(accountKey: string, tenants: readonly AuthorizedTenant[]): string {
  return JSON.stringify([accountKey, ...tenants
    .map(tenant => [tenant.id, tenant.serverUrl, tenant.agentWorkUrl, JSON.stringify(tenant.businessServiceBindings)])
    .sort((left, right) => left[0].localeCompare(right[0]))]);
}

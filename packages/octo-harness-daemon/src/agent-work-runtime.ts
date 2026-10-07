import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, statfs } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname } from "node:path";
import WebSocket from "ws";
import type { AdapterHostRpc, HostedAdapterMetadata } from "@mininglamp-oss/octo-harness-adapter-host";
import {
  REQUEST_ID_HEADER,
  createRequestId,
  responseRequestId,
  type LocalObservability,
  type LogInput
} from "@mininglamp-oss/octo-harness-observability";
import type {
  AgentConfig,
  CanonicalEvent,
  ChannelContextDescriptor,
  ContextEnvelope,
  ContextSyncRequest,
  ContextSyncResult,
  InteractionResponse,
  InvokeRequest,
  McpServers,
  ProviderSession,
  ResolvedExecutionPlan,
  ResolvedRuntimeSelection
} from "@mininglamp-oss/octo-harness-protocol";
import {
  RUNTIME_RUN_CONTRACT,
  assertChannelContextAppend,
  assertChannelContextDescriptor,
  assertContextSyncResult,
  assertInteractionResponse,
  assertMcpServers,
  assertContextEnvelope,
  assertResolvedExecutionPlan,
  assertResolvedRuntimeSelection,
  contextItem,
  failurePayload,
  modelPartsFromInput
} from "@mininglamp-oss/octo-harness-protocol";
import { resolveRuntimeInputImages } from "./input-images.js";
import { AgentWorkStore } from "./agent-work-store.js";
import { assertFrozenContextPlan, compileRunContext } from "./run-context.js";
import { prepareTaskMaterials, type PreparedTaskMaterials } from "./task-materials.js";
import type { OutboxRow } from "./agent-work-store.js";
import { collectRuntimeDeviceInfo } from "./device-info.js";
import {
  ChannelContextStore,
  ChannelContextConsumerBusyError,
  ChannelContextStaleGenerationError,
  channelScopeKey,
  composeProviderModelInput,
  type ChannelContextStoreOptions,
  type PreparedChannelContextSnapshot
} from "./channel-context-store.js";

const MIN_PROTOCOL_VERSION = 2;
const MAX_PROTOCOL_VERSION = 2;
const RUNTIME_VERSION = packageVersion();
const DEFAULT_SEND_WINDOW = 32;
export const DEFAULT_MAX_CONCURRENT_RUNS = 3;
const DEFAULT_SOFT_WATERMARK_BYTES = 512 * 1024 * 1024;
const DEFAULT_HARD_WATERMARK_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_RECONNECT_FIRST_MS = 1_000;
const DEFAULT_RECONNECT_MIN_MS = 20_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;
const MAX_SERVER_RECONNECT_JITTER_MS = 20_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_RECEIVE_TIMEOUT_MS = 60_000;
const DEFAULT_RECOVERY_PROBE_MS = 5_000;
const DEFAULT_RECOVERY_JITTER_MAX_MS = 2_000;
const DEFAULT_CREDENTIAL_FAILURE_LIMIT = 3;
const RECONNECT_STABLE_RESET_MS = 5 * 60_000;
const DEFAULT_RECONCILE_MS = 5 * 60_000;
const DEFAULT_MINIMUM_FREE_BYTES = 512 * 1024 * 1024;
const DEFAULT_DISK_CHECK_MS = 30_000;
const PUMP_POLL_MS = 50;
const DEFAULT_NACK_RETRY_MS = 1_000;
const MAX_NACK_RETRY_MS = 30_000;
const BACKPRESSURE_POLL_MS = 100;
const DEFAULT_CONTEXT_SYNC_TIMEOUT_MS = 3_000;
const DEFAULT_CONTEXT_SYNC_LIMIT = 40;
const CONTEXT_BUSY_POLL_MS = 25;
/** Terminal events must be able to reach durable storage and close out the run;
 * they bypass the soft-watermark backpressure. */
const TERMINAL_OUTBOX_TYPES = new Set(["run.completed", "run.failed", "run.cancelled"]);

/**
 * Configuration for the optional bridge between a local adapter host and the
 * Agent Work control plane. Authentication values are transport inputs only and
 * must never be copied into observability records.
 */
export interface AgentWorkRuntimeOptions {
  /** Trusted local profile label; never used as an authorization claim. */
  profile: string;
  baseUrl: string;
  token: string;
  runtimeId?: string;
  runtimeName: string;
  /** Profile-local adapter configuration. Secrets never come from AgentRevision or service argv. */
  adapterConfigurations?: Record<string, {
    providerAgentId?: string;
    providerOptions: Record<string, string>;
  }>;
  /** Delay before the first reconnect attempt after a connected socket drops. */
  reconnectFirstMs?: number;
  /** Full-jitter backoff floor used from the second reconnect attempt onward. */
  reconnectMs?: number;
  /** Full-jitter backoff ceiling used from the second reconnect attempt onward. */
  reconnectMaxMs?: number;
  /** Maximum time to complete one WebSocket handshake. */
  connectTimeoutMs?: number;
  /** Maximum silence from the server before terminating and reconnecting. */
  receiveTimeoutMs?: number;
  /** Interval used to detect system resume, wall-clock corrections and local network-address changes. */
  recoveryProbeMs?: number;
  /** Maximum full jitter applied to a resume/network-change fast reconnect. */
  recoveryJitterMaxMs?: number;
  /** Consecutive 401/403 registrations allowed before operator action is required. */
  credentialFailureLimit?: number;
  /** Local outbox database path; defaults are resolved by the daemon. */
  storePath: string;
  /** Refuse new Runs below this filesystem free-space threshold. */
  minimumFreeBytes?: number;
  /** Interval for detecting disk-space recovery without a daemon restart. */
  diskCheckMs?: number;
  /** Max number of events allowed in flight (unacked) per send window. */
  sendWindow?: number;
  /** Soft watermark: once reached, stop admitting new Runs and pause provider
   * reads to form backpressure. */
  softWatermarkBytes?: number;
  /** Hard watermark: reject new Runs and emit a high-priority error; unacked
   * data is never deleted to recover capacity. */
  hardWatermarkBytes?: number;
  /** Maximum provider invocations admitted concurrently on this device. */
  maxConcurrentRuns?: number;
  reconcileMs?: number;
  channelContext?: ChannelContextRuntimeOptions;
}

export type RuntimeConnectionState =
  | "stopped"
  | "starting"
  | "registering"
  | "connecting"
  | "awaiting_welcome"
  | "online"
  | "backing_off"
  | "action_required";

export type RuntimeConnectionReason =
  | "none"
  | "transport"
  | "receive_timeout"
  | "dns"
  | "tls"
  | "auth"
  | "server_goaway"
  | "network_change"
  | "system_resume"
  | "clock_change";

type RuntimeRecoveryTrigger = "transport" | "server_goaway" | "network_change" | "system_resume" | "clock_change";

export type RuntimeStoreHealthState =
  | "healthy"
  | "low_disk"
  | "full"
  | "corrupt_quarantined"
  | "migration_failed";

interface RuntimeStoreHealth {
  state: RuntimeStoreHealthState;
  acceptingNewRuns: boolean;
  freeBytes: number;
  minimumFreeBytes: number;
  errorCode?: string;
}

export interface RunAdmission {
  acquire(signal: AbortSignal): Promise<() => void>;
}

/** Controls local persistence and projection of channel context presented to a provider. */
export interface ChannelContextRuntimeOptions extends ChannelContextStoreOptions {
  store: "memory" | "sqlite";
  projection: "window" | "delta";
  providerPersistence: "ephemeral" | "append_only";
  storePath: string;
  syncTimeoutMs?: number;
}

/** Immutable execution description received from Agent Work before local mapping. */
export interface ExecutionEnvelope {
  schema_version: 3;
  effective_context: ContextEnvelope;
  context_defaults_version: number;
  resolved_execution_plan: ResolvedExecutionPlan;
  resolved_runtime_selection: ResolvedRuntimeSelection;
  run_id: string;
  agent_session_id: string;
  session_generation?: number;
  provider_epoch?: number;
  continuity_mode?: "continue" | "fresh";
  provider_session?: ProviderSession;
  agent_run_request: {
    namespace: string;
    agent_id: string;
    agent_revision_id: string;
    session_key: string;
    trigger: { kind: string; occurrence_id: string; occurred_at?: string };
    input: Record<string, unknown>;
    context: ContextEnvelope;
    execution_policy?: Record<string, unknown>;
    trace?: Record<string, unknown>;
    session_policy?: {
      mode: "continue" | "fresh";
      expected_generation?: number;
      cancel_active?: boolean;
      admission?: "queue_after_active" | "reject_if_active";
    };
  };
  agent_revision: {
    definition?: Record<string, unknown>;
    execution_spec?: Record<string, unknown>;
    execution_profile?: Record<string, unknown>;
  };
}

export type AgentWorkExecutionEnvelope = ExecutionEnvelope;

interface RuntimeCommand {
  server_seq: number;
  command_id: string;
  run_id: string;
  type: "run.start" | "run.cancel" | "run.steer" | "interaction.respond";
  payload: unknown;
  lease_id: string;
  fencing_token: number;
}

interface WireEnvelope {
  version: number;
  id: string;
  type: string;
  runtime_id?: string;
  seq?: number;
  ack?: number;
  sent_at: string;
  payload: unknown;
}

interface ActiveRun {
  invocationId: string;
  leaseId: string;
  fencingToken: number;
}

interface AcceptingRun {
  commandId: string;
  serverSeq: number;
  controller: AbortController;
  acknowledged: boolean;
}

interface PendingContextSync {
  scopeKey: string;
  triggerMessageId: string;
  triggerSeq?: number;
  afterSeq?: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * The local Agent Work runtime: registers with the control plane, holds a
 * WebSocket for commands, executes accepted Runs through the adapter host, and
 * ships their events out of the durable outbox with cumulative ACK semantics.
 *
 * Durability contract: each event is written to the SQLite outbox before it is
 * sent; a cumulative `event.ack{run_id, seq}` first releases the send window
 * (received) and then, on the durable ACK, deletes confirmed rows. Unacked events
 * survive restart and replay with a stable event_id. Channel-context commits are
 * gated on the successful terminal's durable ACK.
 */
export class AgentWorkRuntime {
  readonly #options: AgentWorkRuntimeOptions;
  readonly #host: AdapterHostRpc;
  // Observability is optional so the reusable runtime preserves compatibility
  // with existing embedders. When present, it replaces routine stderr output.
  readonly #observability?: LocalObservability;
  readonly #runAdmission?: RunAdmission;
  readonly #activeRuns = new Map<string, ActiveRun>();
  readonly #acceptingCommandIds = new Set<string>();
  readonly #acceptingRuns = new Map<string, AcceptingRun>();
  readonly #authoritativeTerminalRuns = new Set<string>();
  readonly #messageHandlers = new Set<Promise<void>>();
  readonly #executionTasks = new Set<Promise<void>>();
  readonly #adapterCapabilities = new Map<string, Set<string>>();
  #adapters: HostedAdapterMetadata[] = [];
  /** `${runId}:${seq}` already sent on this connection and awaiting ACK; cleared
   * on reconnect so the sender replays them. */
  readonly #inFlight = new Set<string>();
  readonly #nackBackoff = new Map<string, { attempt: number; retryAt: number }>();
  readonly #pendingContextSyncs = new Map<string, PendingContextSync>();
  readonly #latestContextSyncByScope = new Map<string, string>();
  #store?: AgentWorkStore;
  #contextStore?: ChannelContextStore;
  #runtimeId = "";
  #socket?: WebSocket;
  #connectingSocket?: WebSocket;
  #heartbeat?: NodeJS.Timeout;
  #reconcileTimer?: NodeJS.Timeout;
  #diskTimer?: NodeJS.Timeout;
  #loop?: Promise<void>;
  #pump?: Promise<void>;
  #senderKick?: () => void;
  #stopped = true;
  #draining = false;
  #connected = false;
  #lifecycleEpoch = 0;
  // Attempts are process-lifetime diagnostics; connection ids identify one
  // concrete WSS session and are reset whenever that session closes.
  #connectionAttempt = 0;
  #consecutiveReconnects = 0;
  #reconnectReset?: NodeJS.Timeout;
  #reconnectAbort?: AbortController;
  #recoveryProbe?: NodeJS.Timeout;
  #lastRecoveryProbeAt = 0;
  #lastRecoveryProbeMonotonicAt = 0;
  #networkFingerprint = "";
  #fastRecoveryReason?: "network_change" | "system_resume" | "clock_change";
  #serverReconnectAfterMs?: number;
  #serverReconnectProtected = false;
  #connectionState: RuntimeConnectionState = "stopped";
  #connectionReason: RuntimeConnectionReason = "none";
  #recoveryStartedAt?: number;
  #recoveryTrigger?: RuntimeRecoveryTrigger;
  #lastRecoveryDurationMs?: number;
  #lastRecoveryTrigger?: RuntimeRecoveryTrigger;
  #credentialFailures = 0;
  #protocolVersion = MAX_PROTOCOL_VERSION;
  #connectionId?: string;
  #storeQuarantined = false;
  #storeHealth: RuntimeStoreHealth;

  constructor(
    options: AgentWorkRuntimeOptions,
    host: AdapterHostRpc,
    observability?: LocalObservability,
    runAdmission?: RunAdmission
  ) {
    if (typeof options.profile !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.profile)) {
      throw new Error("Agent Work Runtime requires a valid Harness profile of 1-128 characters");
    }
    this.#options = options;
    this.#host = host;
    this.#observability = observability;
    this.#runAdmission = runAdmission;
    const minimumFreeBytes = options.minimumFreeBytes ?? DEFAULT_MINIMUM_FREE_BYTES;
    if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes < 0) {
      throw new Error("minimumFreeBytes must be a non-negative safe integer");
    }
    const diskCheckMs = options.diskCheckMs ?? DEFAULT_DISK_CHECK_MS;
    if (!Number.isFinite(diskCheckMs) || diskCheckMs < 100) {
      throw new Error("diskCheckMs must be finite and at least 100ms");
    }
    this.#storeHealth = {
      state: "healthy",
      acceptingNewRuns: false,
      freeBytes: 0,
      minimumFreeBytes
    };
    if ((options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS) < 1) {
      throw new Error("maxConcurrentRuns must be positive");
    }
    if ((options.reconnectFirstMs ?? DEFAULT_RECONNECT_FIRST_MS) < 1) {
      throw new Error("reconnectFirstMs must be positive");
    }
    if ((options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS) < (options.reconnectMs ?? DEFAULT_RECONNECT_MIN_MS)) {
      throw new Error("reconnectMaxMs must not be below reconnectMs");
    }
    if ((options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS) < 1) {
      throw new Error("connectTimeoutMs must be positive");
    }
    const receiveTimeoutMs = options.receiveTimeoutMs ?? DEFAULT_RECEIVE_TIMEOUT_MS;
    if (!Number.isFinite(receiveTimeoutMs) || receiveTimeoutMs < 1) {
      throw new Error("receiveTimeoutMs must be finite and positive");
    }
    const recoveryProbeMs = options.recoveryProbeMs ?? DEFAULT_RECOVERY_PROBE_MS;
    if (!Number.isFinite(recoveryProbeMs) || recoveryProbeMs < 100) {
      throw new Error("recoveryProbeMs must be finite and at least 100ms");
    }
    const recoveryJitterMaxMs = options.recoveryJitterMaxMs ?? DEFAULT_RECOVERY_JITTER_MAX_MS;
    if (!Number.isFinite(recoveryJitterMaxMs) || recoveryJitterMaxMs < 1) {
      throw new Error("recoveryJitterMaxMs must be finite and positive");
    }
    const credentialFailureLimit = options.credentialFailureLimit ?? DEFAULT_CREDENTIAL_FAILURE_LIMIT;
    if (!Number.isSafeInteger(credentialFailureLimit) || credentialFailureLimit < 1 || credentialFailureLimit > 100) {
      throw new Error("credentialFailureLimit must be an integer between 1 and 100");
    }
  }

  /** Return operational state only. Endpoint credentials and message content are excluded. */
  get status(): Record<string, unknown> {
    const store = this.#store;
    const contextStats = this.#contextStore?.stats();
    return {
      enabled: true,
      ...(this.#options.profile ? { profile: this.#options.profile } : {}),
      connected: this.#connected,
      connectionState: this.#connectionState,
      connectionReason: this.#connectionReason,
      lastRecoveryDurationMs: this.#lastRecoveryDurationMs ?? null,
      lastRecoveryTrigger: this.#lastRecoveryTrigger ?? null,
      actionRequired: this.#connectionState === "action_required",
      draining: this.#draining,
      runtimeId: this.#runtimeId || this.#options.runtimeId,
      activeRuns: this.#activeRuns.size,
      acceptingRuns: this.#acceptingRuns.size,
      maxConcurrentRuns: this.#options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS,
      runtimeVersion: RUNTIME_VERSION,
      protocolVersion: this.#protocolVersion,
      lastAckedCommandSeq: store?.lastAckedCommandSeq ?? 0,
      outboxPendingBytes: store?.outboxBytes() ?? 0,
      outboxPending: store?.pendingCount() ?? 0,
      outboxOldestAgeMs: store?.oldestUnackedAgeMs() ?? null,
      dbBytes: store?.dbBytes() ?? 0,
      walBytes: store?.walBytes() ?? 0,
      storeHealth: {
        state: this.#storeHealth.state,
        acceptingNewRuns: this.#storeHealth.acceptingNewRuns,
        freeBytes: this.#storeHealth.freeBytes,
        minimumFreeBytes: this.#storeHealth.minimumFreeBytes,
        errorCode: this.#storeHealth.errorCode ?? null
      },
      channelContext: {
        store: this.#options.channelContext?.store ?? "memory",
        projection: this.#options.channelContext?.projection ?? "window",
        providerPersistence: this.#options.channelContext?.providerPersistence ?? "append_only",
        scopes: contextStats?.scopes ?? 0,
        messages: contextStats?.messages ?? 0,
        snapshots: contextStats?.snapshots ?? 0,
        activeSnapshots: contextStats?.activeSnapshots ?? 0,
        serializerVersion: contextStats?.serializerVersion ?? null,
        retentionMs: contextStats?.retentionMs ?? null,
        snapshotRetentionMs: contextStats?.snapshotRetentionMs ?? null,
        activeSnapshotTimeoutMs: contextStats?.activeSnapshotTimeoutMs ?? null,
        dbBytes: contextStats?.dbBytes ?? 0,
        walBytes: contextStats?.walBytes ?? 0
      }
    };
  }

  /** Open durable stores, refresh Runtime capabilities and validate identity,
   * then start the receive and outbox loops. */
  async start(): Promise<void> {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#draining = false;
    this.#connectionState = "starting";
    this.#credentialFailures = 0;
    this.#serverReconnectProtected = false;
    const epoch = ++this.#lifecycleEpoch;
    this.#adapterCapabilities.clear();
    const adapters = await this.#host.list();
    this.#adapters = adapters;
    for (const adapter of adapters) {
      this.#adapterCapabilities.set(adapter.type, new Set(adapter.capabilities ?? []));
    }
    await this.#openStore();
    if (this.#options.channelContext?.store === "sqlite") {
      this.#contextStore = ChannelContextStore.open(
        this.#options.channelContext.storePath,
        this.#options.channelContext
      );
    }
    this.#startRecoveryProbe(epoch);
    this.#startDiskProbe(epoch);
    try {
      await this.#registerAndConnect(epoch);
    } catch (error) {
      this.#connectionReason = connectionFailureReason(error);
      if (error instanceof RuntimeIdentityMismatchError) throw error;
      if (error instanceof RuntimeCredentialRejectedError
        && error.attempt >= (this.#options.credentialFailureLimit ?? DEFAULT_CREDENTIAL_FAILURE_LIMIT)) {
        this.#connectionState = "action_required";
        this.#connectionReason = "auth";
        this.#reportError(
          "agent_work.registration.action_required",
          "Agent Work runtime credential requires operator action",
          error,
          { http_status: error.status, consecutive_failures: error.attempt }
        );
      }
      this.#reportError("transport.connection.initial_failed", "initial Agent Work connection failed", error);
    }
    this.#loop = this.#connectionState === "action_required" ? Promise.resolve() : this.#readLoop(epoch);
    this.#pump = this.#senderLoop(epoch);
    const reconcileMs = this.#options.reconcileMs ?? DEFAULT_RECONCILE_MS;
    this.#reconcileTimer = setInterval(() => {
      try {
        this.#store?.reconcile();
        const protectedRunIds = new Set([
          ...(this.#store?.pendingTerminalAckRunIds() ?? []),
          ...this.#activeRuns.keys(),
          ...this.#acceptingRuns.keys()
        ]);
        this.#contextStore?.reconcile(Date.now(), protectedRunIds);
      } catch (error) {
        this.#markStoreUnavailable(error);
        this.#reportError("agent_work.outbox.reconcile_failed", "Agent Work outbox reconcile failed", error);
      }
    }, reconcileMs);
  }

  /**
   * Stop accepting work, cancel local invocations and close transports/stores.
   * Durable, unacknowledged outbox rows are intentionally retained for replay.
   */
  async close(): Promise<void> {
    if (this.#stopped && !this.#store) return;
    this.#stopped = true;
    this.#draining = true;
    this.#connectionState = "stopped";
    this.#lifecycleEpoch += 1;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    if (this.#reconnectReset) clearTimeout(this.#reconnectReset);
    this.#reconnectReset = undefined;
    this.#reconnectAbort?.abort(new RuntimeStoppingError());
    this.#reconnectAbort = undefined;
    if (this.#recoveryProbe) clearInterval(this.#recoveryProbe);
    this.#recoveryProbe = undefined;
    if (this.#diskTimer) clearInterval(this.#diskTimer);
    this.#diskTimer = undefined;
    this.#connectingSocket?.terminate();
    this.#connectingSocket = undefined;
    if (this.#reconcileTimer) clearInterval(this.#reconcileTimer);
    this.#reconcileTimer = undefined;
    this.#kickSender();
    for (const accepting of this.#acceptingRuns.values()) {
      accepting.controller.abort(new RuntimeStoppingError());
    }
    for (const run of this.#activeRuns.values()) {
      await this.#host.cancel(run.invocationId, "runtime shutdown").catch(() => undefined);
    }
    this.#socket?.close(1000, "runtime shutdown");
    for (const requestId of [...this.#pendingContextSyncs.keys()]) {
      this.#resolveContextSync(requestId, new RuntimeStoppingError());
    }
    this.#latestContextSyncByScope.clear();
    await this.#loop?.catch(() => undefined);
    await this.#pump?.catch(() => undefined);
    await Promise.allSettled([...this.#messageHandlers]);
    await Promise.allSettled([...this.#executionTasks]);
    // Unacked events stay in the outbox and replay after restart; here we only
    // release the connection and handles.
    this.#store?.close();
    this.#store = undefined;
    this.#contextStore?.close();
    this.#contextStore = undefined;
    this.#acceptingCommandIds.clear();
    this.#acceptingRuns.clear();
    this.#authoritativeTerminalRuns.clear();
  }

  /** Reject future run.start commands while allowing cancellation and replay. */
  beginDrain(): void {
    this.#draining = true;
  }

  /** Host applications can call this from native resume/network callbacks. The
   * runtime also performs a portable event-loop and interface-address probe. */
  notifyConnectivityChanged(reason: "network_change" | "system_resume" = "network_change"): void {
    this.#requestFastRecovery(reason);
  }

  async waitForDrained(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.#acceptingRuns.size > 0 || this.#activeRuns.size > 0) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Agent Work drain timed out with ${this.#acceptingRuns.size} accepting and ${this.#activeRuns.size} active Runs`
        );
      }
      await delay(BACKPRESSURE_POLL_MS);
    }
  }

  async #register(adapterTypes: string[], signal?: AbortSignal): Promise<{ runtimeId: string; protocolVersion: number }> {
    this.#connectionState = "registering";
    const contextStats = this.#contextStore?.stats();
    const sentRequestId = createRequestId();
    this.#log({
      level: "info",
      scope: "agent-work.registration",
      event: "agent_work.registration.started",
      message: "registering local Agent Work runtime",
      requestId: sentRequestId,
      data: { endpoint: httpEndpointMetadata(this.#options.baseUrl), adapter_types: adapterTypes }
    });
    let response: Response;
    try {
      response = await fetch(`${stripSlash(this.#options.baseUrl)}/v1/runtime/register`, {
        method: "POST",
        headers: this.#headers(true, sentRequestId),
        body: JSON.stringify({
          profile: this.#options.profile,
          name: this.#options.runtimeName,
          device: collectRuntimeDeviceInfo(),
          runtime_version: RUNTIME_VERSION,
          protocol_version: MAX_PROTOCOL_VERSION,
          protocol_version_min: MIN_PROTOCOL_VERSION,
          protocol_version_max: MAX_PROTOCOL_VERSION,
          capabilities: {
            run_contract: RUNTIME_RUN_CONTRACT,
            adapters: this.#adapters.map(adapter => ({
              provider_type: adapter.type,
              provider_version: adapter.providerVersion ?? null,
              provider_path: adapter.providerPath ?? null,
              available: adapter.available === true,
              unavailable_reason: adapter.available === true ? null : adapter.unavailableReason ?? "probe_missing",
              capabilities: adapter.capabilities,
              ...(adapter.processModel ? { process_model: adapter.processModel } : {}),
              ...(adapter.transport ? { transport: adapter.transport } : {})
            })),
            channel_context: {
              protocol_version: 1,
              store: this.#options.channelContext?.store ?? "memory",
              projection: this.#options.channelContext?.projection ?? "window",
              provider_persistence: this.#options.channelContext?.providerPersistence ?? "append_only",
              ...(contextStats ? {
                serializer_version: contextStats.serializerVersion,
                message_retention_ms: contextStats.retentionMs,
                snapshot_retention_ms: contextStats.snapshotRetentionMs,
                active_snapshot_timeout_ms: contextStats.activeSnapshotTimeoutMs
              } : {})
            }
          }
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
      });
    } catch (error) {
      this.#log({
        level: "error",
        scope: "agent-work.registration",
        event: "agent_work.registration.failed",
        message: "Agent Work runtime registration request failed",
        requestId: sentRequestId,
        data: { endpoint: httpEndpointMetadata(this.#options.baseUrl), error: errorMessage(error) }
      });
      throw error;
    }
    const requestId = responseRequestId(response, sentRequestId);
    let body: {
      runtime?: { id?: string; profile?: string; protocol_version?: number };
      error?: { message?: string; code?: string; details?: { reason_code?: string } };
    };
    try {
      body = await response.json() as typeof body;
    } catch (error) {
      this.#log({
        level: "error",
        scope: "agent-work.registration",
        event: "agent_work.registration.failed",
        message: "Agent Work runtime registration returned invalid JSON",
        requestId,
        data: { endpoint: httpEndpointMetadata(this.#options.baseUrl), http_status: response.status, error: errorMessage(error) }
      });
      throw new Error(`Agent Work runtime registration returned invalid JSON (request_id=${requestId})`, { cause: error });
    }
    const rejectRegistration = (error: Error, message: string): never => {
      this.#log({
        level: "error",
        scope: "agent-work.registration",
        event: "agent_work.registration.failed",
        message,
        requestId,
        data: { endpoint: httpEndpointMetadata(this.#options.baseUrl), http_status: response.status, error: error.message }
      });
      throw error;
    };
    if (body.error?.code === "RUNTIME_PROFILE_MISMATCH" || body.error?.details?.reason_code === "RUNTIME_PROFILE_MISMATCH") {
      rejectRegistration(
        new RuntimeIdentityMismatchError(`Agent Work profile does not match the enrolled Runtime (request_id=${requestId})`),
        "Agent Work runtime registration profile was rejected"
      );
    }
    const registeredRuntime = body.runtime;
    if (!response.ok || !registeredRuntime?.id) {
      if (response.status === 401 || response.status === 403) {
        this.#credentialFailures += 1;
        return rejectRegistration(
          new RuntimeCredentialRejectedError(response.status, this.#credentialFailures),
          "Agent Work runtime credential was rejected"
        );
      }
      const error = new Error(`Agent Work runtime registration failed (${response.status}, request_id=${requestId}): ${body.error?.message ?? "invalid response"}`);
      return rejectRegistration(error, "Agent Work runtime registration was rejected");
    }
    if (registeredRuntime.profile !== this.#options.profile) {
      rejectRegistration(
        new RuntimeIdentityMismatchError(`Agent Work runtime registration returned a different or missing profile (request_id=${requestId})`),
        "Agent Work runtime registration returned an unexpected profile"
      );
    }
    const protocolVersion = registeredRuntime.protocol_version;
    if (protocolVersion !== MAX_PROTOCOL_VERSION) {
      rejectRegistration(
        new Error(`Agent Work selected unsupported protocol ${protocolVersion} (request_id=${requestId})`),
        "Agent Work runtime registration selected an unsupported protocol"
      );
    }
    this.#log({
      level: "info",
      scope: "agent-work.registration",
      event: "agent_work.registration.completed",
      message: "local Agent Work runtime registered",
      requestId,
      data: { runtime_id: registeredRuntime.id, http_status: response.status }
    });
    this.#credentialFailures = 0;
    return { runtimeId: registeredRuntime.id, protocolVersion: MAX_PROTOCOL_VERSION };
  }

  async #registerAndConnect(epoch: number, signal?: AbortSignal): Promise<void> {
    const registration = await this.#register([...this.#adapterCapabilities.keys()], signal);
    this.#assertCurrentLifecycle(epoch);
    if (this.#options.runtimeId && this.#options.runtimeId !== registration.runtimeId) {
      throw new RuntimeIdentityMismatchError(
        `Agent Work runtime registration returned ${registration.runtimeId}, expected configured runtime ${this.#options.runtimeId}`
      );
    }
    this.#runtimeId = registration.runtimeId;
    this.#protocolVersion = registration.protocolVersion;
    await this.#connect(epoch, signal);
  }

  async #connect(epoch: number, signal?: AbortSignal): Promise<void> {
    this.#connectionState = "connecting";
    const url = new URL(`${stripSlash(this.#options.baseUrl)}/v1/runtime/connect`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const connectionId = `conn_wss_${randomUUID()}`;
    const requestId = createRequestId();
    const attempt = ++this.#connectionAttempt;
    // Endpoint metadata is intentionally reconstructed from URL components. Do
    // not record the original URL: it may contain userinfo or query credentials.
    const endpoint = webSocketEndpointMetadata(url);
    this.#log({
      level: "info",
      scope: "transport.wss",
      event: "transport.connection.connecting",
      message: "Agent Work WebSocket connection starting",
      requestId,
      data: { connection_id: connectionId, reconnect_attempt: attempt, endpoint }
    });
    const socket = new WebSocket(url, { headers: this.#headers(false, requestId) });
    this.#connectingSocket = socket;
    try {
      await new Promise<void>((resolve, reject) => {
        const handshake: { timer?: NodeJS.Timeout } = {};
        const cleanup = (): void => {
          if (handshake.timer) clearTimeout(handshake.timer);
          socket.off("open", onOpen);
          socket.off("error", onError);
          socket.off("close", onClose);
          signal?.removeEventListener("abort", onAbort);
        };
        const onOpen = (): void => {
          cleanup();
          resolve();
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        const onClose = (): void => {
          cleanup();
          reject(new Error("Agent Work WebSocket closed before opening"));
        };
        const onAbort = (): void => {
          cleanup();
          socket.once("error", () => undefined);
          socket.terminate();
          reject(abortError(signal));
        };
        socket.once("open", onOpen);
        socket.once("error", onError);
        socket.once("close", onClose);
        handshake.timer = setTimeout(() => {
          cleanup();
          socket.once("error", () => undefined);
          socket.terminate();
          reject(new Error("Agent Work WebSocket handshake timed out"));
        }, this.#options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      this.#assertCurrentLifecycle(epoch);
    } catch (error) {
      if (!(error instanceof RuntimeStoppingError)) {
        this.#log({
          level: "warn",
          scope: "transport.wss",
          event: "transport.connection.failed",
          message: "Agent Work WebSocket connection failed",
          requestId,
          data: {
            connection_id: connectionId,
            reconnect_attempt: attempt,
            endpoint,
            error: errorMessage(error)
          }
        });
      }
      socket.terminate();
      throw error;
    } finally {
      if (this.#connectingSocket === socket) this.#connectingSocket = undefined;
    }
    this.#socket = socket;
    this.#connectionState = "awaiting_welcome";
    this.#connectionId = connectionId;
    this.#log({
      level: "info",
      scope: "transport.wss",
      event: "transport.connection.opened",
      message: "Agent Work WebSocket connection opened",
      requestId,
      data: {
        connection_id: connectionId,
        reconnect_attempt: attempt,
        runtime_id: this.#runtimeId,
        endpoint
      }
    });
    this.#send("runtime.hello", {
      last_acked_command_seq: this.#store?.lastAckedCommandSeq ?? 0,
      // A persisted non-terminal row does not prove that a provider invocation
      // survived a process restart. Only live in-memory work and terminal rows
      // awaiting durable ACK are still owned by this Runtime connection.
      active_run_ids: this.#activeRunIds(),
      runtime_version: RUNTIME_VERSION,
      protocol_version_min: MIN_PROTOCOL_VERSION,
      protocol_version_max: MAX_PROTOCOL_VERSION,
      store_health: this.#storeHealthPayload()
    });
  }

  async #readLoop(epoch: number): Promise<void> {
    while (this.#isCurrentLifecycle(epoch)) {
      const socket = this.#socket;
      const wasConnected = this.#connected;
      if (socket) {
        try {
          await this.#waitForDisconnect(socket, epoch);
        } catch (error) {
          this.#connectionReason = connectionFailureReason(error);
          this.#reportError("transport.connection.error", "Agent Work WebSocket connection failed", error, {
            connection_id: this.#connectionId
          });
        }
        if (this.#socket === socket) this.#socket = undefined;
        this.#connectionId = undefined;
      }
      this.#connected = false;
      if (socket && wasConnected) {
        const trigger = this.#serverReconnectProtected ? "server_goaway" : "transport";
        this.#beginRecovery(trigger);
        if (this.#connectionReason === "none") this.#connectionReason = trigger;
      }
      if (this.#heartbeat) clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
      if (this.#reconnectReset) clearTimeout(this.#reconnectReset);
      this.#reconnectReset = undefined;
      // No event loss on disconnect: clear the in-flight markers so reconnect
      // replays everything from the lowest unacked seq.
      this.#inFlight.clear();
      this.#nackBackoff.clear();
      if (!this.#isCurrentLifecycle(epoch)) return;
      let serverReconnectAfterMs = this.#serverReconnectAfterMs;
      this.#serverReconnectAfterMs = undefined;
      while (this.#isCurrentLifecycle(epoch) && !this.#socket) {
        const reconnectAttempt = ++this.#consecutiveReconnects;
        const fastRecoveryReason = this.#fastRecoveryReason;
        this.#fastRecoveryReason = undefined;
        const clientReconnectDelay = fastRecoveryReason
          ? Math.floor(Math.random() * (this.#options.recoveryJitterMaxMs ?? DEFAULT_RECOVERY_JITTER_MAX_MS))
          : reconnectDelayMs(
            reconnectAttempt,
            this.#options.reconnectMs ?? DEFAULT_RECONNECT_MIN_MS,
            this.#options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS,
            Math.random,
            this.#options.reconnectFirstMs ?? DEFAULT_RECONNECT_FIRST_MS
          );
        const reconnectDelay = reconnectDelayWithServerHintMs(
          clientReconnectDelay,
          serverReconnectAfterMs,
          Math.random
        );
        serverReconnectAfterMs = undefined;
        const reconnectAbort = new AbortController();
        this.#reconnectAbort = reconnectAbort;
        this.#connectionState = "backing_off";
        try {
          await reconnectRuntimeDelay(reconnectDelay, reconnectAbort.signal);
          this.#serverReconnectProtected = false;
          this.#assertCurrentLifecycle(epoch);
          await this.#registerAndConnect(epoch, reconnectAbort.signal);
        } catch (error) {
          this.#connectionReason = connectionFailureReason(error);
          if (error instanceof RuntimeStoppingError || !this.#isCurrentLifecycle(epoch)) return;
          if (error instanceof RuntimeRecoverySignal) continue;
          if (error instanceof RuntimeCredentialRejectedError
            && error.attempt >= (this.#options.credentialFailureLimit ?? DEFAULT_CREDENTIAL_FAILURE_LIMIT)) {
            this.#connectionState = "action_required";
            this.#connectionReason = "auth";
            this.#reportError(
              "agent_work.registration.action_required",
              "Agent Work runtime credential requires operator action",
              error,
              { http_status: error.status, consecutive_failures: error.attempt }
            );
            return;
          }
          this.#reportError("transport.connection.reconnect_failed", "Agent Work WebSocket reconnect failed", error, {
            reconnect_attempt: this.#connectionAttempt
          });
        } finally {
          if (this.#reconnectAbort === reconnectAbort) this.#reconnectAbort = undefined;
        }
      }
    }
  }

  #startRecoveryProbe(epoch: number): void {
    const intervalMs = this.#options.recoveryProbeMs ?? DEFAULT_RECOVERY_PROBE_MS;
    this.#lastRecoveryProbeAt = Date.now();
    this.#lastRecoveryProbeMonotonicAt = performance.now();
    this.#networkFingerprint = localNetworkFingerprint();
    this.#recoveryProbe = setInterval(() => {
      if (!this.#isCurrentLifecycle(epoch)) return;
      const now = Date.now();
      const monotonicNow = performance.now();
      const elapsed = now - this.#lastRecoveryProbeAt;
      const monotonicElapsed = monotonicNow - this.#lastRecoveryProbeMonotonicAt;
      this.#lastRecoveryProbeAt = now;
      this.#lastRecoveryProbeMonotonicAt = monotonicNow;
      const fingerprint = localNetworkFingerprint();
      if (clockChanged(elapsed, monotonicElapsed, intervalMs * 2)) this.#requestFastRecovery("clock_change");
      else if (monotonicElapsed > intervalMs * 3) this.#requestFastRecovery("system_resume");
      else if (fingerprint !== this.#networkFingerprint) this.#requestFastRecovery("network_change");
      this.#networkFingerprint = fingerprint;
    }, intervalMs);
    this.#recoveryProbe.unref();
  }

  async #openStore(): Promise<void> {
    try {
      if (this.#storeHealth.state === "migration_failed") {
        this.#storeHealth = { ...this.#storeHealth, state: "healthy", acceptingNewRuns: false, errorCode: undefined };
      }
      await mkdir(dirname(this.#options.storePath), { recursive: true });
      await this.#refreshDiskHealth(false);
      this.#store = AgentWorkStore.open(this.#options.storePath);
      this.#storeQuarantined = this.#store.quarantinedPath !== undefined;
      if (this.#storeQuarantined) {
        const belowMinimum = this.#storeHealth.freeBytes < this.#storeHealth.minimumFreeBytes;
        this.#storeHealth = {
          ...this.#storeHealth,
          state: belowMinimum ? "low_disk" : "corrupt_quarantined",
          acceptingNewRuns: !belowMinimum,
          errorCode: belowMinimum ? "LOCAL_STORE_FULL" : "SQLITE_CORRUPT"
        };
        this.#reportError(
          "agent_work.store.corruption_quarantined",
          "corrupt Agent Work database was quarantined and replaced",
          new Error("SQLITE_CORRUPT"),
          { quarantined_path: this.#store.quarantinedPath }
        );
      } else if (this.#storeHealth.state !== "low_disk") {
        this.#storeHealth = { ...this.#storeHealth, state: "healthy", acceptingNewRuns: true, errorCode: undefined };
      }
    } catch (error) {
      this.#store = undefined;
      this.#storeHealth = {
        ...this.#storeHealth,
        state: "migration_failed",
        acceptingNewRuns: false,
        errorCode: storageErrorCode(error)
      };
      this.#reportError("agent_work.store.open_failed", "Agent Work store failed to open", error, {
        error_code: this.#storeHealth.errorCode
      });
    }
  }

  #startDiskProbe(epoch: number): void {
    const intervalMs = this.#options.diskCheckMs ?? DEFAULT_DISK_CHECK_MS;
    this.#diskTimer = setInterval(() => {
      void this.#refreshDiskHealth(true).catch(error => {
        this.#reportError("agent_work.store.disk_probe_failed", "Agent Work disk probe failed", error);
      });
    }, intervalMs);
    this.#diskTimer.unref();
    if (!this.#isCurrentLifecycle(epoch)) {
      clearInterval(this.#diskTimer);
      this.#diskTimer = undefined;
    }
  }

  async #refreshDiskHealth(notify: boolean): Promise<void> {
    if (this.#storeHealth.state === "migration_failed") return;
    const stats = await statfs(dirname(this.#options.storePath), { bigint: true });
    const freeBytes = Number(
      stats.bavail * stats.bsize > BigInt(Number.MAX_SAFE_INTEGER)
        ? BigInt(Number.MAX_SAFE_INTEGER)
        : stats.bavail * stats.bsize
    );
    const previous = this.#storeHealth;
    const belowMinimum = freeBytes < previous.minimumFreeBytes;
    const state: RuntimeStoreHealthState = belowMinimum
      ? (previous.state === "full" ? "full" : "low_disk")
      : (this.#storeQuarantined ? "corrupt_quarantined" : "healthy");
    this.#storeHealth = {
      state,
      acceptingNewRuns: !belowMinimum && this.#store !== undefined,
      freeBytes,
      minimumFreeBytes: previous.minimumFreeBytes,
      ...(state === "full" ? { errorCode: "LOCAL_STORE_FULL" } : {}),
      ...(state === "corrupt_quarantined" ? { errorCode: "SQLITE_CORRUPT" } : {})
    };
    if (notify && !sameStoreHealth(previous, this.#storeHealth)) this.#sendRuntimeHealth();
  }

  #markStoreUnavailable(error: unknown): boolean {
    if (!isStorageCapacityError(error)) return false;
    this.#storeHealth = {
      ...this.#storeHealth,
      state: "full",
      acceptingNewRuns: false,
      errorCode: storageErrorCode(error)
    };
    this.#reportError("agent_work.store.full", "Agent Work store cannot persist more data", error, {
      error_code: this.#storeHealth.errorCode,
      free_bytes: this.#storeHealth.freeBytes
    });
    this.#sendRuntimeHealth();
    return true;
  }

  #storeHealthPayload(): Record<string, unknown> {
    return {
      state: this.#storeHealth.state,
      accepting_new_runs: this.#storeHealth.acceptingNewRuns,
      free_bytes: this.#storeHealth.freeBytes,
      minimum_free_bytes: this.#storeHealth.minimumFreeBytes,
      ...(this.#storeHealth.errorCode ? { error_code: this.#storeHealth.errorCode } : {}),
      active_run_ids: this.#activeRunIds()
    };
  }

  #activeRunIds(): string[] {
    return [...new Set([
      ...this.#activeRuns.keys(),
      ...this.#acceptingRuns.keys(),
      ...(this.#store?.pendingTerminalAckRunIds() ?? [])
    ])];
  }

  #sendRuntimeHealth(): void {
    if (!this.#connected) return;
    this.#trySend("runtime.health", this.#storeHealthPayload());
  }

  #requestFastRecovery(reason: "network_change" | "system_resume" | "clock_change"): void {
    if (this.#stopped || this.#connectionState === "action_required" || this.#serverReconnectProtected) return;
    this.#fastRecoveryReason = reason;
    this.#connectionReason = reason;
    this.#beginRecovery(reason);
    this.#log({
      level: "info",
      scope: "transport.wss",
      event: "transport.connection.fast_recovery_requested",
      message: "Agent Work connectivity changed; scheduling a fast reconnect",
      data: { reason, connection_state: this.#connectionState }
    });
    this.#reconnectAbort?.abort(new RuntimeRecoverySignal(reason));
    this.#connectingSocket?.terminate();
    this.#socket?.terminate();
  }

  #waitForDisconnect(socket: WebSocket, epoch: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let receiveTimer: NodeJS.Timeout | undefined;
      const cleanup = (): void => {
        if (receiveTimer) clearTimeout(receiveTimer);
        socket.off("message", onMessage);
        socket.off("close", onClose);
        socket.off("error", onError);
      };
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const resetReceiveTimeout = (): void => {
        if (receiveTimer) clearTimeout(receiveTimer);
        receiveTimer = setTimeout(() => {
          socket.terminate();
          settle(new Error("Agent Work WebSocket server receive timed out"));
        }, this.#options.receiveTimeoutMs ?? DEFAULT_RECEIVE_TIMEOUT_MS);
        receiveTimer.unref();
      };
      const onMessage = (data: WebSocket.RawData): void => {
        resetReceiveTimeout();
        const handler = (async () => {
          const envelope = JSON.parse(rawDataText(data)) as WireEnvelope;
          await this.#receive(envelope, epoch);
        })().catch((error: unknown) => {
          if (this.#markStoreUnavailable(error)) return;
          socket.terminate();
          settle(error instanceof Error ? error : new Error(String(error)));
        });
        this.#messageHandlers.add(handler);
        void handler.finally(() => this.#messageHandlers.delete(handler));
      };
      const onClose = (code: number, reason: Buffer): void => {
        this.#log({
          level: code === 1000 ? "info" : "warn",
          scope: "transport.wss",
          event: "transport.connection.closed",
          message: "Agent Work WebSocket connection closed",
          data: {
            connection_id: this.#connectionId,
            close_code: code,
            close_reason: reason.toString("utf8") || undefined
          }
        });
        settle();
      };
      const onError = (error: Error): void => settle(error);
      socket.on("message", onMessage);
      socket.once("close", onClose);
      socket.once("error", onError);
      resetReceiveTimeout();
    });
  }

  async #receive(envelope: WireEnvelope, epoch: number): Promise<void> {
    if (!this.#isCurrentLifecycle(epoch)) return;
    if (envelope.version !== this.#protocolVersion) throw new Error(`unsupported Agent Work protocol ${envelope.version}`);
    if (envelope.runtime_id && envelope.runtime_id !== this.#runtimeId) {
      throw new RuntimeIdentityMismatchError(
        `Agent Work message targeted runtime ${envelope.runtime_id}, expected ${this.#runtimeId}`
      );
    }
    const envelopePayload = asRecord(envelope.payload);
    const commandPayload = envelope.type === "runtime.command" ? envelopePayload : undefined;
    // Transport traces carry routing and correlation fields, never the envelope
    // payload. Business payloads can contain full occurrence or provider content
    // and belong only in the explicitly enabled sensitive capture stream.
    this.#log({
      level: "debug",
      scope: "transport.wss",
      event: "transport.message.received",
      message: "Agent Work WebSocket message received",
      runId: stringValue(commandPayload?.run_id) ?? stringValue(envelopePayload.run_id),
      data: {
        connection_id: this.#connectionId,
        envelope_id: envelope.id,
        frame_type: envelope.type,
        command_id: stringValue(commandPayload?.command_id),
        server_seq: commandPayload?.server_seq,
        seq: envelope.seq,
        ack: envelope.ack
      }
    });
    if (envelope.type === "context.append") {
      assertChannelContextAppend(envelope.payload);
      this.#contextStore?.append(envelope.payload);
      return;
    }
    if (envelope.type === "context.sync_result") {
      assertContextSyncResult(envelope.payload);
      const pending = this.#pendingContextSyncs.get(envelope.payload.request_id);
      if (!pending
        || this.#latestContextSyncByScope.get(pending.scopeKey) !== envelope.payload.request_id
        || !matchesPendingContextSync(pending, envelope.payload)) return;
      this.#contextStore?.applySyncResult(envelope.payload);
      this.#resolveContextSync(envelope.payload.request_id);
      return;
    }
    if (envelope.type === "runtime.welcome") {
      const payload = asRecord(envelope.payload);
      const everyMs = typeof payload.heartbeat_every_ms === "number" ? payload.heartbeat_every_ms : 30_000;
      await this.#applyAuthoritativeTerminalRuns(payload.authoritative_terminal_runs);
      // received ACK only proves that the previous Worker process held the
      // batch in memory. A new socket may point at a restarted Worker, so the
      // local Outbox must replay every row not covered by durable ACK.
      this.#store?.prepareReplayAfterReconnect();
      this.#connected = true;
      this.#connectionState = "online";
      this.#connectionReason = "none";
      if (this.#recoveryStartedAt !== undefined) {
        this.#lastRecoveryDurationMs = Math.max(0, performance.now() - this.#recoveryStartedAt);
        this.#lastRecoveryTrigger = this.#recoveryTrigger ?? "transport";
        this.#recoveryStartedAt = undefined;
        this.#recoveryTrigger = undefined;
      }
      this.#log({
        level: "info",
        scope: "agent-work.runtime",
        event: "agent_work.runtime.ready",
        message: "Agent Work runtime is online",
        data: {
          runtime_id: this.#runtimeId,
          heartbeat_every_ms: everyMs,
          connection_id: this.#connectionId
        }
      });
      if (this.#reconnectReset) clearTimeout(this.#reconnectReset);
      this.#reconnectReset = setTimeout(() => {
        if (this.#connected && this.#isCurrentLifecycle(epoch)) this.#consecutiveReconnects = 0;
      }, RECONNECT_STABLE_RESET_MS);
      this.#reconnectReset.unref();
      if (this.#heartbeat) clearInterval(this.#heartbeat);
      this.#heartbeat = setInterval(() => this.#trySend("runtime.heartbeat", { runtime_version: RUNTIME_VERSION }), everyMs);
      this.#sendRuntimeHealth();
      // Once the connection is ready, immediately drain the outbox (including
      // events backlogged during the disconnect).
      this.#kickSender();
      return;
    }
    if (envelope.type === "runtime.health_ack") {
      const payload = asRecord(envelope.payload);
      await this.#applyAuthoritativeTerminalRuns(payload.authoritative_terminal_runs, "runtime.health_ack");
      return;
    }
    if (envelope.type === "runtime.goaway") {
      const payload = asRecord(envelope.payload);
      const retryAfterMs = Number(payload.retry_after_ms);
      if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 1 || retryAfterMs > 2_147_483_647) {
        throw new Error("Agent Work runtime.goaway requires a positive retry_after_ms");
      }
      this.#serverReconnectAfterMs = retryAfterMs;
      this.#serverReconnectProtected = true;
      this.#connected = false;
      this.#connectionReason = "server_goaway";
      this.#log({
        level: "info",
        scope: "transport.wss",
        event: "transport.connection.goaway",
        message: "Agent Work server requested a delayed reconnect",
        data: {
          connection_id: this.#connectionId,
          reason: stringValue(payload.reason),
          retry_after_ms: retryAfterMs
        }
      });
      this.#socket?.close(1012, "worker draining");
      return;
    }
    if (envelope.type === "runtime.command") {
      await this.#acceptCommand(envelope.payload as RuntimeCommand, epoch);
      return;
    }
    if (envelope.type === "event.ack") {
      const payload = asRecord(envelope.payload);
      const runId = String(payload.run_id);
      const received = Number(payload.received_through_seq);
      const durable = Number(payload.durable_through_seq);
      const store = this.#store;
      if (store) {
        // received_through_seq: the batch is safely held in Worker memory —
        // release the send window (do not delete the outbox yet).
        if (Number.isFinite(received)) {
          const outcome = store.advanceReceived(runId, received);
          if (!outcome.advanced && outcome.reason === "ack_beyond_produced") {
            this.#reportError("agent_work.ack.rejected", "Agent Work received ACK was out of range", new Error("ack_beyond_produced"), { run_id: runId, seq: received });
          }
          const prefix = `${runId}:`;
          for (const key of [...this.#inFlight]) {
            if (key.startsWith(prefix) && Number(key.slice(prefix.length)) <= received) this.#inFlight.delete(key);
          }
          this.#nackBackoff.delete(runId);
        }
        // durable_through_seq: aggregated state committed cloud-side — only now
        // may confirmed outbox rows be deleted.
        if (Number.isFinite(durable) && durable > 0) {
          const inspection = store.inspectDurableAck(runId, durable);
          if (inspection.advanced) {
            let contextCommitted = true;
            if (inspection.terminal?.type === "run.completed") {
              const snapshot = this.#contextStore?.getSnapshot(runId);
              if (snapshot) {
                const grant = payload.context_commit_granted === true;
                const authoritativeStatus = stringValue(payload.authoritative_terminal_status);
                const authoritativeEventId = stringValue(payload.authoritative_terminal_event_id);
                const grantMatchesTerminal = grant
                  && authoritativeStatus === "completed"
                  && authoritativeEventId === inspection.terminal.eventId;
                if (!grantMatchesTerminal) {
                  this.#contextStore?.markFailed(runId);
                  this.#reportError("channel_context.commit_not_granted", "channel context commit was not granted", new Error("commit_not_granted"), {
                    run_id: runId,
                    authoritative_status: authoritativeStatus ?? "missing"
                  });
                } else {
                  const result = this.#contextStore!.commitSnapshot(runId);
                  if (!result.committed) {
                    this.#reportError("channel_context.commit_rejected", "channel context cursor commit was rejected", new Error(result.reason), { run_id: runId });
                    contextCommitted = false;
                  }
                }
              }
            } else if (inspection.terminal) {
              this.#contextStore?.markFailed(runId);
            }
            // Commit context first: if it fails, leave terminal in the outbox so
            // the durable ACK can be replayed after reconnect. Both operations are idempotent.
            if (contextCommitted) store.advanceDurable(runId, durable);
          } else if (inspection.reason === "ack_beyond_produced") {
            this.#reportError("agent_work.ack.rejected", "Agent Work durable ACK was out of range", new Error("ack_beyond_produced"), { run_id: runId, seq: durable });
          }
        }
        // ACK released capacity and may unblock more sendable rows.
        this.#kickSender();
      }
      return;
    }
    if (envelope.type === "event.nack") {
      const payload = asRecord(envelope.payload);
      const runId = stringValue(payload.run_id);
      const resumeFromSeq = Number(payload.resume_from_seq);
      if (!runId || !Number.isSafeInteger(resumeFromSeq) || resumeFromSeq < 1) {
        throw new Error("Agent Work event.nack requires run_id and a positive resume_from_seq");
      }
      const prefix = `${runId}:`;
      for (const key of [...this.#inFlight]) {
        if (key.startsWith(prefix) && Number(key.slice(prefix.length)) >= resumeFromSeq) this.#inFlight.delete(key);
      }
      const previous = this.#nackBackoff.get(runId);
      const attempt = (previous?.attempt ?? 0) + 1;
      const suggestedRetryMs = Number(payload.retry_after_ms);
      const baseRetryMs = Number.isFinite(suggestedRetryMs) && suggestedRetryMs > 0
        ? Math.trunc(suggestedRetryMs)
        : DEFAULT_NACK_RETRY_MS;
      const retryMs = Math.min(MAX_NACK_RETRY_MS, baseRetryMs * (2 ** Math.min(attempt - 1, 10)));
      this.#nackBackoff.set(runId, { attempt, retryAt: Date.now() + retryMs });
      this.#log({
        level: "warn",
        scope: "agent-work.delivery",
        event: "agent_work.event.nack",
        message: "Agent Work event batch was rejected",
        runId,
        data: {
          code: payload.code,
          resume_from_seq: resumeFromSeq,
          retry_after_ms: retryMs,
          retry_attempt: attempt,
          connection_id: this.#connectionId
        }
      });
      this.#kickSender();
      return;
    }
    if (envelope.type === "error") {
      const payload = asRecord(envelope.payload);
      throw new Error(`Agent Work protocol error ${String(payload.code)}: ${String(payload.message)}`);
    }
  }

  #beginRecovery(trigger: RuntimeRecoveryTrigger): void {
    if (this.#recoveryStartedAt === undefined) this.#recoveryStartedAt = performance.now();
    if (trigger !== "transport" || !this.#recoveryTrigger) this.#recoveryTrigger = trigger;
  }

  async #applyAuthoritativeTerminalRuns(value: unknown, source = "runtime.welcome"): Promise<void> {
    if (value === undefined) return;
    if (!Array.isArray(value)) throw new Error(`${source} authoritative_terminal_runs must be an array`);
    for (const item of value) {
      const authority = asRecord(item);
      const runId = stringValue(authority.run_id);
      const status = stringValue(authority.status);
      const terminalEventId = stringValue(authority.terminal_event_id);
      if (!runId || !status || !["completed", "failed", "cancelled"].includes(status)) {
        throw new Error(`${source} contains an invalid authoritative terminal run`);
      }
      this.#authoritativeTerminalRuns.add(runId);
      const accepting = this.#acceptingRuns.get(runId);
      accepting?.controller.abort(new AuthoritativeTerminalRunError(runId, status));
      const active = this.#activeRuns.get(runId);
      if (active) {
        await this.#host.cancel(active.invocationId, `authoritative server terminal: ${status}`).catch(error => {
          this.#reportError("adapter.invoke.authoritative_cancel_failed", "failed to cancel an authoritatively terminal invocation", error, {
            run_id: runId,
            authoritative_status: status,
            authoritative_terminal_event_id: terminalEventId ?? "unavailable"
          });
        });
      }
      this.#store?.discardAuthoritativelyTerminalRun(runId);
      this.#contextStore?.markFailed(runId);
      this.#log({
        level: "warn",
        scope: "agent-work.reconciliation",
        event: "agent_run.authoritative_terminal_applied",
        message: "stopped local execution after authoritative server terminal",
        runId,
        invocationId: active?.invocationId,
        data: { authoritative_status: status, authoritative_terminal_event_id: terminalEventId ?? "unavailable" }
      });
      if (!active && !accepting) this.#authoritativeTerminalRuns.delete(runId);
    }
  }

  async #acceptCommand(command: RuntimeCommand, epoch: number): Promise<void> {
    if (!command?.command_id || !command.run_id || !command.type) throw new Error("invalid runtime.command payload");
    this.#log({
      level: "info",
      scope: "agent-work.command",
      event: "agent_work.command.received",
      message: "Agent Work command received",
      runId: command.run_id,
      data: {
        connection_id: this.#connectionId,
        command_id: command.command_id,
        command_type: command.type,
        server_seq: command.server_seq
      }
    });
    if (command.type === "interaction.respond") {
      const store = this.#store;
      if (!store) {
        this.#ackCommand(command, false, { code: "LOCAL_STORE_UNAVAILABLE" });
        return;
      }
      const receipt = store.getCommandReceipt(command.command_id);
      if (receipt) {
        this.#ackCommand(command, receipt.accepted, receipt.error);
        return;
      }
      const active = this.#activeRuns.get(command.run_id);
      const reject = (code: string, message: string): void => {
        const error = { code, message };
        store.recordCommandReceipt(command.command_id, command.server_seq, false, error);
        this.#ackCommand(command, false, error);
      };
      if (!active) {
        reject("RUN_NOT_ACTIVE", "interaction response requires an active invocation");
        return;
      }
      if (command.lease_id !== active.leaseId || command.fencing_token !== active.fencingToken) {
        reject("STALE_COMMAND_FENCE", "interaction response does not own the active run lease");
        return;
      }
      try {
        const payload = asRecord(command.payload);
        if (payload.execution_instance_id !== active.invocationId) {
          reject("STALE_EXECUTION_INSTANCE", "interaction response does not own the active invocation instance");
          return;
        }
        const response: InteractionResponse = {
          interactionId: requiredString(payload.interaction_id, "interaction.respond interaction_id"),
          outcome: requiredString(payload.outcome, "interaction.respond outcome") as InteractionResponse["outcome"],
          ...(Object.hasOwn(payload, "value") ? { value: payload.value } : {})
        };
        assertInteractionResponse(response);
        await this.#host.respondInteraction(active.invocationId, response);
        store.recordCommandReceipt(command.command_id, command.server_seq, true);
        this.#ackCommand(command, true);
      } catch (error) {
        reject("INTERACTION_RESPONSE_REJECTED", errorMessage(error));
      }
      return;
    }
    if (command.type === "run.cancel") {
      const active = this.#activeRuns.get(command.run_id);
      if (active) {
        const cancelled = (await this.#host.cancel(active.invocationId, "control plane cancel")).cancelled;
        this.#ackCommand(command, true, cancelled ? undefined : { code: "RUN_NOT_ACTIVE" });
        return;
      }
      const accepting = this.#acceptingRuns.get(command.run_id);
      if (accepting) {
        const failure = { code: "RUN_CANCELLED_BEFORE_START", message: "run cancelled while waiting for admission" };
        this.#store?.recordCommandReceipt(accepting.commandId, accepting.serverSeq, false, failure);
        this.#contextStore?.markFailed(command.run_id);
        accepting.controller.abort(new AcceptingRunCancelledError());
        this.#ackCommand(command, true);
        return;
      }
      this.#contextStore?.markFailed(command.run_id);
      this.#ackCommand(command, true, { code: "RUN_NOT_ACTIVE" });
      return;
    }
    if (command.type !== "run.start") {
      this.#ackCommand(command, false, { code: "UNSUPPORTED_COMMAND", message: command.type });
      return;
    }
    const store = this.#store;
    if (!store) {
      const error = failurePayload({ code: "LOCAL_STORE_UNAVAILABLE" }, {
        stage: "runtime.command.accept",
        defaultDomain: "runtime",
        runId: command.run_id
      });
      this.#ackCommand(command, false, error);
      this.#sendRuntimeHealth();
      return;
    }
    // Idempotent across restart: a repeated command_id replays the saved receipt
    // instead of re-executing.
    const receipt = store.getCommandReceipt(command.command_id);
    if (receipt) {
      this.#ackCommand(command, receipt.accepted, receipt.error);
      return;
    }
    if (this.#activeRuns.has(command.run_id)) {
      this.#ackCommand(command, true);
      return;
    }
    // A replay while the first handler waits must join the in-flight
    // admission attempt before evaluating mutable capacity constraints.
    if (this.#acceptingCommandIds.has(command.command_id) || this.#acceptingRuns.has(command.run_id)) {
      // The control plane retries unacknowledged commands while a FIFO entry
      // can legitimately wait longer than its delivery timeout. Confirm that
      // the existing local admission owns the command; its original handler
      // remains responsible for validation, durable receipt, and execution.
      const accepting = this.#acceptingRuns.get(command.run_id);
      if (accepting && accepting.commandId === command.command_id && !accepting.acknowledged) {
        accepting.acknowledged = true;
        this.#ackCommand(command, true);
      }
      return;
    }
    if (this.#draining) {
      const error = failurePayload({ code: "RUNTIME_DRAINING" }, {
        stage: "runtime.command.accept",
        defaultDomain: "runtime",
        runId: command.run_id
      });
      store.recordCommandReceipt(command.command_id, command.server_seq, false, error);
      this.#ackCommand(command, false, error);
      return;
    }
    if (!this.#storeHealth.acceptingNewRuns) {
      const code = this.#storeHealth.state === "low_disk" || this.#storeHealth.state === "full"
        ? "LOCAL_STORE_FULL"
        : "LOCAL_STORE_UNAVAILABLE";
      const error = failurePayload({ code }, {
        stage: "runtime.command.accept",
        defaultDomain: "runtime",
        runId: command.run_id
      });
      store.recordCommandReceipt(command.command_id, command.server_seq, false, error);
      this.#ackCommand(command, false, error);
      this.#sendRuntimeHealth();
      return;
    }
    // Soft-watermark backpressure: reject new Runs so the existing outbox drains
    // first; unacked data is not deleted.
    const softWatermark = this.#options.softWatermarkBytes ?? DEFAULT_SOFT_WATERMARK_BYTES;
    const hardWatermark = this.#options.hardWatermarkBytes ?? DEFAULT_HARD_WATERMARK_BYTES;
    const pendingBytes = store.outboxBytes();
    if (pendingBytes >= hardWatermark) {
      this.#log({
        level: "error",
        scope: "agent-work.outbox",
        event: "agent_work.outbox.hard_watermark",
        message: "Agent Work outbox is above the hard watermark",
        runId: command.run_id,
        data: { pending_bytes: pendingBytes, hard_watermark_bytes: hardWatermark }
      });
      const error = failurePayload({ code: "OUTBOX_HARD_LIMIT" }, {
        stage: "runtime.command.accept",
        defaultDomain: "runtime",
        runId: command.run_id
      });
      store.recordCommandReceipt(command.command_id, command.server_seq, false, error);
      this.#ackCommand(command, false, error);
      return;
    }
    if (pendingBytes >= softWatermark) {
      const error = failurePayload({ code: "OUTBOX_BACKPRESSURE" }, {
        stage: "runtime.command.accept",
        defaultDomain: "runtime",
        runId: command.run_id
      });
      store.recordCommandReceipt(command.command_id, command.server_seq, false, error);
      this.#ackCommand(command, false, error);
      return;
    }
    const maxConcurrentRuns = this.#options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
    const controller = new AbortController();
    this.#acceptingCommandIds.add(command.command_id);
    const accepting: AcceptingRun = {
      commandId: command.command_id,
      serverSeq: command.server_seq,
      controller,
      acknowledged: false
    };
    this.#acceptingRuns.set(command.run_id, accepting);
    let releaseAdmission: (() => void) | undefined;
    let admissionHandedOff = false;
    try {
      let request: InvokeRequest;
      let adapterType: string;
      let agentSessionId: string;
      let leaseId: string;
      let fencingToken: number;
      try {
        leaseId = requiredString(command.lease_id, "run.start lease_id");
        fencingToken = requiredSafeInteger(command.fencing_token, "run.start fencing_token");
        const executionEnvelope = command.payload as ExecutionEnvelope;
        assertExecutionEnvelopeContract(executionEnvelope);
        const selection = executionEnvelope.resolved_runtime_selection;
        if (!selection.authorized_candidates.some(candidate => candidate.runtime_id === this.#runtimeId)
          || (selection.selection_mode === "explicit" && selection.explicit_runtime_id !== this.#runtimeId)) {
          throw new TypeError("RUNTIME_SELECTION_TARGET_MISMATCH");
        }
        const adapterTypeForContext = executionAdapterType(executionEnvelope);
        this.#assertAdapterAvailable(adapterTypeForContext);
        const requiredCapabilities = executionEnvelope.resolved_execution_plan.required_capabilities ?? [];
        const localCapabilities = this.#adapterCapabilities.get(adapterTypeForContext);
        if (requiredCapabilities.some(capability => !localCapabilities?.has(capability))) throw new TypeError("ADAPTER_REQUIRED_CAPABILITY_MISSING");
        const input = executionEnvelope.agent_run_request.input;
        const hasImages = Array.isArray(input.parts) && input.parts.some(part => part && typeof part === "object" && (part as Record<string, unknown>).type === "image");
        if (hasImages && !localCapabilities?.has("input.image")) throw new TypeError("UNSUPPORTED_INPUT_MODALITY");
        const materializedInput = await resolveRuntimeInputImages(input, {
          baseUrl: this.#options.baseUrl,
          headers: this.#headers(true, createRequestId()),
          runId: command.run_id, leaseId, fencingToken, signal: controller.signal
        });
        const taskMaterials = await prepareTaskMaterials(executionEnvelope.effective_context,
          executionEnvelope.resolved_execution_plan, controller.signal);
        const contextSnapshot = await this.#prepareChannelContext(
          command.run_id,
          executionEnvelope,
          adapterTypeForContext,
          controller.signal,
          epoch
        );
        throwIfAcceptingAborted(controller.signal);
        this.#assertCurrentLifecycle(epoch);
        const mapped = mapExecutionEnvelope({
          ...executionEnvelope,
          agent_run_request: { ...executionEnvelope.agent_run_request, input: materializedInput }
        }, contextSnapshot, taskMaterials);
        request = mapped.request;
        request.runMetadata ??= {};
        // The authenticated Runtime connection owns this mapping. Never trust
        // an AgentRun payload to self-report its local profile.
        if (this.#options.profile) request.runMetadata.profile = this.#options.profile;
        request.runMetadata.runtimeId = this.#runtimeId;
        adapterType = mapped.adapterType;
        const adapterConfiguration = this.#options.adapterConfigurations?.[adapterType];
        if (adapterConfiguration) {
          request.agentConfig = {
            ...request.agentConfig,
            ...(adapterConfiguration.providerAgentId
              ? { providerAgentId: adapterConfiguration.providerAgentId }
              : {}),
            providerOptions: {
              ...request.agentConfig.providerOptions,
              ...adapterConfiguration.providerOptions
            }
          };
        }
        agentSessionId = request.agentSessionId;
        const trigger = executionEnvelope.agent_run_request.trigger;
        this.#log({
          level: "info",
          scope: "agent-work.dispatch",
          event: "agent_run.received",
          message: "AgentRun received from Agent Worker",
          runId: command.run_id,
          invocationId: request.invocationId,
          agentSessionId,
          data: {
            connection_id: this.#connectionId,
            command_id: command.command_id,
            namespace: executionEnvelope.agent_run_request.namespace,
            trigger_kind: trigger.kind,
            trigger_occurrence_id: trigger.occurrence_id
          }
        });
        this.#log({
          level: "info",
          scope: "adapter.dispatch",
          event: "adapter.selected",
          message: `selected ${adapterType} adapter`,
          runId: command.run_id,
          invocationId: request.invocationId,
          agentSessionId,
          adapterType,
          data: {
            command_id: command.command_id,
            namespace: executionEnvelope.agent_run_request.namespace,
            trigger_kind: trigger.kind,
            trigger_occurrence_id: trigger.occurrence_id
          }
        });
      } catch (error) {
        if (error instanceof RuntimeStoppingError) {
          this.#contextStore?.markFailed(command.run_id);
          return;
        }
        if (error instanceof AuthoritativeTerminalRunError) {
          this.#contextStore?.markFailed(command.run_id);
          return;
        }
        if (error instanceof AcceptingRunCancelledError) {
          this.#contextStore?.markFailed(command.run_id);
          const failure = store.getCommandReceipt(command.command_id)?.error
            ?? { code: "RUN_CANCELLED_BEFORE_START", message: "run cancelled while waiting for admission" };
          if (!store.getCommandReceipt(command.command_id)) {
            store.recordCommandReceipt(command.command_id, command.server_seq, false, failure);
          }
          this.#ackCommand(command, false, failure);
          return;
        }
        this.#contextStore?.markFailed(command.run_id);
        const failure = error instanceof ChannelContextStaleGenerationError
          ? {
              code: "STALE_CONTEXT_GENERATION",
              message: error.message,
              requested_generation: error.requestedGeneration,
              latest_generation: error.latestGeneration
            }
          : error instanceof ProviderConfigurationMissingError
            ? failurePayload({ code: "PROVIDER_CONFIG_MISSING" }, {
                stage: "provider.configuration",
                defaultDomain: "provider",
                runId: command.run_id,
                source: { component: "octo-harness", adapter: error.adapterType }
              })
            : { code: "INVALID_EXECUTION_ENVELOPE", message: errorMessage(error) };
        store.recordCommandReceipt(command.command_id, command.server_seq, false, failure);
        this.#ackCommand(command, false, failure);
        return;
      }
      // Freeze the command's context before it waits for provider capacity.
      // Otherwise a faster sibling Run can advance the consumer generation and
      // turn a valid fan-out command into a stale-context rejection in the queue.
      while (this.#isCurrentLifecycle(epoch)) {
        throwIfAcceptingAborted(controller.signal);
        const position = [...this.#acceptingRuns.keys()].indexOf(command.run_id);
        const available = Math.max(0, maxConcurrentRuns - this.#activeRuns.size);
        if (position >= 0 && position < available) break;
        await abortableDelay(CONTEXT_BUSY_POLL_MS, controller.signal);
      }
      this.#assertCurrentLifecycle(epoch);
      releaseAdmission = await this.#runAdmission?.acquire(controller.signal);
      this.#assertCurrentLifecycle(epoch);
      store.upsertRun({
        runId: command.run_id,
        agentSessionId,
        commandId: command.command_id,
        leaseId,
        fencingToken
      });
      store.recordCommandReceipt(command.command_id, command.server_seq, true);
      this.#activeRuns.set(command.run_id, {
        invocationId: request.invocationId,
        leaseId,
        fencingToken
      });
      if (!accepting.acknowledged) this.#ackCommand(command, true);
      const execution = this.#execute(command, adapterType, request, releaseAdmission);
      admissionHandedOff = true;
      this.#executionTasks.add(execution);
      void execution.finally(() => this.#executionTasks.delete(execution));
    } finally {
      if (!admissionHandedOff) releaseAdmission?.();
      this.#acceptingCommandIds.delete(command.command_id);
      if (this.#acceptingRuns.get(command.run_id)?.controller === controller) {
        this.#acceptingRuns.delete(command.run_id);
      }
      if (!this.#activeRuns.has(command.run_id)) this.#authoritativeTerminalRuns.delete(command.run_id);
    }
  }

  #assertAdapterAvailable(adapterType: string): void {
    const adapter = this.#adapters.find(candidate => candidate.type === adapterType);
    // An empty capability list is retained for legacy embedders. Production
    // daemon startup always reports discovered adapters.
    if (this.#adapters.length > 0 && (!adapter || adapter.available === false)) {
      throw new ProviderConfigurationMissingError(adapterType);
    }
  }

  async #prepareChannelContext(
    runId: string,
    envelope: ExecutionEnvelope,
    adapterType: string,
    signal: AbortSignal,
    epoch: number
  ): Promise<PreparedChannelContextSnapshot | undefined> {
    const descriptorValue = contextItem(envelope.effective_context, "octo.content", "continuity")?.payload;
    if (descriptorValue === undefined) return undefined;
    assertChannelContextDescriptor(descriptorValue);
    const descriptor = descriptorValue;
    const contextStore = this.#contextStore;
    if (!contextStore) return undefined;

    // Reliable trigger path repairs a dropped best-effort append before selection.
	contextStore.append({ agent_id: envelope.agent_run_request.agent_id, scope: descriptor.scope, facts: [descriptor.trigger_fact] });
    const adapterCapabilities = this.#adapterCapabilities.get(adapterType);
    if (contextStore.needsSync(descriptor.scope)) await this.#requestContextSync(runId, descriptor, signal);
    while (this.#isCurrentLifecycle(epoch)) {
      throwIfAcceptingAborted(signal);
      try {
        const snapshot = contextStore.prepareSnapshot(runId, descriptor);
        if (!this.#usesAppendOnlyDelta()) return contextStore.selectColdProjection(runId);
        // A provider with no serializable session starts cold on every turn.
        // Give it the bounded full projection without promoting the context
        // generation, because no previously resumed session became invalid.
        if (!adapterCapabilities?.has("session.serialize")) {
          return contextStore.selectColdProjection(runId);
        }
        // A resumable provider without same-turn recovery cannot safely consume
        // only a delta if its saved session has disappeared. Start it cold with
        // the bounded recovery projection instead of rejecting the whole Run.
        if (envelope.provider_session
          && !adapterCapabilities.has("session.resume_recovery")) {
          return contextStore.selectRecovery(runId);
        }
        return snapshot;
      } catch (error) {
        if (!(error instanceof ChannelContextConsumerBusyError)) throw error;
        await abortableDelay(CONTEXT_BUSY_POLL_MS, signal);
      }
    }
    throw new RuntimeStoppingError();
  }

  async #requestContextSync(runId: string, descriptor: ChannelContextDescriptor, signal: AbortSignal): Promise<void> {
    const contextStore = this.#contextStore;
    if (!contextStore) return;
    const requestId = `ctx_sync_${randomUUID()}`;
    const afterSeq = contextStore.syncAfterSeq(descriptor.scope);
    const request: ContextSyncRequest = {
      request_id: requestId,
      agent_run_id: runId,
      scope: descriptor.scope,
      trigger_message_id: descriptor.trigger_message_id,
      ...(descriptor.trigger_seq === undefined ? {} : { trigger_seq: descriptor.trigger_seq }),
      ...(afterSeq === undefined ? {} : { after_seq: afterSeq }),
      limit: Math.min(this.#options.channelContext?.maxProjectedMessages ?? DEFAULT_CONTEXT_SYNC_LIMIT, 100)
    };
    const scopeKey = channelScopeKey(descriptor.scope);
    const wait = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#resolveContextSync(requestId);
      }, this.#options.channelContext?.syncTimeoutMs ?? DEFAULT_CONTEXT_SYNC_TIMEOUT_MS);
      timer.unref?.();
      const onAbort = (): void => {
        this.#resolveContextSync(requestId, acceptingAbortError(signal));
      };
      this.#pendingContextSyncs.set(requestId, {
        scopeKey,
        triggerMessageId: descriptor.trigger_message_id,
        ...(descriptor.trigger_seq === undefined ? {} : { triggerSeq: descriptor.trigger_seq }),
        ...(afterSeq === undefined ? {} : { afterSeq }),
        resolve,
        reject,
        timer,
        signal,
        onAbort
      });
      this.#latestContextSyncByScope.set(scopeKey, requestId);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      this.#send("context.sync_request", request);
    } catch {
      this.#resolveContextSync(requestId);
    }
    await wait;
  }

  #resolveContextSync(requestId: string, error?: Error): void {
    const pending = this.#pendingContextSyncs.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    this.#pendingContextSyncs.delete(requestId);
    if (this.#latestContextSyncByScope.get(pending.scopeKey) === requestId) {
      this.#latestContextSyncByScope.delete(pending.scopeKey);
    }
    if (error) pending.reject(error);
    else pending.resolve();
  }

  #usesAppendOnlyDelta(): boolean {
    const options = this.#options.channelContext;
    return options?.store === "sqlite"
      && options.projection === "delta"
      && options.providerPersistence === "append_only";
  }

  #isCurrentLifecycle(epoch: number): boolean {
    return !this.#stopped && epoch === this.#lifecycleEpoch;
  }

  #assertCurrentLifecycle(epoch: number): void {
    if (!this.#isCurrentLifecycle(epoch)) throw new RuntimeStoppingError();
  }

  async #execute(
    command: RuntimeCommand,
    adapterType: string,
    request: InvokeRequest,
    releaseAdmission?: () => void
  ): Promise<void> {
    const store = this.#store;
    if (!store) return;
    let finalText = "";
    let terminal = false;
    let contextSnapshot = this.#contextStore?.markSubmitted(command.run_id);
    let started = false;
    let recoverySessionReported = false;
    const invocationStartedAt = process.hrtime.bigint();
    // Keep execution, invocation, business namespace, and trigger occurrence
    // as distinct correlation domains.
    this.#log({
      level: "info",
      scope: "adapter.invoke",
      event: "adapter.invoke.started",
      message: "adapter invocation started",
      runId: command.run_id,
      invocationId: request.invocationId,
      agentSessionId: request.agentSessionId,
      adapterType,
      data: {
        namespace: stringValue(request.runMetadata?.namespace),
        trigger_kind: stringValue(request.runMetadata?.triggerKind),
        trigger_occurrence_id: stringValue(request.runMetadata?.triggerOccurrenceId)
      }
    });
    const appendStarted = (): void => {
      if (started) return;
      store.allocateAndAppend(command.run_id, "run.started", contextSnapshot
        ? contextEventFields(contextSnapshot)
        : {});
      started = true;
      this.#kickSender();
    };
    try {
      for await (const providerEvent of this.#host.invoke(adapterType, request)) {
        if (this.#authoritativeTerminalRuns.has(command.run_id)) break;
        let event = providerEvent;
        if (event.type === "run.started" || event.type === "run.queued") continue;
        if (contextSnapshot && selectsRecoveryInput(event)) {
          if (started && contextSnapshot.selectedVariant !== "recovery") {
            throw new Error("provider selected channel context recovery after run.started was persisted");
          }
          contextSnapshot = this.#contextStore?.selectRecovery(command.run_id) ?? contextSnapshot;
        }
        if (contextSnapshot?.selectedVariant === "recovery"
          && contextSnapshot.ref.source_session_generation !== undefined
          && !recoverySessionReported
          && event.type === "session.update"
          && stringValue(asRecord(event.payload.providerSession).sessionId)) {
          event = recoverySessionUpdate(event);
          recoverySessionReported = true;
        }
        appendStarted();
        finalText = accumulateFinalText(finalText, event);
        const mapped = mapRuntimeEvent(event);
        this.#log({
          level: "debug",
          scope: "adapter.invoke",
          event: "adapter.event.received",
          message: `adapter emitted ${event.type}`,
          runId: command.run_id,
          invocationId: request.invocationId,
          agentSessionId: request.agentSessionId,
          adapterType,
          data: { canonical_event_type: event.type, outbox_event_type: mapped.type }
        });
        if (contextSnapshot && TERMINAL_OUTBOX_TYPES.has(mapped.type)) {
          Object.assign(mapped.payload, contextEventFields(contextSnapshot));
        }
        // Terminal events bypass soft-watermark backpressure so a Run can still
        // reach durable storage and close out under sustained backpressure.
        if (!TERMINAL_OUTBOX_TYPES.has(mapped.type)) await this.#awaitOutboxCapacity(command.run_id);
        store.allocateAndAppend(command.run_id, mapped.type, mapped.payload);
        terminal ||= TERMINAL_OUTBOX_TYPES.has(mapped.type);
        this.#kickSender();
      }
      this.#log({
        level: terminal ? "info" : "warn",
        scope: "adapter.invoke",
        event: terminal ? "adapter.invoke.completed" : "adapter.invoke.ended_without_terminal",
        message: terminal ? "adapter invocation completed" : "adapter invocation ended without a terminal event",
        runId: command.run_id,
        invocationId: request.invocationId,
        agentSessionId: request.agentSessionId,
        adapterType,
        durationMs: elapsedMilliseconds(invocationStartedAt)
      });
    } catch (error) {
      if (this.#authoritativeTerminalRuns.has(command.run_id)) return;
      if (this.#markStoreUnavailable(error)) return;
      this.#log({
        level: "error",
        scope: "adapter.invoke",
        event: "adapter.invoke.failed",
        message: "adapter invocation failed",
        runId: command.run_id,
        invocationId: request.invocationId,
        agentSessionId: request.agentSessionId,
        adapterType,
        durationMs: elapsedMilliseconds(invocationStartedAt),
        data: { error: errorMessage(error) }
      });
      try {
        appendStarted();
        const payload = {
          ...failurePayload(Object.assign(error instanceof Error ? error : new Error(errorMessage(error)), {
            code: (error as NodeJS.ErrnoException)?.code ?? "ADAPTER_INVOCATION_FAILED",
            adapterType
          }), {
            stage: "adapter.invoke",
            defaultDomain: "adapter",
            runId: command.run_id,
            source: { component: "octo-harness", adapter: adapterType }
          }),
        };
        if (contextSnapshot) Object.assign(payload, contextEventFields(contextSnapshot));
        store.allocateAndAppend(command.run_id, "run.failed", payload);
        this.#kickSender();
      } catch (appendError) {
        this.#markStoreUnavailable(appendError);
        this.#reportError("agent_work.outbox.failure_record_failed", "failed to record run failure", appendError, { run_id: command.run_id });
      }
    } finally {
      // Success remains submitted until the terminal outbox row receives a durable ACK.
      if (!terminal) this.#contextStore?.markFailed(command.run_id);
      this.#activeRuns.delete(command.run_id);
      this.#authoritativeTerminalRuns.delete(command.run_id);
      releaseAdmission?.();
    }
  }

  /** Soft-watermark backpressure: pause reading further events from the provider
   * until the outbox drains below the threshold or the Run ends. */
  async #awaitOutboxCapacity(runId: string): Promise<void> {
    const store = this.#store;
    const softWatermark = this.#options.softWatermarkBytes ?? DEFAULT_SOFT_WATERMARK_BYTES;
    while (store && !this.#stopped && this.#activeRuns.has(runId) && store.outboxBytes() >= softWatermark) {
      await delay(BACKPRESSURE_POLL_MS);
    }
  }

  /** Send unacked events in (run_id, seq) order as run.event_batch frames when
   * connected; on disconnect it waits rather than dropping. Contiguous rows of
   * a single run are coalesced into one batch (the wire transport unit). */
  async #senderLoop(epoch: number): Promise<void> {
    const window = this.#options.sendWindow ?? DEFAULT_SEND_WINDOW;
    while (this.#isCurrentLifecycle(epoch)) {
      const store = this.#store;
      try {
        if (store && this.#connected && this.#socket?.readyState === WebSocket.OPEN) {
          const now = Date.now();
          const rows = store.listSendable(window).filter(row => {
            const retry = this.#nackBackoff.get(row.runId);
            return (!retry || retry.retryAt <= now) && !this.#inFlight.has(`${row.runId}:${row.seq}`);
          });
          for (const batch of coalesceBatches(rows)) {
            if (this.#socket?.readyState !== WebSocket.OPEN) break;
            try {
              this.#send("run.event_batch", {
                run_id: batch.runId,
                first_seq: batch.events[0].seq,
                last_seq: batch.events[batch.events.length - 1].seq,
                events: batch.events.map(row => ({ protocolVersion: 2,
                  event_id: row.eventId,
                  run_id: row.runId,
                  seq: row.seq,
                  type: row.eventType,
                  payload: row.payload,
                  lease_id: row.leaseId,
                  fencing_token: row.fencingToken,
                  occurred_at: new Date(row.createdAt).toISOString()
                }))
              }, batch.events[batch.events.length - 1].seq);
            } catch {
              break;
            }
            for (const row of batch.events) {
              this.#inFlight.add(`${row.runId}:${row.seq}`);
              store.markSent(row.runId, row.seq);
            }
          }
        }
      } catch (error) {
        if (!this.#markStoreUnavailable(error)) {
          this.#reportError("agent_work.outbox.sender_failed", "Agent Work outbox sender failed", error);
        }
      }
      await this.#waitKick(PUMP_POLL_MS);
    }
  }

  #waitKick(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        this.#senderKick = undefined;
        resolve();
      }, ms);
      this.#senderKick = (): void => {
        clearTimeout(timer);
        this.#senderKick = undefined;
        resolve();
      };
    });
  }

  #kickSender(): void {
    this.#senderKick?.();
  }

  #ackCommand(command: RuntimeCommand, accepted: boolean, error?: Record<string, unknown>): void {
    this.#store?.setLastAckedCommandSeq(Math.max(this.#store.lastAckedCommandSeq, command.server_seq));
    this.#trySend("command.ack", {
      command_id: command.command_id,
      server_seq: command.server_seq,
      accepted,
      ...(error ? { error } : {})
    }, undefined, command.server_seq);
  }

  #send(type: string, payload: unknown, seq?: number, ack?: number): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) throw new Error("Agent Work runtime socket is not open");
    const envelopeId = `msg_${randomUUID()}`;
    this.#socket.send(JSON.stringify({
      version: this.#protocolVersion,
      id: envelopeId,
      type,
      runtime_id: this.#runtimeId,
      ...(seq === undefined ? {} : { seq }),
      ...(ack === undefined ? {} : { ack }),
      sent_at: new Date().toISOString(),
      payload
    } satisfies WireEnvelope));
    const payloadRecord = asRecord(payload);
    // As on receive, log the envelope identity and sequencing metadata only.
    // The wire payload is deliberately excluded from normal operational logs.
    this.#log({
      level: "debug",
      scope: "transport.wss",
      event: "transport.message.sent",
      message: "Agent Work WebSocket message sent",
      runId: stringValue(payloadRecord.run_id),
      data: {
        connection_id: this.#connectionId,
        envelope_id: envelopeId,
        frame_type: type,
        command_id: stringValue(payloadRecord.command_id),
        seq,
        ack
      }
    });
  }

  /** Send without throwing (heartbeat/ACK are safe to drop while disconnected;
   * business events are guaranteed by outbox replay). */
  #trySend(type: string, payload: unknown, seq?: number, ack?: number): void {
    try {
      this.#send(type, payload, seq, ack);
    } catch {
      // Ignore: the connection is down; the next connection renegotiates.
    }
  }

  #headers(json: boolean, requestId: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#options.token}`,
      [REQUEST_ID_HEADER]: requestId,
      ...(json ? { "Content-Type": "application/json" } : {})
    };
  }

  #log(input: LogInput): void {
    this.#observability?.log({
      ...input,
      profile: this.#options.profile,
      runtimeId: this.#runtimeId || this.#options.runtimeId,
      data: { ...input.data, ...(this.#options.profile ? { profile: this.#options.profile } : {}) }
    });
  }

  /**
   * Route runtime failures through the protected local log when available.
   * stderr remains a compatibility fallback for embedders that did not supply
   * observability; it receives only the synthesized error message.
   */
  #reportError(
    event: string,
    message: string,
    error: unknown,
    data: Record<string, unknown> = {}
  ): void {
    if (!this.#observability) {
      console.error(`octo-harness ${message}: ${errorMessage(error)}`);
      return;
    }
    this.#observability.log({
      level: "error",
      scope: "agent-work.runtime",
      event,
      message,
      profile: this.#options.profile,
      data: {
        ...data,
        ...(this.#options.profile ? { profile: this.#options.profile } : {}),
        error: errorMessage(error)
      }
    });
  }
}

function elapsedMilliseconds(startedAt: bigint): number {
  return Math.max(0, Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000));
}

/** Accumulate the final-channel assistant text across message events so the
 * terminal outbox event can carry the full reply (deltas concatenate, a full
 * message replaces). Only `final`-channel messages count. */
export function accumulateFinalText(current: string, event: CanonicalEvent): string {
  if (!event.type.startsWith("message.") || (event.payload.channel ?? "final") !== "final") return current;
  const text = stringValue(event.payload.text);
  if (!text) return current;
  if (event.type === "message.delta") return current + text;
  return text;
}

/** Map a control-plane execution envelope into an adapter type + `InvokeRequest`.
 * When a prepared channel-context snapshot is present the prompt is split: a
 * product-visible display prompt plus a `modelInput` that prepends the delta (or
 * the recovery/cold projection as `freshFallbackModelInput`). */
export function mapExecutionEnvelope(
  envelope: ExecutionEnvelope,
  contextSnapshot?: PreparedChannelContextSnapshot,
  taskMaterials?: PreparedTaskMaterials
): { adapterType: string; request: InvokeRequest } {
  assertExecutionEnvelopeContract(envelope);
  if (!envelope?.run_id || !envelope.agent_session_id || !envelope.agent_revision || !envelope.agent_run_request?.input) {
    throw new TypeError("execution envelope is missing run/session/revision/agent run request");
  }
  if (envelope.session_generation !== undefined
    && (!Number.isSafeInteger(envelope.session_generation) || envelope.session_generation < 1)) {
    throw new TypeError("execution envelope session_generation must be a positive safe integer");
  }
  if (envelope.provider_epoch !== undefined
    && (!Number.isSafeInteger(envelope.provider_epoch) || envelope.provider_epoch < 1)) {
    throw new TypeError("execution envelope provider_epoch must be a positive safe integer");
  }
  if (envelope.continuity_mode !== undefined
    && envelope.continuity_mode !== "continue" && envelope.continuity_mode !== "fresh") {
    throw new TypeError("execution envelope continuity_mode must be continue or fresh");
  }
  if (envelope.continuity_mode === "fresh" && envelope.provider_session) {
    throw new TypeError("fresh execution envelope must not carry provider_session");
  }
  const profile = executionProfile(envelope);
  const definition = asRecord(envelope.agent_revision.definition);
  const adapterType = executionAdapterType(envelope);
  const agentConfig: AgentConfig = {
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.effort ? { effort: profile.effort } : {})
  };
  const runtimeLimits = mapExecutionRuntimeLimits(profile.runtime_limits);
  const mcpServers = mapExecutionMcpServers(profile.mcp_servers);
  const workdir = profile.workdir;
  const content = envelope.agent_run_request.input;
  if (Object.hasOwn(content, "context_refs") || Object.hasOwn(content, "channel_context")) throw new TypeError("LEGACY_CONTEXT_INPUT_REJECTED");
  const compiled = compileRunContext(envelope.effective_context, taskMaterials?.selections);
  if (contextItem(envelope.effective_context, "octo.content", "continuity") && !contextSnapshot) throw new TypeError("CONTEXT_CONTINUITY_UNAVAILABLE");
  const displayPrompt = renderDisplayExecutionInputPrompt(content);
  const modelContext = (text: string): string => [text, compiled.modelContent].filter(Boolean).join("\n\n");
  const contextHasImages = (facts: PreparedChannelContextSnapshot["facts"]): boolean => facts.some(fact => fact.parts.some(part => part.type === "image"));
  if (contextSnapshot && contextHasImages(contextSnapshot.selectedVariant === "recovery" ? contextSnapshot.recoveryFacts : contextSnapshot.facts)) {
    throw new TypeError("ARTIFACT_UNAVAILABLE: channel context images have no authorized materialized source");
  }
  const primaryContext = contextSnapshot ? modelContext(contextSnapshot.selectedVariant === "recovery"
    ? contextSnapshot.recoveryRenderedText : contextSnapshot.renderedText) : compiled.modelContent;
  const reply = asRecord(content.reply_to);
  const quotedText = stringValue(reply.text) ? `[Quoted message from ${stringValue(reply.author_name) ?? stringValue(reply.author_id) ?? "unknown"}]\n${stringValue(reply.text)}` : "";
  const imageParts = modelPartsFromInput(content, [primaryContext, quotedText, "[Current message]"].filter(Boolean).join("\n\n"));
  const recoveryParts = contextSnapshot ? modelPartsFromInput(content, [modelContext(contextSnapshot.recoveryRenderedText), quotedText, "[Current message]"].filter(Boolean).join("\n\n")) : undefined;
  const context = {
    schemaVersion: envelope.schema_version,
    namespace: envelope.agent_run_request.namespace,
    agentId: envelope.agent_run_request.agent_id,
    agentRevisionId: envelope.agent_run_request.agent_revision_id,
    sessionKey: envelope.agent_run_request.session_key,
    triggerKind: envelope.agent_run_request.trigger.kind,
    triggerOccurrenceId: envelope.agent_run_request.trigger.occurrence_id,
    input: imageParts ? {
      ...content,
      parts: (content.parts as Record<string, unknown>[]).map(part => {
        const metadata = { ...part };
        delete metadata.source;
        return metadata;
      })
    } : content,
    ...(envelope.session_generation === undefined ? {} : { sessionGeneration: envelope.session_generation }),
    ...(envelope.provider_epoch === undefined ? {} : { providerEpoch: envelope.provider_epoch }),
    ...(envelope.continuity_mode === undefined ? {} : { continuityMode: envelope.continuity_mode }),
    ...(contextSnapshot ? { contextSnapshot: contextSnapshot.ref } : {}),
    ...(taskMaterials ? { taskMaterials: structuredClone(taskMaterials.refs) } : {})
  };
  return {
    adapterType,
    request: { protocolVersion: 2,
      invocationId: `invoke_${randomUUID()}`,
      agentSessionId: envelope.agent_session_id,
      runId: envelope.run_id,
      ...(envelope.session_generation === undefined ? {} : { sessionGeneration: envelope.session_generation }),
      ...(envelope.provider_epoch === undefined ? {} : { providerEpoch: envelope.provider_epoch }),
      ...(envelope.continuity_mode === undefined ? {} : { continuityMode: envelope.continuity_mode }),
      prompt: displayPrompt,
      modelInput: composeProviderModelInput(compiled.modelContent, displayPrompt),
      ...(imageParts ? { modelInputParts: imageParts } : {}),
      ...(recoveryParts ? { freshFallbackModelInputParts: recoveryParts } : {}),
      ...(contextSnapshot && contextHasImages(contextSnapshot.recoveryFacts) ? { freshFallbackImagesUnavailable: true } : {}),
      ...(contextSnapshot ? {
        modelInput: composeProviderModelInput(
          modelContext(contextSnapshot.selectedVariant === "recovery"
            ? contextSnapshot.recoveryRenderedText
            : contextSnapshot.renderedText),
          displayPrompt
        ),
        freshFallbackModelInput: composeProviderModelInput(modelContext(contextSnapshot.recoveryRenderedText), displayPrompt),
        contextSnapshot: contextSnapshot.ref
      } : {}),
      workdir,
      controlInstructions: [stringValue(definition.instructions), compiled.controlInstructions].filter(Boolean).join("\n\n"),
      context: structuredClone(envelope.effective_context),
      runMetadata: context,
      approvalMode: profile.approval_mode,
      ...(mcpServers ? { mcpServers } : {}),
      ...(envelope.provider_session && contextSnapshot?.selectedVariant !== "recovery"
        ? { providerSession: envelope.provider_session }
        : {}),
      ...(Object.keys(runtimeLimits).length > 0 ? { runtimeLimits } : {}),
      agentConfig: { ...agentConfig, workdir }
    }
  };
}

function mapExecutionMcpServers(value: unknown): McpServers | undefined {
  if (value === undefined || value === null) return undefined;
  assertMcpServers(value);
  if (Object.keys(value).length === 0) return undefined;
  // The execution envelope remains an immutable dispatch fact. Clone the
  // validated scalar-only contract before adapter-specific materialization.
  return structuredClone(value);
}

function assertExecutionEnvelopeContract(envelope: ExecutionEnvelope): void {
  if (envelope?.schema_version !== 3) throw new TypeError("LEGACY_RUN_CONTRACT_REJECTED");
  assertContextEnvelope(envelope.agent_run_request?.context);
  assertContextEnvelope(envelope.effective_context);
  assertResolvedExecutionPlan(envelope.resolved_execution_plan);
  assertResolvedRuntimeSelection(envelope.resolved_runtime_selection);
  assertFrozenContextPlan(envelope.effective_context, envelope.resolved_execution_plan);
  if (!Number.isSafeInteger(envelope.context_defaults_version) || envelope.context_defaults_version < 1) throw new TypeError("CONTEXT_DEFAULTS_VERSION_REQUIRED");
  const contextSelection = contextItem(envelope.effective_context, "octo.runtime", "selection")?.payload;
  const selection = envelope.resolved_runtime_selection;
  if (contextSelection && (contextSelection.mode !== selection.selection_mode
    || (contextSelection.mode === "explicit" && contextSelection.runtime_id !== selection.explicit_runtime_id))) {
    throw new TypeError("RUNTIME_SELECTION_CONTEXT_MISMATCH");
  }
}

function executionAdapterType(envelope: ExecutionEnvelope): string {
  const profile = executionProfile(envelope);
  return profile.adapter_type;
}

function executionProfile(envelope: ExecutionEnvelope): ResolvedExecutionPlan {
  assertResolvedExecutionPlan(envelope.resolved_execution_plan);
  return envelope.resolved_execution_plan;
}

function mapExecutionRuntimeLimits(value: unknown): Record<string, unknown> {
  const limits = asRecord(value);
  const mapped: Record<string, unknown> = {};
  for (const [source, target] of [
    ["first_frame_timeout_ms", "firstFrameTimeoutMs"],
    ["model_idle_timeout_ms", "modelIdleTimeoutMs"],
    ["model_idle_warning_ms", "modelIdleWarningMs"],
    ["model_idle_policy", "modelIdlePolicy"],
    ["tool_timeout_ms", "toolTimeoutMs"],
    ["tool_wall_timeout_ms", "toolWallTimeoutMs"],
    ["run_timeout_ms", "runTimeoutMs"],
    ["cancel_grace_ms", "cancelGraceMs"],
    ["enforcement", "enforcement"]
  ] as const) {
    if (limits[source] !== undefined) mapped[target] = limits[source];
  }
  return mapped;
}

function httpEndpointMetadata(baseUrl: string): Record<string, string> {
  const url = new URL(`${stripSlash(baseUrl)}/v1/runtime/register`);
  return {
    scheme: url.protocol.slice(0, -1),
    host: url.hostname,
    port: url.port || (url.protocol === "https:" ? "443" : "80"),
    path: url.pathname
  };
}

/** Return only support-safe WSS location fields; credentials and query are omitted. */
function webSocketEndpointMetadata(url: URL): Record<string, string> {
  return {
    scheme: url.protocol.slice(0, -1),
    host: url.hostname,
    port: url.port || (url.protocol === "wss:" ? "443" : "80"),
    path: url.pathname
  };
}

/** Render the full immutable execution input (current prompt/parts, recent group
 * messages and any quoted message) into a single prompt. Used when no channel
 * context snapshot drives the model input. */
export function renderAgentRunInputPrompt(content: Record<string, unknown> | undefined): string {
  const input = asRecord(content);
  const current = executionInputText(input);
  const blocks: string[] = [];
  const contextRefs = Array.isArray(input.context_refs) ? input.context_refs : [];
  const recent = contextRefs.flatMap((ref): unknown[] => {
    const value = asRecord(ref);
    return value.kind === "recent_group" && Array.isArray(value.messages)
      ? value.messages as unknown[]
      : [];
  });
  if (recent.length > 0) {
    blocks.push("[Recent group messages]\n" + recent.map(message => {
      const value = asRecord(message);
      const author = stringValue(value.author_name) ?? stringValue(value.author_id) ?? "unknown";
      return `${author}: ${stringValue(value.text) ?? ""}`;
    }).join("\n"));
  }
  const reply = asRecord(input.reply_to);
  if (stringValue(reply.text)) {
    blocks.push(`[Quoted message from ${stringValue(reply.author_name) ?? stringValue(reply.author_id) ?? "unknown"}]\n${stringValue(reply.text)}`);
  }
  blocks.push(`[Current message]\n${current}`);
  return blocks.join("\n\n");
}

/** Render the product-visible current turn without context-only channel facts. */
export function renderDisplayExecutionInputPrompt(content: Record<string, unknown> | undefined): string {
  const input = asRecord(content);
  const current = executionInputText(input);
  const blocks: string[] = [];
  const reply = asRecord(input.reply_to);
  if (stringValue(reply.text)) {
    blocks.push(`[Quoted message from ${stringValue(reply.author_name) ?? stringValue(reply.author_id) ?? "unknown"}]\n${stringValue(reply.text)}`);
  }
  blocks.push(`[Current message]\n${current}`);
  return blocks.join("\n\n");
}

function executionInputText(input: Record<string, unknown>): string {
  const parts = Array.isArray(input.parts) ? input.parts : [];
  const partsText = parts.map(part => {
    const value = asRecord(part);
    return value.type === "text" && typeof value.text === "string" ? value.text : "";
  }).filter(Boolean).join("\n");
  return partsText || stringValue(input.prompt) || "";
}

function rawDataText(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

/** Translate a canonical event into an outbox wire event: terminal run states are
 * renamed to the Agent Work vocabulary (completed/failed/cancelled) and carry the
 * accumulated final text; all other events pass through unchanged. */
export function mapRuntimeEvent(event: CanonicalEvent): { protocolVersion: 2; type: string; payload: Record<string, unknown> } {
  const payload = event.type === "run.completed" ? {} : event.type === "run.failed" ? { failure: event.payload.failure } : event.type === "run.cancelled" ? { reasonCode: "cancelled" } : event.payload;
  return { protocolVersion: 2, type: event.type, payload };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown, name: string): string {
  const result = stringValue(value);
  if (!result) throw new TypeError(`${name} must be a non-empty string`);
  return result;
}

function requiredSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
  return Number(value);
}

function matchesPendingContextSync(pending: PendingContextSync, result: ContextSyncResult): boolean {
  if (channelScopeKey(result.scope) !== pending.scopeKey) return false;
  if (result.facts.some(fact => fact.message_id === pending.triggerMessageId)) return false;
  if (pending.triggerSeq !== undefined) {
    if (result.through_seq !== undefined && result.through_seq >= pending.triggerSeq) return false;
    if (result.facts.some(fact => fact.message_seq !== undefined && fact.message_seq >= pending.triggerSeq!)) return false;
  }
  if (pending.afterSeq !== undefined) {
    if (result.through_seq !== undefined && result.through_seq < pending.afterSeq) return false;
    if (result.facts.some(fact => fact.message_seq !== undefined && fact.message_seq <= pending.afterSeq!)) return false;
  }
  return true;
}

function selectsRecoveryInput(event: CanonicalEvent): boolean {
  if (event.type !== "session.update") return false;
  const providerSession = asRecord(event.payload.providerSession);
  return providerSession.resumeOutcome === "fresh_fallback"
    && providerSession.contextInputVariant === "recovery";
}

/** Mark a preselected cold session so Agent Worker advances the context epoch
 * exactly as it does for a provider-reported resume fallback. */
function recoverySessionUpdate(
  event: Extract<CanonicalEvent, { type: "session.update" }>
): Extract<CanonicalEvent, { type: "session.update" }> {
  const providerSession = asRecord(event.payload.providerSession);
  const sessionId = stringValue(providerSession.sessionId);
  if (!sessionId) return event;
  return { protocolVersion: 2,
    type: "session.update",
    payload: {
      ...event.payload,
      providerSession: {
        ...providerSession,
        sessionId,
        resumeOutcome: "fresh_fallback",
        contextInputVariant: "recovery"
      }
    }
  };
}

function contextEventFields(snapshot: PreparedChannelContextSnapshot): Record<string, unknown> {
  const recovery = snapshot.selectedVariant === "recovery";
  return {
    context_snapshot_id: snapshot.ref.snapshot_id,
    context_snapshot_sha256: recovery
      ? snapshot.ref.recovery_rendered_sha256
      : snapshot.ref.rendered_sha256,
    context_completeness: recovery
      ? snapshot.recoveryCompleteness
      : snapshot.ref.completeness,
    context_input_variant: recovery ? "recovery" : "delta",
    context_session_generation: snapshot.ref.session_generation,
    ...(snapshot.ref.source_session_generation === undefined
      ? {}
      : { context_source_session_generation: snapshot.ref.source_session_generation })
  };
}

class RuntimeStoppingError extends Error {
  constructor() {
    super("Agent Work runtime is stopping");
    this.name = "RuntimeStoppingError";
  }
}

class RuntimeIdentityMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeIdentityMismatchError";
  }
}

class RuntimeCredentialRejectedError extends Error {
  constructor(readonly status: number, readonly attempt: number) {
    super(`Agent Work runtime credential was rejected (${status}); consecutive failure ${attempt}`);
    this.name = "RuntimeCredentialRejectedError";
  }
}

class RuntimeRecoverySignal extends Error {
  constructor(readonly reason: "network_change" | "system_resume" | "clock_change") {
    super(`Agent Work fast recovery requested after ${reason}`);
    this.name = "RuntimeRecoverySignal";
  }
}

class AuthoritativeTerminalRunError extends Error {
  constructor(readonly runId: string, readonly status: string) {
    super(`Run ${runId} is already authoritatively ${status}`);
    this.name = "AuthoritativeTerminalRunError";
  }
}

class AcceptingRunCancelledError extends Error {
  constructor() {
    super("run cancelled before provider invocation");
    this.name = "AcceptingRunCancelledError";
  }
}

class ProviderConfigurationMissingError extends Error {
  constructor(readonly adapterType: string) {
    super(`Provider configuration is unavailable for adapter ${adapterType}`);
    this.name = "ProviderConfigurationMissingError";
  }
}

function acceptingAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new AcceptingRunCancelledError();
}

function throwIfAcceptingAborted(signal: AbortSignal): void {
  if (signal.aborted) throw acceptingAbortError(signal);
}

function stripSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function reconnectRuntimeDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new RuntimeStoppingError();
}

function localNetworkFingerprint(): string {
  return Object.entries(networkInterfaces())
    .flatMap(([name, addresses]) => (addresses ?? [])
      .filter(address => !address.internal)
      .map(address => `${name}:${address.family}:${address.address}:${address.scopeid ?? 0}`))
    .sort()
    .join("|");
}

/** Keep one fast recovery attempt for isolated network blips. If that fails,
 * full-jitter exponential backoff spreads a fleet reconnect wave. */
export function reconnectDelayMs(
  attempt: number,
  minimumMs = DEFAULT_RECONNECT_MIN_MS,
  maximumMs = DEFAULT_RECONNECT_MAX_MS,
  random = Math.random,
  firstMs = DEFAULT_RECONNECT_FIRST_MS
): number {
  if (Math.trunc(attempt) <= 1) return firstMs;
  const exponent = Math.max(1, Math.min(30, Math.trunc(attempt) - 1));
  const ceiling = Math.min(maximumMs, minimumMs * (2 ** exponent));
  const jitterRange = Math.max(0, ceiling - minimumMs);
  return minimumMs + Math.floor(Math.max(0, Math.min(0.999999999, random())) * jitterRange);
}

/** A server drain hint is a reconnect floor, not an exact fleet-wide deadline.
 * Add bounded jitter so a large Runtime population does not reconnect together. */
export function reconnectDelayWithServerHintMs(
  clientDelayMs: number,
  serverRetryAfterMs: number | undefined,
  random = Math.random
): number {
  if (typeof serverRetryAfterMs !== "number" || !Number.isSafeInteger(serverRetryAfterMs) || serverRetryAfterMs < 1) {
    return clientDelayMs;
  }
  const floor = Math.max(clientDelayMs, serverRetryAfterMs);
  const jitterRange = Math.min(serverRetryAfterMs, MAX_SERVER_RECONNECT_JITTER_MS);
  return floor + Math.floor(Math.max(0, Math.min(0.999999999, random())) * jitterRange);
}

/** Stable transport reason used by status, local metrics and support bundles. */
export function connectionFailureReason(error: unknown): RuntimeConnectionReason {
  if (error instanceof RuntimeCredentialRejectedError) return "auth";
  const code = typeof (error as NodeJS.ErrnoException | undefined)?.code === "string"
    ? (error as NodeJS.ErrnoException).code ?? ""
    : "";
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA"].includes(code)) return "dns";
  if (code.startsWith("ERR_TLS_") || code.startsWith("CERT_") || [
    "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "ERR_SSL_WRONG_VERSION_NUMBER"
  ].includes(code)) return "tls";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("receive timed out") || message.includes("receive timeout")) return "receive_timeout";
  return "transport";
}

/** Compare wall and monotonic elapsed time so a clock correction is not
 * mistaken for an ordinary event-loop delay or device resume. */
export function clockChanged(wallElapsedMs: number, monotonicElapsedMs: number, thresholdMs: number): boolean {
  if (![wallElapsedMs, monotonicElapsedMs, thresholdMs].every(Number.isFinite) || thresholdMs < 0) return false;
  return Math.abs(wallElapsedMs - monotonicElapsedMs) > thresholdMs;
}

function packageVersion(): string {
  const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  if (typeof metadata.version !== "string" || !metadata.version.trim()) {
    throw new Error("Octo Harness package version is missing");
  }
  return metadata.version;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAcceptingAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(acceptingAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function storageErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && code.length > 0 ? code : "LOCAL_STORE_UNAVAILABLE";
}

function isStorageCapacityError(error: unknown): boolean {
  const code = storageErrorCode(error);
  return code === "ENOSPC" || code === "EDQUOT" || code === "SQLITE_FULL"
    || /database or disk is full|no space left on device|disk quota exceeded/i.test(errorMessage(error));
}

function sameStoreHealth(left: RuntimeStoreHealth, right: RuntimeStoreHealth): boolean {
  return left.state === right.state
    && left.acceptingNewRuns === right.acceptingNewRuns
    && left.minimumFreeBytes === right.minimumFreeBytes
    && left.errorCode === right.errorCode;
}

interface EventBatch {
  runId: string;
  events: OutboxRow[];
}

/** Group ordered outbox rows into contiguous per-run batches. A batch breaks on
 * a run change or a seq gap so each frame carries a single run with a contiguous
 * first_seq..last_seq range, matching the run.event_batch wire contract. */
function coalesceBatches(rows: OutboxRow[]): EventBatch[] {
  const batches: EventBatch[] = [];
  let current: EventBatch | undefined;
  for (const row of rows) {
    const last = current?.events[current.events.length - 1];
    const contiguous = current !== undefined && last !== undefined && last.runId === row.runId && row.seq === last.seq + 1;
    if (!contiguous) {
      current = { runId: row.runId, events: [] };
      batches.push(current);
    }
    current!.events.push(row);
  }
  return batches;
}

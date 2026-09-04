import { randomUUID } from "node:crypto";
import { hostname, platform, arch } from "node:os";
import WebSocket from "ws";
import type { AdapterHostRpcClient } from "@mininglamp-oss/octo-harness-adapter-host";
import type {
  AgentConfig,
  CanonicalEvent,
  ChannelContextDescriptor,
  ContextSyncRequest,
  ContextSyncResult,
  InvokeRequest,
  ProviderSession
} from "@mininglamp-oss/octo-harness-protocol";
import {
  assertChannelContextAppend,
  assertChannelContextDescriptor,
  assertContextSyncResult
} from "@mininglamp-oss/octo-harness-protocol";
import { AgentWorkStore } from "./agent-work-store.js";
import type { OutboxRow } from "./agent-work-store.js";
import {
  ChannelContextStore,
  ChannelContextConsumerBusyError,
  channelScopeKey,
  composeProviderModelInput,
  type ChannelContextStoreOptions,
  type PreparedChannelContextSnapshot
} from "./channel-context-store.js";

const PROTOCOL_VERSION = 1;
const DEFAULT_SEND_WINDOW = 32;
const DEFAULT_SOFT_WATERMARK_BYTES = 512 * 1024 * 1024;
const DEFAULT_HARD_WATERMARK_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_RECONCILE_MS = 5 * 60_000;
const PUMP_POLL_MS = 50;
const BACKPRESSURE_POLL_MS = 100;
const DEFAULT_CONTEXT_SYNC_TIMEOUT_MS = 3_000;
const DEFAULT_CONTEXT_SYNC_LIMIT = 40;
const CONTEXT_BUSY_POLL_MS = 25;
/** 终态事件必须能落盘收尾，不受软水位背压阻塞。 */
const TERMINAL_OUTBOX_TYPES = new Set(["run.completed", "run.failed", "run.cancelled"]);

export interface AgentWorkRuntimeOptions {
  baseUrl: string;
  token: string;
  tenantId: string;
  subjectId: string;
  runtimeId?: string;
  runtimeName: string;
  fingerprint: string;
  reconnectMs?: number;
  /** 本地 Outbox 数据库路径；缺省由 daemon 解析。 */
  storePath: string;
  /** 单次可在途发送的事件数上限。 */
  sendWindow?: number;
  /** 软水位：达到后停止接收新 Run 并暂停 provider 读取形成背压。 */
  softWatermarkBytes?: number;
  /** 硬水位：仅用于高优告警，未 ACK 数据仍不删除。 */
  hardWatermarkBytes?: number;
  reconcileMs?: number;
  channelContext?: ChannelContextRuntimeOptions;
}

export interface ChannelContextRuntimeOptions extends ChannelContextStoreOptions {
  store: "memory" | "sqlite";
  projection: "window" | "delta";
  providerPersistence: "ephemeral" | "append_only";
  storePath: string;
  syncTimeoutMs?: number;
}

export interface ExecutionEnvelope {
  schema_version: number;
  run_id: string;
  harness_session_id: string;
  provider_session?: ProviderSession;
  execution_request: {
    id: string;
    agent_id: string;
    agent_revision_id: string;
    source_type: string;
    source_id: string;
    policy?: Record<string, unknown>;
    delivery_context?: Record<string, unknown>;
  };
  agent_revision: {
    definition?: Record<string, unknown>;
    execution_profile?: Record<string, unknown>;
  };
  immutable_execution_input: {
    content?: Record<string, unknown>;
  };
}

interface RuntimeCommand {
  server_seq: number;
  command_id: string;
  run_id: string;
  type: "run.start" | "run.cancel" | "run.steer";
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

interface PendingContextSync {
  scopeKey: string;
  triggerMessageId: string;
  triggerSeq?: number;
  afterSeq?: number;
  resolve: () => void;
  timer: NodeJS.Timeout;
}

export class AgentWorkRuntime {
  readonly #options: AgentWorkRuntimeOptions;
  readonly #host: AdapterHostRpcClient;
  readonly #activeRuns = new Map<string, ActiveRun>();
  readonly #acceptingCommandIds = new Set<string>();
  readonly #acceptingRunIds = new Set<string>();
  /** 本连接内已发出、等待 ACK 的 `${runId}:${seq}`；重连时清空以触发重放。 */
  readonly #inFlight = new Set<string>();
  readonly #pendingContextSyncs = new Map<string, PendingContextSync>();
  readonly #latestContextSyncByScope = new Map<string, string>();
  #store?: AgentWorkStore;
  #contextStore?: ChannelContextStore;
  #runtimeId = "";
  #socket?: WebSocket;
  #heartbeat?: NodeJS.Timeout;
  #reconcileTimer?: NodeJS.Timeout;
  #loop?: Promise<void>;
  #pump?: Promise<void>;
  #senderKick?: () => void;
  #stopped = true;
  #connected = false;

  constructor(options: AgentWorkRuntimeOptions, host: AdapterHostRpcClient) {
    this.#options = options;
    this.#host = host;
  }

  get status(): Record<string, unknown> {
    const store = this.#store;
    const contextStats = this.#contextStore?.stats();
    return {
      enabled: true,
      connected: this.#connected,
      runtimeId: this.#runtimeId || this.#options.runtimeId,
      activeRuns: this.#activeRuns.size,
      lastAckedCommandSeq: store?.lastAckedCommandSeq ?? 0,
      outboxPendingBytes: store?.outboxBytes() ?? 0,
      outboxPending: store?.pendingCount() ?? 0,
      outboxOldestAgeMs: store?.oldestUnackedAgeMs() ?? null,
      dbBytes: store?.dbBytes() ?? 0,
      walBytes: store?.walBytes() ?? 0,
      channelContext: {
        store: this.#options.channelContext?.store ?? "memory",
        projection: this.#options.channelContext?.projection ?? "window",
        providerPersistence: this.#options.channelContext?.providerPersistence ?? "ephemeral",
        scopes: contextStats?.scopes ?? 0,
        messages: contextStats?.messages ?? 0,
        snapshots: contextStats?.snapshots ?? 0,
        activeSnapshots: contextStats?.activeSnapshots ?? 0,
        dbBytes: contextStats?.dbBytes ?? 0,
        walBytes: contextStats?.walBytes ?? 0
      }
    };
  }

  async start(): Promise<void> {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#store = AgentWorkStore.open(this.#options.storePath);
    if (this.#options.channelContext?.store === "sqlite") {
      this.#contextStore = ChannelContextStore.open(
        this.#options.channelContext.storePath,
        this.#options.channelContext
      );
    }
    this.#runtimeId = this.#options.runtimeId ?? await this.#register();
    await this.#connect();
    this.#loop = this.#readLoop();
    this.#pump = this.#senderLoop();
    const reconcileMs = this.#options.reconcileMs ?? DEFAULT_RECONCILE_MS;
    this.#reconcileTimer = setInterval(() => {
      try {
        this.#store?.reconcile();
        this.#contextStore?.reconcile();
      } catch (error) {
        console.error(`octo-harness Agent Work outbox reconcile failed: ${errorMessage(error)}`);
      }
    }, reconcileMs);
  }

  async close(): Promise<void> {
    this.#stopped = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    if (this.#reconcileTimer) clearInterval(this.#reconcileTimer);
    this.#reconcileTimer = undefined;
    this.#kickSender();
    for (const run of this.#activeRuns.values()) {
      await this.#host.cancel(run.invocationId, "runtime shutdown").catch(() => undefined);
    }
    this.#socket?.close(1000, "runtime shutdown");
    for (const pending of this.#pendingContextSyncs.values()) {
      clearTimeout(pending.timer);
      pending.resolve();
    }
    this.#pendingContextSyncs.clear();
    this.#latestContextSyncByScope.clear();
    await this.#loop?.catch(() => undefined);
    await this.#pump?.catch(() => undefined);
    // 未 ACK 事件留在 Outbox，重启后重放；这里只释放连接与句柄。
    this.#store?.close();
    this.#store = undefined;
    this.#contextStore?.close();
    this.#contextStore = undefined;
  }

  async #register(): Promise<string> {
    const response = await fetch(`${stripSlash(this.#options.baseUrl)}/api/v1/runtimes/register`, {
      method: "POST",
      headers: this.#headers(true),
      body: JSON.stringify({
        kind: "local",
        name: this.#options.runtimeName,
        device: {
          fingerprint: this.#options.fingerprint,
          os: platform(),
          arch: arch(),
          hostname: hostname()
        },
        runtime_version: "0.1.0",
        protocol_version: PROTOCOL_VERSION,
        capabilities: {
          adapters: (await this.#host.list()).map(item => item.type),
          channel_context: {
            protocol_version: 1,
            store: this.#options.channelContext?.store ?? "memory",
            projection: this.#options.channelContext?.projection ?? "window",
            provider_persistence: this.#options.channelContext?.providerPersistence ?? "ephemeral"
          }
        }
      })
    });
    const body = await response.json() as { runtime?: { id?: string }; error?: { message?: string } };
    if (!response.ok || !body.runtime?.id) {
      throw new Error(`Agent Work runtime registration failed (${response.status}): ${body.error?.message ?? "invalid response"}`);
    }
    return body.runtime.id;
  }

  async #connect(): Promise<void> {
    const url = new URL(`${stripSlash(this.#options.baseUrl)}/api/v1/runtimes/connect`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, { headers: this.#headers(false) });
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        socket.off("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        socket.off("open", onOpen);
        reject(error);
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
    });
    this.#socket = socket;
    this.#send("runtime.hello", {
      last_acked_command_seq: this.#store?.lastAckedCommandSeq ?? 0,
      active_run_ids: this.#store?.activeRunIds() ?? [],
      runtime_version: "0.1.0"
    });
  }

  async #readLoop(): Promise<void> {
    while (!this.#stopped) {
      const socket = this.#socket;
      if (socket) {
        try {
          await this.#waitForDisconnect(socket);
        } catch (error) {
          console.error(`octo-harness Agent Work runtime connection failed: ${errorMessage(error)}`);
        }
        if (this.#socket === socket) this.#socket = undefined;
      }
      this.#connected = false;
      if (this.#heartbeat) clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
      // 断线不丢事件：清空在途标记，重连后从最小未确认 seq 全部重放。
      this.#inFlight.clear();
      if (this.#stopped) return;
      while (!this.#stopped && !this.#socket) {
        await delay(this.#options.reconnectMs ?? 1_000);
        try {
          await this.#connect();
        } catch (error) {
          console.error(`octo-harness Agent Work runtime reconnect failed: ${errorMessage(error)}`);
        }
      }
    }
  }

  #waitForDisconnect(socket: WebSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
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
      const onMessage = (data: WebSocket.RawData): void => {
        void (async () => {
          const envelope = JSON.parse(rawDataText(data)) as WireEnvelope;
          await this.#receive(envelope);
        })().catch((error: unknown) => {
          socket.terminate();
          settle(error instanceof Error ? error : new Error(String(error)));
        });
      };
      const onClose = (): void => settle();
      const onError = (error: Error): void => settle(error);
      socket.on("message", onMessage);
      socket.once("close", onClose);
      socket.once("error", onError);
    });
  }

  async #receive(envelope: WireEnvelope): Promise<void> {
    if (envelope.version !== PROTOCOL_VERSION) throw new Error(`unsupported Agent Work protocol ${envelope.version}`);
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
      // received ACK only proves that the previous Worker process held the
      // batch in memory. A new socket may point at a restarted Worker, so the
      // local Outbox must replay every row not covered by durable ACK.
      this.#store?.prepareReplayAfterReconnect();
      this.#connected = true;
      if (this.#heartbeat) clearInterval(this.#heartbeat);
      this.#heartbeat = setInterval(() => this.#trySend("runtime.heartbeat", { runtime_version: "0.1.0" }), everyMs);
      // 连接就绪后立刻排空 Outbox（含断线期间积压的事件）。
      this.#kickSender();
      return;
    }
    if (envelope.type === "runtime.command") {
      await this.#acceptCommand(envelope.payload as RuntimeCommand);
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
            console.error(`octo-harness Agent Work runtime rejected out-of-range received ACK run=${runId} seq=${received}`);
          }
          const prefix = `${runId}:`;
          for (const key of [...this.#inFlight]) {
            if (key.startsWith(prefix) && Number(key.slice(prefix.length)) <= received) this.#inFlight.delete(key);
          }
        }
        // durable_through_seq: aggregated state committed cloud-side — only now
        // may confirmed outbox rows be deleted.
        if (Number.isFinite(durable) && durable > 0) {
          const inspection = store.inspectDurableAck(runId, durable);
          if (inspection.advanced) {
            let contextCommitted = true;
            if (inspection.terminal?.type === "run.completed") {
              const result = this.#contextStore?.getSnapshot(runId)
                ? this.#contextStore.commitSnapshot(runId)
                : undefined;
              if (result && !result.committed) {
                console.error(`channel context cursor commit rejected run=${runId} reason=${result.reason}`);
                contextCommitted = false;
              }
            } else if (inspection.terminal) {
              this.#contextStore?.markFailed(runId);
            }
            // Commit context first: if it fails, leave terminal in the outbox so
            // the durable ACK can be replayed after reconnect. Both operations are idempotent.
            if (contextCommitted) store.advanceDurable(runId, durable);
          } else if (inspection.reason === "ack_beyond_produced") {
            console.error(`octo-harness Agent Work runtime rejected out-of-range durable ACK run=${runId} seq=${durable}`);
          }
        }
        // ACK released capacity and may unblock more sendable rows.
        this.#kickSender();
      }
      return;
    }
    if (envelope.type === "event.nack") {
      // Peer asked us to pause and resume from a known-good seq; the sender
      // reloads from listSendable on the next kick, so just log and continue.
      const payload = asRecord(envelope.payload);
      console.error(`octo-harness Agent Work runtime received NACK run=${String(payload.run_id)} code=${String(payload.code)} resume_from=${String(payload.resume_from_seq)}`);
      return;
    }
    if (envelope.type === "error") {
      const payload = asRecord(envelope.payload);
      throw new Error(`Agent Work protocol error ${String(payload.code)}: ${String(payload.message)}`);
    }
  }

  async #acceptCommand(command: RuntimeCommand): Promise<void> {
    if (!command?.command_id || !command.run_id || !command.type) throw new Error("invalid runtime.command payload");
    const store = this.#store;
    if (!store) throw new Error("Agent Work runtime store is not open");
    if (command.type === "run.cancel") {
      const active = this.#activeRuns.get(command.run_id);
      const cancelled = active ? (await this.#host.cancel(active.invocationId, "control plane cancel")).cancelled : false;
      if (!active) this.#contextStore?.markFailed(command.run_id);
      this.#ackCommand(command, true, cancelled ? undefined : { code: "RUN_NOT_ACTIVE" });
      return;
    }
    if (command.type !== "run.start") {
      this.#ackCommand(command, false, { code: "UNSUPPORTED_COMMAND", message: command.type });
      return;
    }
    // 重启后仍能去重：同一 command_id 直接回放已保存结果，不重复执行。
    const receipt = store.getCommandReceipt(command.command_id);
    if (receipt) {
      this.#ackCommand(command, receipt.accepted, receipt.error);
      return;
    }
    // 软水位背压：拒绝新 Run，让已有 Outbox 先排空；未 ACK 数据不删除。
    const softWatermark = this.#options.softWatermarkBytes ?? DEFAULT_SOFT_WATERMARK_BYTES;
    const hardWatermark = this.#options.hardWatermarkBytes ?? DEFAULT_HARD_WATERMARK_BYTES;
    const pendingBytes = store.outboxBytes();
    if (pendingBytes >= hardWatermark) {
      console.error(`octo-harness Agent Work outbox above hard watermark: ${pendingBytes} bytes (limit ${hardWatermark})`);
    }
    if (pendingBytes >= softWatermark) {
      const error = { code: "OUTBOX_BACKPRESSURE", message: "local outbox above soft watermark" };
      store.recordCommandReceipt(command.command_id, command.server_seq, false, error);
      this.#ackCommand(command, false, error);
      return;
    }
    if (this.#activeRuns.has(command.run_id)) {
      this.#ackCommand(command, true);
      return;
    }
    // The same command can be replayed on a new socket while the original
    // handler is waiting for a prior consumer cursor. The original handler
    // remains authoritative and will ACK through whichever socket is current.
    if (this.#acceptingCommandIds.has(command.command_id) || this.#acceptingRunIds.has(command.run_id)) return;
    this.#acceptingCommandIds.add(command.command_id);
    this.#acceptingRunIds.add(command.run_id);
    try {
      let request: InvokeRequest;
      let adapterType: string;
      let sessionId: string;
      let leaseId: string;
      let fencingToken: number;
      try {
        leaseId = requiredString(command.lease_id, "run.start lease_id");
        fencingToken = requiredSafeInteger(command.fencing_token, "run.start fencing_token");
        const executionEnvelope = command.payload as ExecutionEnvelope;
        const contextSnapshot = await this.#prepareChannelContext(command.run_id, executionEnvelope);
        const mapped = mapExecutionEnvelope(executionEnvelope, contextSnapshot);
        request = mapped.request;
        adapterType = mapped.adapterType;
        sessionId = request.sessionId;
      } catch (error) {
        if (error instanceof RuntimeStoppingError) {
          this.#contextStore?.markFailed(command.run_id);
          return;
        }
        this.#contextStore?.markFailed(command.run_id);
        const failure = { code: "INVALID_EXECUTION_ENVELOPE", message: errorMessage(error) };
        store.recordCommandReceipt(command.command_id, command.server_seq, false, failure);
        this.#ackCommand(command, false, failure);
        return;
      }
      store.upsertRun({
        runId: command.run_id,
        sessionId,
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
      this.#ackCommand(command, true);
      void this.#execute(command, adapterType, request);
    } finally {
      this.#acceptingCommandIds.delete(command.command_id);
      this.#acceptingRunIds.delete(command.run_id);
    }
  }

  async #prepareChannelContext(
    runId: string,
    envelope: ExecutionEnvelope
  ): Promise<PreparedChannelContextSnapshot | undefined> {
    const descriptorValue = asRecord(envelope.immutable_execution_input.content).channel_context;
    if (descriptorValue === undefined) return undefined;
    assertChannelContextDescriptor(descriptorValue);
    const descriptor = descriptorValue;
    const contextStore = this.#contextStore;
    if (!contextStore) return undefined;

    // Reliable trigger path repairs a dropped best-effort append before selection.
    contextStore.append({ scope: descriptor.scope, facts: [descriptor.trigger_fact] });
    if (!this.#usesAppendOnlyDelta()) return undefined;
    if (contextStore.needsSync(descriptor.scope)) await this.#requestContextSync(descriptor);
    while (!this.#stopped) {
      try {
        return contextStore.prepareSnapshot(runId, descriptor);
      } catch (error) {
        if (!(error instanceof ChannelContextConsumerBusyError)) throw error;
        await delay(CONTEXT_BUSY_POLL_MS);
      }
    }
    throw new RuntimeStoppingError();
  }

  async #requestContextSync(descriptor: ChannelContextDescriptor): Promise<void> {
    const contextStore = this.#contextStore;
    if (!contextStore) return;
    const requestId = `ctx_sync_${randomUUID()}`;
    const afterSeq = contextStore.syncAfterSeq(descriptor.scope);
    const request: ContextSyncRequest = {
      request_id: requestId,
      scope: descriptor.scope,
      trigger_message_id: descriptor.trigger_message_id,
      ...(descriptor.trigger_seq === undefined ? {} : { trigger_seq: descriptor.trigger_seq }),
      ...(afterSeq === undefined ? {} : { after_seq: afterSeq }),
      limit: Math.min(this.#options.channelContext?.maxProjectedMessages ?? DEFAULT_CONTEXT_SYNC_LIMIT, 100)
    };
    const scopeKey = channelScopeKey(descriptor.scope);
    const wait = new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        this.#pendingContextSyncs.delete(requestId);
        if (this.#latestContextSyncByScope.get(scopeKey) === requestId) {
          this.#latestContextSyncByScope.delete(scopeKey);
        }
        resolve();
      }, this.#options.channelContext?.syncTimeoutMs ?? DEFAULT_CONTEXT_SYNC_TIMEOUT_MS);
      timer.unref?.();
      this.#pendingContextSyncs.set(requestId, {
        scopeKey,
        triggerMessageId: descriptor.trigger_message_id,
        ...(descriptor.trigger_seq === undefined ? {} : { triggerSeq: descriptor.trigger_seq }),
        ...(afterSeq === undefined ? {} : { afterSeq }),
        resolve,
        timer
      });
      this.#latestContextSyncByScope.set(scopeKey, requestId);
    });
    try {
      this.#send("context.sync_request", request);
    } catch {
      this.#resolveContextSync(requestId);
    }
    await wait;
  }

  #resolveContextSync(requestId: string): void {
    const pending = this.#pendingContextSyncs.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pendingContextSyncs.delete(requestId);
    if (this.#latestContextSyncByScope.get(pending.scopeKey) === requestId) {
      this.#latestContextSyncByScope.delete(pending.scopeKey);
    }
    pending.resolve();
  }

  #usesAppendOnlyDelta(): boolean {
    const options = this.#options.channelContext;
    return options?.store === "sqlite"
      && options.projection === "delta"
      && options.providerPersistence === "append_only";
  }

  async #execute(command: RuntimeCommand, adapterType: string, request: InvokeRequest): Promise<void> {
    const store = this.#store;
    if (!store) return;
    let finalText = "";
    let completed = false;
    try {
      const contextSnapshot = this.#contextStore?.markSubmitted(command.run_id);
      store.allocateAndAppend(command.run_id, "run.started", contextSnapshot ? {
        context_snapshot_id: contextSnapshot.ref.snapshot_id,
        context_snapshot_sha256: contextSnapshot.ref.rendered_sha256,
        context_completeness: contextSnapshot.ref.completeness
      } : {});
      this.#kickSender();
      for await (const event of this.#host.invoke(adapterType, request)) {
        if (event.type === "run.running" || event.type === "run.queued") continue;
        finalText = accumulateFinalText(finalText, event);
        const mapped = mapRuntimeEvent(event, finalText);
        if (contextSnapshot && TERMINAL_OUTBOX_TYPES.has(mapped.type)) {
          Object.assign(mapped.payload, {
            context_snapshot_id: contextSnapshot.ref.snapshot_id,
            context_snapshot_sha256: contextSnapshot.ref.rendered_sha256
          });
        }
        // 终态事件绕过软水位背压，保证 Run 在持续背压下仍能落盘收尾。
        if (!TERMINAL_OUTBOX_TYPES.has(mapped.type)) await this.#awaitOutboxCapacity(command.run_id);
        store.allocateAndAppend(command.run_id, mapped.type, mapped.payload);
        completed ||= event.type === "run.finished";
        this.#kickSender();
      }
    } catch (error) {
      try {
        store.allocateAndAppend(command.run_id, "run.failed", {
          code: "ADAPTER_INVOCATION_FAILED",
          message: errorMessage(error),
          text: finalText
        });
        this.#kickSender();
      } catch (appendError) {
        console.error(`failed to record run failure: ${errorMessage(appendError)}`);
      }
    } finally {
      // Success remains submitted until the terminal outbox row receives a durable ACK.
      if (!completed) this.#contextStore?.markFailed(command.run_id);
      this.#activeRuns.delete(command.run_id);
    }
  }

  /** 软水位背压：暂停从 provider 继续读取，直到 Outbox 排空到阈值以下或 Run 结束。 */
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
  async #senderLoop(): Promise<void> {
    const window = this.#options.sendWindow ?? DEFAULT_SEND_WINDOW;
    while (!this.#stopped) {
      const store = this.#store;
      if (store && this.#connected && this.#socket?.readyState === WebSocket.OPEN) {
        const rows = store.listSendable(window).filter(row => !this.#inFlight.has(`${row.runId}:${row.seq}`));
        for (const batch of coalesceBatches(rows)) {
          if (this.#socket?.readyState !== WebSocket.OPEN) break;
          try {
            this.#send("run.event_batch", {
              run_id: batch.runId,
              first_seq: batch.events[0].seq,
              last_seq: batch.events[batch.events.length - 1].seq,
              events: batch.events.map(row => ({
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
    this.#socket.send(JSON.stringify({
      version: PROTOCOL_VERSION,
      id: `msg_${randomUUID()}`,
      type,
      runtime_id: this.#runtimeId,
      ...(seq === undefined ? {} : { seq }),
      ...(ack === undefined ? {} : { ack }),
      sent_at: new Date().toISOString(),
      payload
    } satisfies WireEnvelope));
  }

  /** 发送失败不抛出（心跳/ACK 在断线时可安全丢弃，业务事件由 Outbox 保证重放）。 */
  #trySend(type: string, payload: unknown, seq?: number, ack?: number): void {
    try {
      this.#send(type, payload, seq, ack);
    } catch {
      // 忽略：连接已断，下一次连接会重新协商。
    }
  }

  #headers(json: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#options.token}`,
      "X-Tenant-ID": this.#options.tenantId,
      "X-Subject-ID": this.#options.subjectId,
      ...(json ? { "Content-Type": "application/json" } : {})
    };
  }
}

export function accumulateFinalText(current: string, event: CanonicalEvent): string {
  if (!event.type.startsWith("message.") || (event.payload.channel ?? "final") !== "final") return current;
  const text = stringValue(event.payload.text);
  if (!text) return current;
  if (event.type === "message.delta") return current + text;
  return text;
}

export function mapExecutionEnvelope(
  envelope: ExecutionEnvelope,
  contextSnapshot?: PreparedChannelContextSnapshot
): { adapterType: string; request: InvokeRequest } {
  if (!envelope?.run_id || !envelope.harness_session_id || !envelope.agent_revision || !envelope.immutable_execution_input) {
    throw new TypeError("execution envelope is missing run/session/revision/immutable execution input");
  }
  const profile = asRecord(envelope.agent_revision.execution_profile);
  const definition = asRecord(envelope.agent_revision.definition);
  const adapterType = stringValue(profile.adapter_type) ?? normalizeAdapterType(stringValue(profile.default_adapter) ?? "codex");
  const agentConfig = asRecord(profile.agent_config) as AgentConfig;
  const workdir = stringValue(profile.workdir) ?? stringValue(agentConfig.workdir);
  if (!workdir) throw new TypeError("execution_profile.workdir is required for a local runtime");
  const content = envelope.immutable_execution_input.content;
  const displayPrompt = contextSnapshot
    ? renderDisplayExecutionInputPrompt(content)
    : renderImmutableExecutionInputPrompt(content);
  const context = {
    schemaVersion: envelope.schema_version,
    agentId: envelope.execution_request.agent_id,
    agentRevisionId: envelope.execution_request.agent_revision_id,
    sourceType: envelope.execution_request.source_type,
    sourceId: envelope.execution_request.source_id,
    immutableExecutionInput: content ?? {},
    ...(contextSnapshot ? { contextSnapshot: contextSnapshot.ref } : {})
  };
  return {
    adapterType,
    request: {
      invocationId: `invoke_${randomUUID()}`,
      sessionId: envelope.harness_session_id,
      runId: envelope.run_id,
      prompt: displayPrompt,
      ...(contextSnapshot ? {
        modelInput: composeProviderModelInput(contextSnapshot.renderedText, displayPrompt),
        contextSnapshot: contextSnapshot.ref
      } : {}),
      workdir,
      appendInstructions: stringValue(definition.instructions) ?? "",
      context,
      ...(envelope.provider_session ? { providerSession: envelope.provider_session } : {}),
      agentConfig: { ...agentConfig, workdir }
    }
  };
}

export function renderImmutableExecutionInputPrompt(content: Record<string, unknown> | undefined): string {
  const input = asRecord(content);
  const parts = Array.isArray(input.parts) ? input.parts : [];
  const current = parts.map(part => {
    const value = asRecord(part);
    return value.type === "text" && typeof value.text === "string" ? value.text : "";
  }).filter(Boolean).join("\n");
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
  const parts = Array.isArray(input.parts) ? input.parts : [];
  const current = parts.map(part => {
    const value = asRecord(part);
    return value.type === "text" && typeof value.text === "string" ? value.text : "";
  }).filter(Boolean).join("\n");
  const blocks: string[] = [];
  const reply = asRecord(input.reply_to);
  if (stringValue(reply.text)) {
    blocks.push(`[Quoted message from ${stringValue(reply.author_name) ?? stringValue(reply.author_id) ?? "unknown"}]\n${stringValue(reply.text)}`);
  }
  blocks.push(`[Current message]\n${current}`);
  return blocks.join("\n\n");
}

function rawDataText(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

export function mapRuntimeEvent(event: CanonicalEvent, finalText: string): { type: string; payload: Record<string, unknown> } {
	const terminalText = finalText || stringValue(event.payload.text) || "";
  switch (event.type) {
    case "run.finished":
      return { type: "run.completed", payload: { ...event.payload, text: terminalText } };
    case "run.error":
      return { type: "run.failed", payload: { code: "PROVIDER_ERROR", ...event.payload, text: terminalText } };
    case "run.stopped":
      return { type: "run.cancelled", payload: { ...event.payload, text: terminalText } };
    default:
      return { type: event.type, payload: event.payload };
  }
}

function normalizeAdapterType(value: string): string {
  return value.endsWith("-local") ? value.slice(0, -"-local".length) : value;
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

class RuntimeStoppingError extends Error {
  constructor() {
    super("Agent Work runtime stopped while waiting for channel context cursor");
    this.name = "RuntimeStoppingError";
  }
}

function stripSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

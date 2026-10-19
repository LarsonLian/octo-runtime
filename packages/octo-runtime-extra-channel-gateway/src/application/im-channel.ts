import type { JsonObject } from "@mininglamp-oss/octo-runtime-daemon";
/**
 * 单 Bot 编排：把授权 IM 消息转换为有界任务，并把公开结果投递回原会话。
 * 管理会话、排队、取消和交互归属；平台协议交给 connector，领域业务交给发起方。
 */
import { randomUUID } from "node:crypto";
import { assertModelInputParts, failurePayload } from "@mininglamp-oss/octo-runtime-protocol";
import { ImImageInputError } from "../transport/image-input.js";
import { performance } from "node:perf_hooks";
import type {
  InteractionRequestedPayload,
  InteractionResponse,
  InvokeEnvironment
} from "@mininglamp-oss/octo-runtime-protocol";
import type {
  ImBotConfig,
  ImConnectionState,
  ImSession,
  ImInboundMessage,
  ImPositionObservation,
  ImRunControls,
  ImPresentation
} from "../contracts.js";
import type { ImModuleDependencies } from "../ports.js";
import { imBotIdentity, validateImConfig } from "../lifecycle/configuration.js";
import { GatewayTransport } from "../transport/channel.js";
import { createImInvocation } from "../execution/dispatcher.js";
import { ImTask } from "../execution/task.js";
import { ImDeliveryDispatcher } from "../delivery/dispatcher.js";
import { ImRunProjector } from "../presentation/run-projector.js";
import { deliveryNotice } from "../presentation/delivery-notice.js";
import { MemoryImSessionStore, type ImSessionStore } from "./session-store.js";
import { connectionFailure, ImConnectionError } from "../transport/connection-error.js";
import {
  commitHistoryGap,
  gapMetadata,
  planHistoryGap,
  validMessageSeq,
  type ImGapPlan
} from "./context-gap.js";

export class ImRuntime {
  readonly #processEpoch = randomUUID();
  readonly #preparing = new Map<string, AbortController>();
  readonly config: ImBotConfig;
  #connector?: GatewayTransport;
  #delivery?: ImDeliveryDispatcher;
  readonly #sessions = new Map<string, ImSession>();
  readonly #sessionStore: ImSessionStore;
  readonly #seen = new Map<string, number>();
  readonly #queuedOccurrences = new Set<string>();
  readonly #tasks = new Map<string, { rootInvocationId: string; task: ImTask }>();
  readonly #interactions = new Map<
    string,
    {
      invocationId: string;
      sessionId: string;
      key: string;
      senderId: string;
      request: InteractionRequestedPayload;
    }
  >();
  readonly #responding = new Set<string>();
  #closed = true;
  #state: ImConnectionState = "stopped";
  #reconnect?: NodeJS.Timeout;
  #connecting?: Promise<void>;
  #abort = new AbortController();
  #signal = this.#abort.signal;
  #closing?: Promise<void>;
  #connectionAbort?: AbortController;
  #error?: string;
  #working = 0;
  readonly #busyNotifications = new Map<string, Promise<void>>();
  readonly #busyNotifiedAt = new Map<string, number>();
  #retry = 0;
  #everOnline = false;
  #disconnecting?: Promise<void>;
  constructor(
    config: ImBotConfig,
    readonly dependencies: ImModuleDependencies
  ) {
    validateImConfig(config);
    this.config = structuredClone(config);
    this.config.bot_name ??= this.config.bot_id;
    this.#sessionStore = dependencies.sessions ?? new MemoryImSessionStore();
  }
  get status(): Record<string, unknown> {
    return {
      ...this.#connector?.status,
      connection_key: imBotIdentity(this.config),
      type: "octo",
      bot_name: this.config.bot_name,
      enabled: this.config.enabled !== false,
      botId: this.#connector?.botId,
      connected: this.#state === "online",
      state: this.#state,
      error: this.#error ?? null,
      deliveries: this.#delivery?.receipts ?? [],
      workingTasks: this.#working,
      queuedTasks: [...this.#sessions.values()].reduce(
        (sum, session) => sum + Math.max(0, session.pending - 1),
        0
      ),
      sessions: [...this.#sessions.values()].map((session) => ({
        sessionId: session.id,
        generation: session.generation,
        runId: session.lastRunId,
        eventId: session.lastEventId,
        active: !!session.activeInvocationId
      })),
      tasks: [...this.#tasks.values()].map(({ task }) => ({
        runId: task.request.runId,
        attempts: task.attempts.map((attempt) => ({ ...attempt })),
        stopReason: task.stopReason
      }))
    };
  }
  async start(): Promise<void> {
    if (this.#closing) await this.#closing;
    this.dependencies.signal?.throwIfAborted();
    if (this.config.enabled === false) return;
    if (!this.#closed && this.#state !== "failed") return this.#connecting;
    if (this.#connecting) return this.#connecting;
    if (this.#closed) {
      this.#closed = false;
      this.#closing = undefined;
      this.#abort = new AbortController();
      this.#signal = AbortSignal.any([
        this.#abort.signal,
        ...(this.dependencies.signal ? [this.dependencies.signal] : [])
      ]);
      this.#signal.addEventListener(
        "abort",
        () => {
          if (!this.#closed) void this.close().catch(() => this.#diagnostic("IM_DISPOSE_FAILED"));
        },
        { once: true }
      );
      this.#delivery = new ImDeliveryDispatcher(this.#signal);
    }
    this.#everOnline = false;
    this.#retry = 0;
    this.#error = undefined;
    this.#state = "connecting";
    this.#connecting = this.#connect(false);
    try {
      await this.#connecting;
    } finally {
      this.#connecting = undefined;
    }
  }
  async #connect(recovering: boolean): Promise<void> {
    if (this.#closed || this.#signal.aborted) return;
    this.#connectionAbort?.abort();
    try {
      await this.#disconnecting;
      await this.#connector?.close();
    } catch {
      this.#state = this.#closed ? "stopped" : "failed";
      if (!this.#closed) this.#error = "IM_DISPOSE_FAILED";
      this.#everOnline = false;
      return;
    }
    if (this.#closed || this.#signal.aborted) return;
    this.#connectionAbort = new AbortController();
    const signal = AbortSignal.any([this.#signal, this.#connectionAbort.signal]);
    let starting = true;
    let disconnected: ImConnectionError | undefined;
    const credentials =
      this.dependencies.credentials ?? ((config) => Promise.resolve(config.bf_token));
    const connector = new GatewayTransport(this.config, credentials, {
      authorizeSpace: this.dependencies.authorizeSpace,
      onPosition: (position) => {
        if (connector === this.#connector && !signal.aborted) this.#observePosition(position);
      },
      onMessage: (message) => {
        if (connector === this.#connector && !signal.aborted) this.#receive(message);
      },
      onDiagnostic: (code) => {
        if (connector === this.#connector && !signal.aborted) this.#diagnostic(code);
      },
      onDisconnect: (code, retryable = true) => {
        if (connector !== this.#connector || this.#closed || signal.aborted) return;
        if (disconnected) return;
        disconnected = new ImConnectionError(code, retryable);
        if (!starting) this.#lostConnection(connector, disconnected);
      }
    });
    this.#connector = connector;
    try {
      await connector.start(signal);
      if (signal.aborted) {
        await connector.close();
        return;
      }
      if (disconnected) throw disconnected;
      starting = false;
      this.#everOnline = true;
      this.#state = "online";
      this.#log("channel.connected", { state: "online" });
      this.#error = undefined;
      this.#retry = 0;
    } catch (error) {
      if (signal.aborted) return;
      starting = false;
      const failure = connectionFailure(error);
      this.#connectionAbort.abort();
      this.#error = failure.message;
      const retry = recovering && this.#everOnline && failure.retryable;
      this.#state = retry ? "retrying" : "failed";
      this.#log("channel.connection_failed", { state: this.#state, code: failure.message });
      try {
        await connector.close();
      } catch {
        this.#everOnline = false;
        if (!this.#closed) this.#state = "failed";
        this.#diagnostic("IM_DISPOSE_FAILED");
        return;
      }
      if (!retry) this.#everOnline = false;
      if (retry) this.#scheduleReconnect(failure.retryAfterMs);
    }
  }
  #lostConnection(connector: GatewayTransport, failure: ImConnectionError): void {
    this.#log("channel.disconnected", { code: failure.message });
    this.#error = failure.message;
    const retry = this.#everOnline && failure.retryable;
    this.#state = retry ? "retrying" : "failed";
    if (!retry) this.#everOnline = false;
    this.#connectionAbort?.abort();
    // 先收回旧连接资源，再计时；停止信号与迟到回调不能建立第二条连接。
    this.#disconnecting = connector.close();
    void this.#disconnecting.then(
      () => {
        if (retry) this.#scheduleReconnect(failure.retryAfterMs);
      },
      () => {
        if (!this.#closed) this.#state = "failed";
        this.#everOnline = false;
        this.#diagnostic("IM_DISPOSE_FAILED");
      }
    );
  }
  #scheduleReconnect(retryAfterMs = 0): void {
    if (this.#closed || this.#signal.aborted || this.#state !== "retrying" || this.#reconnect)
      return;
    const delayMs = Math.max(Math.min(30_000, 5_000 * 2 ** this.#retry), retryAfterMs);
    this.#retry = Math.min(3, this.#retry + 1);
    // Node 超过 2^31-1 的 timeout 会变为 1ms；长 Retry-After 分段等待，不能绕过限流。
    const deadline = performance.now() + delayMs;
    const wake = (): void => {
      if (this.#closed || this.#signal.aborted || this.#state !== "retrying") return;
      const remaining = deadline - performance.now();
      if (remaining > 0) {
        this.#reconnect = setTimeout(wake, Math.min(remaining, 2_147_483_647));
        this.#reconnect.unref();
        return;
      }
      this.#reconnect = undefined;
      this.#connecting = this.#connect(true).finally(() => {
        this.#connecting = undefined;
      });
    };
    this.#reconnect = setTimeout(wake, Math.min(delayMs, 2_147_483_647));
    this.#reconnect.unref();
  }
  #diagnostic(code: string, runId?: string): void {
    try {
      this.dependencies.log?.("warn", "channel.diagnostic", {
        code,
        endpoint_id: imBotIdentity(this.config),
        ...(runId ? { run_id: runId } : {})
      });
      this.dependencies.onDiagnostic?.(code, {
        endpointId: imBotIdentity(this.config),
        ...(runId ? { runId } : {})
      });
    } catch {
      /* Diagnostics cannot fail execution. */
    }
  }
  #log(event: string, data: Record<string, unknown> = {}): void {
    try {
      this.dependencies.log?.("info", event, { endpoint_id: imBotIdentity(this.config), ...data });
    } catch {
      /* 诊断不改变业务结果。 */
    }
  }
  #key(message: Pick<ImInboundMessage, "conversationKind" | "conversationId">): string {
    return [
      this.#connector!.identity,
      imBotIdentity(this.config),
      this.config.adapter.adapter_type ?? "",
      message.conversationKind,
      message.conversationId
    ]
      .map(encodeURIComponent)
      .join("/");
  }
  #observePosition(position: ImPositionObservation): void {
    if (this.#closed || !validMessageSeq(position.messageSeq)) return;
    const key = this.#key(position);
    try {
      const binding = this.#sessionStore.read(key);
      if (!binding?.id || !this.#sessionStore.patchGap) return;
      if (
        position.own &&
        (!position.turn ||
          position.turn.processEpoch !== this.#processEpoch ||
          position.turn.sessionId !== binding.id ||
          position.turn.generation !== binding.generation)
      )
        return;
      this.#sessionStore.patchGap(
        key,
        { sessionId: binding.id, generation: binding.generation },
        (previous) => {
          const next = gapMetadata(this.#processEpoch, previous);
          next.latestObservedSeq = Math.max(next.latestObservedSeq ?? 0, position.messageSeq);
          next.observationVisibility = "partial";
          if (position.own)
            next.localOutputSeqs = [...new Set([...next.localOutputSeqs, position.messageSeq])]
              .sort((left, right) => left - right)
              .slice(-32);
          return next;
        }
      );
    } catch {
      this.#diagnostic("IM_HISTORY_POSITION_UNAVAILABLE");
    }
  }
  #receive(message: ImInboundMessage): void {
    if (
      this.#closed ||
      (this.config.allowed_sender_ids && !this.config.allowed_sender_ids.includes(message.senderId))
    )
      return;
    const now = Date.now();
    for (const [id, expiry] of this.#seen) if (expiry <= now) this.#seen.delete(id);
    const key = this.#key(message),
      dedupe = `${key}/${encodeURIComponent(message.messageId)}`;
    if (this.#seen.has(dedupe)) return;
    if (this.#seen.size >= 4096 || Buffer.byteLength(message.text) > 64 * 1024) {
      this.#diagnostic("IM_INBOUND_CAPACITY_EXHAUSTED");
      return;
    }
    this.#seen.set(dedupe, now + 120_000);
    const command = message.text.trim();
    if (/^\/(approve|decline|respond)\s/.test(command)) {
      void this.#respond(message, key).catch(() =>
        this.#diagnostic("IM_INTERACTION_RESPONSE_FAILED")
      );
      return;
    }
    let session: ImSession | undefined;
    try {
      session = this.#session(key);
      if (command === "/reset") {
        try {
          const binding = this.#sessionStore.reset(key, message.messageId);
          this.#tasks.get(key)?.task.stopRetries();
          session.id = binding.id;
          session.generation = binding.generation;
          session.providerSession = binding.providerSession;
          session.initialization = { attempted: false };
          session.lastRunId = undefined;
          void this.#reply(message, "会话已经重置", `control:${message.messageId}`, true).catch(
            () => {
              this.#seen.delete(dedupe);
              this.#diagnostic("IM_RESET_REPLY_FAILED");
            }
          );
        } catch {
          this.#seen.delete(dedupe);
          void this.#reply(
            message,
            "会话重置失败，请重试。",
            `reset-failed:${message.messageId}`
          ).catch(() => this.#diagnostic("IM_RESET_FAILED"));
        }
        return;
      }
      if (command === "/stop" || command === "/cancel") {
        // 控制命令绕过普通消息队列，否则 stop 会排在待取消的长任务之后。
        const preparation = this.#preparing.get(key);
        preparation?.abort();
        const invocationId = session.activeInvocationId;
        void (async () => {
          const task = this.#tasks.get(key)?.task;
          const cancelled = preparation
            ? true
            : task
              ? await task.cancel()
              : invocationId
                ? (await this.dependencies.host.cancel(invocationId, "IM user stop")).cancelled
                : false;
          await this.#reply(
            message,
            cancelled ? "已请求停止本轮执行。" : "当前没有可停止的执行。",
            `control:${message.messageId}`
          );
        })().catch(() => this.#diagnostic("IM_CANCEL_FAILED"));
        return;
      }
      this.#enqueue(message, key);
    } catch {
      this.#seen.delete(dedupe);
      this.#diagnostic("IM_SESSION_STORE_FAILED");
    } finally {
      if (session) this.#releaseSession(key, session);
    }
  }
  #session(key: string): ImSession {
    let session = this.#sessions.get(key);
    if (!session) {
      const binding = this.#sessionStore.read(key);
      session = {
        generation: 1,
        ...binding,
        initialization: { attempted: binding?.initialContextPrepared === true },
        pending: 0,
        tail: Promise.resolve()
      };
      this.#sessions.set(key, session);
    }
    return session;
  }
  #releaseSession(key: string, session: ImSession): void {
    if (!session.pending && !session.activeInvocationId && this.#sessions.get(key) === session)
      this.#sessions.delete(key);
  }
  #runControls(
    message: ImInboundMessage,
    key: string,
    invocationId: string
  ): ImRunControls & { failed: boolean } {
    const controls = {
      failed: false,
      respond: async (response: InteractionResponse) => {
        if (this.#tasks.get(key)?.rootInvocationId !== invocationId)
          throw Error("IM_INTERACTION_STALE_RUN");
        await this.#submitInteraction(key, message.senderId, response);
      },
      cancel: async () =>
        this.#tasks.get(key)?.rootInvocationId === invocationId &&
        (await this.#tasks.get(key)!.task.cancel("IM card stop")),
      retry: (senderId: string, id: string): boolean => {
        if (!controls.failed) return false;
        if (!message.position) return this.#enqueue({ ...message, senderId }, key, id);
        const saved = this.#sessionStore.occurrence(key, message.messageId)?.snapshot;
        if (!saved) return false;
        const binding = this.#sessionStore.read(key);
        if (saved.sessionId !== binding?.id || saved.sessionGeneration !== binding.generation)
          return this.#enqueue({ ...message, senderId }, key, id);
        const images = saved.inputs.filter((part) => part.type === "image");
        return this.#enqueue(
          {
            ...message,
            senderId,
            historyRetry: true,
            buildContext: () => Promise.resolve(structuredClone(saved.contexts)),
            ...(images.length
              ? { buildInputs: () => Promise.resolve(structuredClone(images)) }
              : {})
          },
          key,
          id
        );
      }
    };
    return controls;
  }
  #enqueue(message: ImInboundMessage, key: string, occurrenceId?: string): boolean {
    if (this.#closed || this.#signal.aborted) return false;
    const id = occurrenceId ?? message.messageId;
    const queuedKey = JSON.stringify([key, id]);
    if (this.#queuedOccurrences.has(queuedKey)) return false;
    const previous = this.#sessionStore.occurrence(key, id);
    if (previous) {
      void this.#reply(
        message,
        previous.text === message.text
          ? "该消息已经提交，请查看原执行结果。"
          : "消息身份冲突，请重新发送。",
        `duplicate:${id}`
      );
      return false;
    }
    const session = this.#session(key);
    try {
      // Octospec F26: .octospec/tasks/gateway-august-feature-assessment/assessment.md
      // 每个非空 session 占一个工作槽位；结束清理后原子交给同 session 的下一条。
      // 排队另计四条，不把 Bot 的工作数与所有排队消息混加。
      const full =
        session.pending >= 5
          ? "IM_SESSION_QUEUE_FULL"
          : this.#working >= 64
            ? "IM_BOT_WORKING_FULL"
            : undefined;
      if (full) {
        this.#busy(message, key, full);
        return false;
      }
      if (message.text.trim() !== "/session" && !session.id) {
        const binding = {
          id: `as_${randomUUID()}`,
          generation: session.generation,
          initialContextPrepared: session.initialization?.attempted === true
        };
        this.#sessionStore.save(key, binding);
        session.id = binding.id;
      }
      const executionSession = { ...session };
      const frozenMessage = {
        ...message,
        ...(message.position ? { position: { ...message.position } } : {})
      };
      this.#queuedOccurrences.add(queuedKey);
      if (session.pending++ === 0) this.#working++;
      session.tail = session.tail
        .then(() => this.#turn(frozenMessage, key, session, occurrenceId, executionSession))
        .catch(() => this.#diagnostic("IM_TURN_FAILED"))
        .finally(() => {
          this.#queuedOccurrences.delete(queuedKey);
          session.pending--;
          if (session.pending === 0) this.#working--;
          this.#releaseSession(key, session);
        });
      return true;
    } finally {
      this.#releaseSession(key, session);
    }
  }
  #busy(message: ImInboundMessage, key: string, code: string): void {
    this.#diagnostic(code);
    const now = Date.now();
    if (
      this.#busyNotifications.has(key) ||
      this.#busyNotifications.size >= 64 ||
      now - (this.#busyNotifiedAt.get(key) ?? 0) < 1000
    )
      return;
    this.#busyNotifiedAt.set(key, now);
    if (this.#busyNotifiedAt.size > 128)
      this.#busyNotifiedAt.delete(this.#busyNotifiedAt.keys().next().value!);
    const payload = failurePayload(
      { code },
      {
        stage: "channel_admission",
        defaultDomain: "runtime",
        source: { component: "octo-runtime" }
      }
    );
    const event = {
      protocolVersion: 2 as const,
      type: "run.failed" as const,
      payload: {
        ...payload,
        message: `当前智能体繁忙，请稍后再试。本条消息未受理，尚未开始执行。${code === "IM_SESSION_QUEUE_FULL" ? "单 session 排队已满。" : "Bot 工作并发已满。"}`
      }
    };
    const effect = `busy:${message.messageId}`;
    const notification = Promise.allSettled([
      Promise.resolve().then(() => message.replyFailure?.(event, effect)),
      this.#reply(
        message,
        `当前智能体繁忙，请稍后再试\n错误码：${payload.failure.code}`,
        `${effect}:text`
      )
    ])
      .then((results) => {
        if (results.some((result) => result.status === "rejected"))
          this.#diagnostic("IM_BUSY_NOTIFICATION_FAILED");
      })
      .finally(() => {
        this.#busyNotifications.delete(key);
      });
    this.#busyNotifications.set(key, notification);
  }
  async #reply(
    message: ImInboundMessage,
    text: string,
    effectKey: string,
    requireDelivered = false,
    final = false,
    allowUnknownNotice = true
  ): Promise<void> {
    if (this.#closed || this.#signal.aborted || !this.#delivery) return;
    const receipt = await this.#delivery.deliver(effectKey, () =>
      final && message.replyFinal
        ? message.replyFinal(text, effectKey)
        : message.reply(text, effectKey)
    );
    if (receipt.state !== "delivered") {
      this.#diagnostic(receipt.code ?? "IM_DELIVERY_FAILED");
      if (
        allowUnknownNotice &&
        receipt.state === "unknown" &&
        message.replyDeliveryUnknown &&
        !this.#closed &&
        !this.#signal.aborted
      ) {
        const notice = deliveryNotice();
        const result = await this.#delivery.deliver(
          `delivery-unknown:${effectKey}`,
          () =>
            message.replyDeliveryUnknown!(
              notice,
              `delivery-unknown:${effectKey}`,
              effectKey,
              this.#signal
            ),
          { obsolete: () => Boolean(message.isReplyDelivered?.(effectKey)) }
        );
        if (result.state !== "delivered") this.#diagnostic("IM_DELIVERY_NOTICE_FAILED");
      }
      if (requireDelivered) throw new Error(receipt.code ?? "IM_DELIVERY_FAILED");
    }
  }
  async #respond(message: ImInboundMessage, key: string): Promise<void> {
    const match = /^\/(approve|decline|respond)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(
      message.text.trim()
    );
    if (!match) return;
    const entry = this.#interactions.get(match[2]);
    if (
      !entry ||
      entry.key !== key ||
      entry.senderId !== message.senderId ||
      !Number.isFinite(Date.parse(entry.request.expiresAt)) ||
      Date.parse(entry.request.expiresAt) <= Date.now()
    ) {
      await this.#reply(
        message,
        "该交互已失效或不属于当前会话。",
        `interaction:${message.messageId}`
      );
      return;
    }
    const command = match[1],
      approval = entry.request.kind === "approval";
    if (approval !== (command !== "respond")) {
      await this.#reply(message, "交互响应类型不匹配。", `interaction:${message.messageId}`);
      return;
    }
    const response: InteractionResponse = {
      interactionId: match[2],
      outcome: command === "approve" ? "accepted" : command === "decline" ? "declined" : "answered"
    };
    if (!approval) {
      if (!match[3]?.trim()) return;
      response.value =
        entry.request.kind === "elicitation" || Array.isArray(entry.request.request.questions)
          ? (JSON.parse(match[3]) as unknown)
          : match[3];
    }
    await this.#submitInteraction(key, message.senderId, response);
    await this.#reply(message, "已提交本次响应。", `interaction:${message.messageId}`);
  }
  async #submitInteraction(
    key: string,
    senderId: string,
    response: InteractionResponse
  ): Promise<void> {
    const entry = this.#interactions.get(response.interactionId);
    if (
      this.#closed ||
      this.#signal.aborted ||
      !entry ||
      entry.key !== key ||
      entry.senderId !== senderId ||
      this.#sessionStore.read(key)?.id !== entry.sessionId ||
      !Number.isFinite(Date.parse(entry.request.expiresAt)) ||
      Date.parse(entry.request.expiresAt) <= Date.now()
    )
      throw Error("IM_INTERACTION_STALE");
    if (this.#responding.has(response.interactionId)) return;
    this.#responding.add(response.interactionId);
    try {
      await this.dependencies.host.respondInteraction(entry.invocationId, response);
      this.#interactions.delete(response.interactionId);
    } finally {
      this.#responding.delete(response.interactionId);
    }
  }
  async #turn(
    message: ImInboundMessage,
    key: string,
    session: ImSession,
    occurrenceId?: string,
    executionSession: ImSession = session
  ): Promise<void> {
    if (this.#closed || this.#signal.aborted || !this.#delivery) return;
    const prompt = message.text.trim();
    if (!prompt && !message.buildInputs) return;
    if (prompt === "/session") {
      await this.#reply(
        message,
        `session=${session.id} generation=${session.generation}${session.lastRunId ? ` run=${session.lastRunId}` : ""}`,
        `control:${message.messageId}`
      );
      return;
    }
    // 准备阶段还没有 invocationId；按会话单独持有 controller，使 /stop 也能取消动态 Context/取材。
    const preparation = new AbortController();
    this.#preparing.set(key, preparation);
    const turnSignal = AbortSignal.any([this.#signal, preparation.signal]);
    let prepared: ReturnType<typeof createImInvocation>;
    let gapPlan: ImGapPlan = { mode: "none" };
    let failureAfterSeq: number | null = null;
    // Octospec F05: .octospec/tasks/gateway-august-feature-assessment/assessment.md
    // 仅普通任务开始时回执；通知失败不阻断 Context 准备和模型执行。
    if (message.markRead)
      void Promise.resolve()
        .then(() => message.markRead!(turnSignal))
        .catch(() => this.#diagnostic("IM_READ_RECEIPT_FAILED"));
    let environment: InvokeEnvironment;
    try {
      environment = message.executionEnvironment?.() ?? {};
      if (session.id === executionSession.id)
        executionSession.providerSession = session.providerSession;
      const initialization = executionSession.initialization!;
      const initialSession = !initialization.attempted;
      initialization.attempted = true;
      if (session.id === executionSession.id) this.#saveBinding(key, session);
      const binding = this.#sessionStore.read(key);
      const gapEnabled =
        message.conversationKind !== "direct" &&
        message.position !== undefined &&
        !message.historyRetry;
      if (gapEnabled) {
        gapPlan = planHistoryGap(
          message.position?.messageSeq,
          binding &&
            binding.id === executionSession.id &&
            binding.generation === executionSession.generation
            ? binding.gap
            : undefined,
          this.#processEpoch,
          typeof this.#sessionStore.patchGap === "function"
        );
        message.bindHistoryTurn?.({
          sessionId: executionSession.id!,
          generation: executionSession.generation,
          processEpoch: this.#processEpoch
        });
      }
      const context = await message.buildContext(turnSignal, {
        configuredItems: message.historyRetry
          ? undefined
          : await this.dependencies.prepareContexts?.(
              this.config as unknown as JsonObject,
              turnSignal
            ),
        initialSession,
        mentionGuidance: initialSession || !executionSession.providerSession,
        ...(gapEnabled
          ? {
              historyGap: gapPlan,
              onHistoryGapPrepared: (plan: ImGapPlan) => {
                gapPlan = plan;
              }
            }
          : {})
      });
      if (gapEnabled) failureAfterSeq = gapPlan.afterSeq ?? null;
      // 资格先占用再异步读取；同代次队列共享标记，重试只使用本轮冻结快照。
      prepared = createImInvocation(
        this.config,
        message,
        context,
        key,
        executionSession,
        turnSignal,
        occurrenceId
      );
      if (
        gapEnabled &&
        context.items.some(
          (item) =>
            item.namespace === "extra.im" &&
            item.name === "history" &&
            item.payload.automatic === true
        ) &&
        !prepared.request.contexts.items.some(
          (item) => item.namespace === "extra.im" && item.name === "history"
        )
      )
        gapPlan = { ...gapPlan, retrieval: "omitted" };
      if (message.buildInputs) {
        if (prepared.adapterType !== "codex")
          throw new ImImageInputError("本期仅 Codex 支持独立图片输入，当前引擎不支持。");
        const parts = await message.buildInputs(turnSignal);
        assertModelInputParts(parts);
        if (parts.length !== 1 || parts[0].type !== "image")
          throw new ImImageInputError("每条独立图片消息只接收一张图片。");
        prepared.request.inputs = parts;
      }
      if (session.id === prepared.request.sessionId) {
        session.lastEventId = executionSession.lastEventId;
        session.lastRunId = prepared.request.runId;
        this.#saveBinding(key, session);
      }
      message.executionEnvironment?.();
      if (prepared.adapterType === "openclaw") environment = {};
      turnSignal.throwIfAborted();
      const snapshot = { ...prepared.request };
      this.#sessionStore.remember(key, occurrenceId ?? message.messageId, {
        text: message.text,
        sessionId: executionSession.id!,
        runId: prepared.request.runId,
        snapshot
      });
    } catch (error) {
      if (turnSignal.aborted) return;
      if (error instanceof Error && /^IM_CONTEXT_(?:LOADING|RESULT)_[A-Z_]+$/.test(error.message))
        this.#diagnostic(error.message);
      this.#diagnostic("IM_CONTEXT_PREPARATION_FAILED");
      await this.#reply(
        message,
        error instanceof ImImageInputError
          ? error.message
          : message.buildInputs
            ? "图片输入准备失败，尚未发起执行。请检查图片或稍后重试。"
            : "本轮输入或执行配置准备失败，尚未发起执行。请检查配置、会话权限或稍后重试。",
        `prepare:${occurrenceId ?? message.messageId}`
      );
      return;
    } finally {
      this.#preparing.delete(key);
    }
    if (this.#closed || this.#signal.aborted) return;
    let { request } = prepared;
    const rootRunId = request.runId;
    this.#log("agent_run.requested", {
      run_id: request.runId,
      invocation_id: request.invocationId,
      session_id: request.sessionId
    });
    const startedAt = performance.now();
    let presentationSeq = 0;
    let projector = new ImRunProjector(rootRunId, message.conversationKind === "direct");
    let handedOff = false;
    const task = new ImTask(
      this.dependencies.host,
      request,
      prepared.adapterType,
      this.config,
      { ...environment, signal: this.#signal },
      (attempt) => {
        if (
          !handedOff &&
          message.position &&
          message.conversationKind !== "direct" &&
          !message.historyRetry
        ) {
          handedOff = true;
          try {
            this.#sessionStore.patchGap?.(
              key,
              { sessionId: executionSession.id!, generation: executionSession.generation },
              (previous) =>
                commitHistoryGap(
                  gapMetadata(this.#processEpoch, previous),
                  message.position?.messageSeq,
                  gapPlan,
                  attempt.contexts.items.find(
                    (item) => item.namespace === "extra.im" && item.name === "history"
                  )
                )
            );
          } catch {
            this.#diagnostic("IM_HISTORY_POSITION_UNAVAILABLE");
          }
        }
        for (const [id, entry] of this.#interactions)
          if (entry.invocationId === request.invocationId) this.#interactions.delete(id);
        request = attempt;
        projector = new ImRunProjector(rootRunId, message.conversationKind === "direct");
        session.activeInvocationId = request.invocationId;
        if (session.id === request.sessionId) {
          session.lastRunId = request.runId;
          this.#saveBinding(key, session);
        } else task.stopRetries();
      }
    );
    this.#tasks.set(key, { rootInvocationId: request.invocationId, task });
    const snapshot = () => ({
      ...projector.snapshot(),
      seq: ++presentationSeq,
      elapsedMs: Math.round(performance.now() - startedAt),
      attempts: task.attempts.map((attempt) => ({ ...attempt }))
    });
    const controls = this.#runControls(message, key, request.invocationId);
    let presentation: ImPresentation | undefined;
    try {
      presentation = message.beginPresentation?.(
        rootRunId,
        (code) => this.#diagnostic(code, rootRunId),
        controls
      );
      presentation?.update(snapshot());
      session.activeInvocationId = request.invocationId;
      for await (const event of task.events()) {
        if (this.#closed || this.#signal.aborted) break;
        if (event.type === "session.update" && session.id === request.sessionId) {
          session.providerSession = event.payload.providerSession;
          this.#saveBinding(key, session);
          if (event.payload.providerSession?.resumeOutcome === "fresh_fallback") {
            try {
              this.#sessionStore.patchGap?.(
                key,
                { sessionId: request.sessionId, generation: executionSession.generation },
                (previous) => ({
                  ...gapMetadata(this.#processEpoch, previous),
                  continuityUnknown: true,
                  pendingAfterSeq: null
                })
              );
            } catch {
              this.#diagnostic("IM_HISTORY_POSITION_UNAVAILABLE");
            }
          }
        }
        // 只有执行策略与事件策略均为 full_access 的审批才是自动处理的审计记录。
        // 问题/elicitation 仍须展示并交回原交互入口，不能一并过滤。
        if (
          event.type === "interaction.requested" &&
          event.payload.kind === "approval" &&
          request.approvalMode === "full_access" &&
          (event.payload.request.policy as { mode?: unknown } | undefined)?.mode === "full_access"
        )
          continue;
        if (event.type === "interaction.requested") {
          // Octospec F09: .octospec/tasks/gateway-august-feature-assessment/assessment.md
          // 普通 IM 不提供秘密输入通道，禁止退回聊天命令收集凭据。
          if (
            Array.isArray(event.payload.request.questions) &&
            event.payload.request.questions.some(
              (question: unknown) =>
                question !== null &&
                typeof question === "object" &&
                "isSecret" in question &&
                question.isSecret === true
            )
          ) {
            this.#diagnostic("IM_INTERACTION_SECRET_UNSUPPORTED", request.runId);
            await this.#reply(
              message,
              "本次执行需要安全输入，当前聊天不支持。请勿在聊天中发送密码或密钥；本次执行已请求停止。",
              `interaction:${event.payload.interactionId}`
            );
            await this.dependencies.host.cancel(
              request.invocationId,
              "IM secret input unsupported"
            );
            continue;
          }
          if (this.#interactions.size >= 64) throw new Error("IM_INTERACTION_CAPACITY_EXHAUSTED");
          this.#interactions.set(event.payload.interactionId, {
            invocationId: request.invocationId,
            sessionId: request.sessionId,
            key,
            senderId: message.senderId,
            request: structuredClone(event.payload)
          });
          const interaction = event.payload;
          let cardShown = false;
          try {
            cardShown = (await presentation?.interaction?.(interaction)) ?? false;
          } catch {
            this.#diagnostic("IM_INTERACTION_CARD_FAILED", request.runId);
          }
          const display = interaction.request.operation as { summary?: unknown } | undefined;
          const summary = [
            display?.summary,
            interaction.request.question,
            interaction.request.message
          ].find((value) => typeof value === "string");
          const instruction =
            interaction.kind === "approval"
              ? `/approve ${interaction.interactionId} 或 /decline ${interaction.interactionId}`
              : `/respond ${interaction.interactionId} ${interaction.kind === "elicitation" ? "<JSON>" : "<回答>"}`;
          if (!cardShown)
            await this.#reply(
              message,
              `${summary?.slice(0, 1000) ?? "执行需要你的确认或输入。"}\n${Array.isArray(interaction.request.questions) ? JSON.stringify(interaction.request.questions).slice(0, 8000) + "\n请按问题 ID 提交 JSON 答案。\n" : ""}${instruction}`,
              `interaction:${interaction.interactionId}`
            );
        }
        if (event.type === "interaction.resolved") {
          this.#interactions.delete(event.payload.interactionId);
          try {
            await presentation?.resolveInteraction?.(
              event.payload.interactionId,
              event.payload.status
            );
          } catch {
            this.#diagnostic("IM_INTERACTION_CARD_FAILED", request.runId);
          }
        }
        projector.accept(event);
        controls.failed = projector.snapshot().terminal === "failed";
        presentation?.update(snapshot());
      }
      if (!projector.snapshot().terminal) throw new Error("IM_RUN_WITHOUT_TERMINAL");
    } catch {
      if (!projector.snapshot().terminal) {
        // 流断开无法证明执行失败；尽力取消并提示核查，不自动重跑潜在的业务副作用。
        await this.dependencies.host
          .cancel(request.invocationId, "IM execution stream failed")
          .catch(() => undefined);
        this.#diagnostic("IM_EXECUTION_RESULT_UNKNOWN", request.runId);
        presentation?.update({ ...snapshot(), resultUnknown: true });
      }
    } finally {
      if (handedOff && projector.snapshot().terminal !== "completed") {
        try {
          this.#sessionStore.patchGap?.(
            key,
            { sessionId: executionSession.id!, generation: executionSession.generation },
            (previous) => {
              const next = gapMetadata(this.#processEpoch, previous);
              next.pendingAfterSeq =
                next.pendingAfterSeq === null || failureAfterSeq === null
                  ? null
                  : Math.min(next.pendingAfterSeq ?? failureAfterSeq, failureAfterSeq);
              return next;
            }
          );
        } catch {
          this.#diagnostic("IM_HISTORY_POSITION_UNAVAILABLE");
        }
      }
      if (task.stopReason) this.#diagnostic(task.stopReason, rootRunId);
      this.#log("agent_run.finished", {
        run_id: rootRunId,
        invocation_id: request.invocationId,
        session_id: request.sessionId,
        status: projector.snapshot().terminal ?? "unknown"
      });
      this.#tasks.delete(key);
      try {
        // 长任务结束后重新开始终态去重窗口，保留有界尝试身份，避免立即重复执行。
        const saved = { ...prepared.request };
        this.#sessionStore.remember(key, occurrenceId ?? message.messageId, {
          text: message.text,
          sessionId: request.sessionId,
          runId: rootRunId,
          snapshot: saved,
          attempts: task.attempts.map((attempt) => ({ ...attempt }))
        });
      } catch {
        this.#diagnostic("IM_SESSION_STORE_FAILED", rootRunId);
      }
      session.activeInvocationId = undefined;
      for (const [id, entry] of this.#interactions)
        if (entry.invocationId === request.invocationId) this.#interactions.delete(id);
      try {
        await presentation?.finish();
      } catch {
        this.#diagnostic("IM_PRESENTATION_FAILED", request.runId);
      }
    }
    if (this.#closed || this.#signal.aborted) return;
    const { text, allowMention } = projector.finalReply;
    // 最终文本拥有独立投递身份，即使进度卡投递失败，也必须尝试回复用户。
    await this.#reply(
      message,
      text,
      `final:${rootRunId}`,
      false,
      allowMention,
      projector.snapshot().terminal !== "cancelled"
    );
  }
  #saveBinding(key: string, session: ImSession): void {
    const binding = this.#sessionStore.read(key);
    this.#sessionStore.save(key, {
      id: session.id,
      generation: session.generation,
      providerSession: session.providerSession,
      lastEventId: session.lastEventId,
      lastRunId: session.lastRunId,
      initialContextPrepared: session.initialization?.attempted === true,
      ...(binding &&
      binding.id === session.id &&
      binding.generation === session.generation &&
      binding.gap
        ? { gap: binding.gap }
        : {})
    });
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#state = "stopped";
    this.#log("channel.stopped", { state: "stopped" });
    this.#error = undefined;
    this.#everOnline = false;
    this.#retry = 0;
    this.#abort.abort();
    this.#connectionAbort?.abort();
    if (this.#reconnect) {
      clearTimeout(this.#reconnect);
      this.#reconnect = undefined;
    }
    this.#closing = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      const attempt = async (operation: () => unknown): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          errors.push(error);
        }
      };
      await attempt(() => this.#connector?.close());
      await Promise.all(
        [...this.#sessions.values()]
          .filter((session) => session.activeInvocationId)
          .map((session) =>
            attempt(() => this.dependencies.host.cancel(session.activeInvocationId!, "IM shutdown"))
          )
      );
      await attempt(() => this.#connecting);
      await Promise.all([...this.#sessions.values()].map((session) => attempt(() => session.tail)));
      await Promise.all(this.#busyNotifications.values());
      if (!this.dependencies.sessions) await attempt(() => this.#sessionStore.close?.());
      if (errors.length) throw new AggregateError(errors, "IM_DISPOSE_FAILED");
      this.#sessions.clear();
      this.#seen.clear();
      this.#interactions.clear();
      this.#connector = undefined;
    });
    return this.#closing;
  }
}

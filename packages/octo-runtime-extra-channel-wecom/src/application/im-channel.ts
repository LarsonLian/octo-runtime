import type { JsonObject } from "@mininglamp-oss/octo-runtime-daemon";
/**
 * 单 Bot 编排：把授权 IM 消息转换成一次统一执行，并把公开结果投递回原会话。
 * 管理会话、排队、取消和交互归属；平台协议交给 connector，领域业务交给发起方。
 */
import { randomUUID } from "node:crypto";
import type {
  InteractionRequestedPayload,
  InteractionResponse
} from "@mininglamp-oss/octo-runtime-protocol";
import type {
  ImBotConfig,
  ImConnectionState,
  ImSession,
  ImInboundMessage,
  ImRunControls
} from "../contracts.js";
import type { ImModuleDependencies } from "../ports.js";
import { imBotIdentity, validateImConfig } from "../lifecycle/configuration.js";
import { WecomTransport } from "../transport/channel.js";
import { createImInvocation } from "../execution/dispatcher.js";
import { ImDeliveryDispatcher } from "../delivery/dispatcher.js";
import { ImRunProjector } from "../presentation/run-projector.js";
import { MemoryImSessionStore, type ImSessionStore } from "./session-store.js";

export class ImRuntime {
  readonly #preparing = new Map<string, AbortController>();
  readonly config: ImBotConfig;
  #connector?: WecomTransport;
  #delivery?: ImDeliveryDispatcher;
  readonly #sessions = new Map<string, ImSession>();
  readonly #sessionStore: ImSessionStore;
  readonly #seen = new Map<string, number>();
  readonly #queuedOccurrences = new Set<string>();
  readonly #interactions = new Map<
    string,
    { invocationId: string; key: string; senderId: string; request: InteractionRequestedPayload }
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
  #pending = 0;
  #retry = 0;
  constructor(
    config: ImBotConfig,
    readonly dependencies: ImModuleDependencies
  ) {
    validateImConfig(config);
    this.config = structuredClone(config);
    this.#sessionStore = dependencies.sessions ?? new MemoryImSessionStore();
  }
  get status(): Record<string, unknown> {
    return {
      ...this.#connector?.status,
      connection_key: imBotIdentity(this.config),
      type: "wecom",
      bot_name: this.config.bot_name ?? this.config.bot_id,
      enabled: this.config.enabled !== false,
      botId: this.#connector?.botId,
      connected: this.#state === "online",
      state: this.#state,
      error: this.#error ?? null,
      deliveries: this.#delivery?.receipts ?? [],
      sessions: [...this.#sessions.values()].map((session) => ({
        sessionId: session.id,
        generation: session.generation,
        runId: session.lastRunId,
        eventId: session.lastEventId,
        active: !!session.activeInvocationId
      }))
    };
  }
  async start(): Promise<void> {
    if (this.#closing) await this.#closing;
    this.dependencies.signal?.throwIfAborted();
    if (this.config.enabled === false) return;
    if (!this.#closed) return this.#connecting;
    this.#closed = false;
    this.#closing = undefined;
    this.#abort = new AbortController();
    this.#signal = AbortSignal.any([
      this.#abort.signal,
      ...(this.dependencies.signal ? [this.dependencies.signal] : [])
    ]);
    this.#delivery = new ImDeliveryDispatcher(this.#signal);
    this.#connecting = this.#connect();
    try {
      await this.#connecting;
    } finally {
      this.#connecting = undefined;
    }
  }
  async #connect(): Promise<void> {
    if (this.#closed || this.#signal.aborted) return;
    this.#connectionAbort?.abort();
    await this.#connector?.close();
    if (this.#closed || this.#signal.aborted) return;
    this.#connectionAbort = new AbortController();
    const signal = AbortSignal.any([this.#signal, this.#connectionAbort.signal]);
    const credentials =
      this.dependencies.credentials ?? ((config) => Promise.resolve(config.app_secret));
    const connector = new WecomTransport(this.config, credentials, {
      authorizeSpace: this.dependencies.authorizeSpace,
      onMessage: (message) => {
        if (connector === this.#connector && !signal.aborted) this.#receive(message);
      },
      onDiagnostic: (code) => {
        if (connector === this.#connector && !signal.aborted) this.#diagnostic(code);
      },
      onDisconnect: (code, retryable = true) => {
        if (connector !== this.#connector || this.#closed || signal.aborted) return;
        this.#error = code;
        if (!retryable) {
          this.#connectionAbort?.abort();
          void connector.close().catch(() => this.#diagnostic("IM_DISPOSE_FAILED"));
          this.#state = "stopped";
          if (this.#reconnect) {
            clearTimeout(this.#reconnect);
            this.#reconnect = undefined;
          }
          return;
        }
        this.#state = "retrying";
        this.#scheduleReconnect();
      }
    });
    this.#connector = connector;
    this.#state = "connecting";
    try {
      await connector.start(signal);
      if (signal.aborted) {
        await connector.close();
        return;
      }
      this.#state = "online";
      this.#log("channel.connected", { state: "online" });
      this.#error = undefined;
      this.#retry = 0;
    } catch (error) {
      if (signal.aborted) return;
      const code =
        error instanceof Error && /^(?:IM|WECOM)_[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "IM_CONNECTION_FAILED";
      this.#connectionAbort.abort();
      await connector.close();
      this.#error = code;
      if (this.#reconnect) {
        clearTimeout(this.#reconnect);
        this.#reconnect = undefined;
      }
      if (code === "IM_CREDENTIALS_REQUIRED") {
        // 账号可先登记后补凭据；每次重连重新调用宿主凭据源，无需重启 Daemon。
        this.#state = "waiting_credentials";
        this.#error = undefined;
        this.#scheduleReconnect();
      } else if (
        [
          "IM_BOT_TOKEN_INVALID",
          "IM_TENANT_NOT_ACTIVE",
          "IM_AUTH_HTTP_401",
          "IM_AUTH_HTTP_403",
          "IM_AUTH_IDENTITY_INVALID",
          "IM_BOT_IDENTITY_MISMATCH",
          "IM_REGISTER_HTTP_401",
          "IM_REGISTER_HTTP_403"
        ].includes(code) ||
        code.startsWith("WECOM_AUTH_REJECTED")
      )
        this.#state = "authentication_failed";
      else {
        this.#state = "retrying";
        this.#scheduleReconnect();
      }
    }
  }
  #scheduleReconnect(): void {
    if (this.#closed || this.#signal.aborted || this.#reconnect) return;
    this.#reconnect = setTimeout(
      () => {
        this.#reconnect = undefined;
        this.#connecting = this.#connect().finally(() => {
          this.#connecting = undefined;
        });
      },
      Math.min(30_000, 5_000 * 2 ** this.#retry++)
    );
    this.#reconnect.unref();
  }
  #diagnostic(code: string, runId?: string): void {
    this.#error = code;
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
  #key(message: ImInboundMessage): string {
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
          session.id = binding.id;
          session.generation = binding.generation;
          session.providerSession = binding.providerSession;
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
          const cancelled = preparation
            ? true
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
      session = {
        generation: 1,
        ...this.#sessionStore.read(key),
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
      cancel: async () =>
        this.#sessions.get(key)?.activeInvocationId === invocationId &&
        (await this.dependencies.host.cancel(invocationId, "IM card stop")).cancelled,
      retry: (senderId: string, id: string): boolean =>
        controls.failed && this.#enqueue({ ...message, senderId }, key, id)
    };
    return controls;
  }
  #enqueue(message: ImInboundMessage, key: string, occurrenceId?: string): boolean {
    if (this.#closed || this.#signal.aborted || this.#pending >= 64) {
      this.#diagnostic("IM_INBOUND_CAPACITY_EXHAUSTED");
      return false;
    }
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
      if (message.text.trim() !== "/session" && !session.id) {
        const binding = { id: `as_${randomUUID()}`, generation: session.generation };
        this.#sessionStore.save(key, binding);
        session.id = binding.id;
      }
      const executionSession = { ...session };
      this.#queuedOccurrences.add(queuedKey);
      session.pending++;
      this.#pending++;
      session.tail = session.tail
        .then(() => this.#turn(message, key, session, occurrenceId, executionSession))
        .catch(() => this.#diagnostic("IM_TURN_FAILED"))
        .finally(() => {
          this.#queuedOccurrences.delete(queuedKey);
          session.pending--;
          this.#pending--;
          this.#releaseSession(key, session);
        });
      return true;
    } finally {
      this.#releaseSession(key, session);
    }
  }
  async #reply(
    message: ImInboundMessage,
    text: string,
    effectKey: string,
    requireDelivered = false
  ): Promise<void> {
    if (this.#closed || this.#signal.aborted || !this.#delivery) return;
    const receipt = await this.#delivery.deliver(effectKey, () => message.reply(text, effectKey));
    if (receipt.state !== "delivered") {
      this.#diagnostic(receipt.code ?? "IM_DELIVERY_FAILED");
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
        entry.request.kind === "elicitation" ? (JSON.parse(match[3]) as unknown) : match[3];
    }
    if (this.#responding.has(response.interactionId)) return;
    this.#responding.add(response.interactionId);
    try {
      await this.dependencies.host.respondInteraction(entry.invocationId, response);
      this.#interactions.delete(response.interactionId);
    } finally {
      this.#responding.delete(response.interactionId);
    }
    await this.#reply(message, "已提交本次响应。", `interaction:${message.messageId}`);
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
    if (!prompt) return;
    if (prompt === "/session") {
      await this.#reply(
        message,
        `session=${session.id} generation=${session.generation}${session.lastRunId ? ` run=${session.lastRunId}` : ""}`,
        `control:${message.messageId}`
      );
      return;
    }
    // 准备阶段尚无 invocationId，用独立 controller 让 /stop 和卸载能够取消宿主 Context IO。
    const preparation = new AbortController();
    this.#preparing.set(key, preparation);
    const turnSignal = AbortSignal.any([this.#signal, preparation.signal]);
    let prepared: ReturnType<typeof createImInvocation>;
    try {
      if (session.id === executionSession.id)
        executionSession.providerSession = session.providerSession;
      // 每轮重新构造材料快照；Provider session 只续接执行，不承载或缓存 Context。
      prepared = createImInvocation(
        this.config,
        message,
        await message.buildContext(turnSignal, {
          // 先取得本轮完整配置快照，再交渠道构造业务材料；加载失败时不会进入 Provider。
          configuredItems: await this.dependencies.prepareContexts?.(
            this.config as unknown as JsonObject,
            turnSignal
          )
        }),
        key,
        executionSession,
        turnSignal,
        occurrenceId
      );
      if (session.id === prepared.request.sessionId) {
        session.lastEventId = executionSession.lastEventId;
        session.lastRunId = prepared.request.runId;
        this.#saveBinding(key, session);
      }
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
        "本轮输入或执行配置准备失败，尚未发起执行。请检查配置、会话权限或稍后重试。",
        `prepare:${occurrenceId ?? message.messageId}`
      );
      return;
    } finally {
      this.#preparing.delete(key);
    }
    if (this.#closed || this.#signal.aborted) return;
    const { request } = prepared;
    this.#log("agent_run.requested", {
      run_id: request.runId,
      invocation_id: request.invocationId,
      session_id: request.sessionId
    });
    const projector = new ImRunProjector(request.runId, message.conversationKind === "direct");
    const controls = this.#runControls(message, key, request.invocationId);
    const presentation = message.beginPresentation?.(
      request.runId,
      (code) => this.#diagnostic(code, request.runId),
      controls
    );
    presentation?.update(projector.snapshot());
    session.activeInvocationId = request.invocationId;
    try {
      for await (const event of this.dependencies.host.invoke(request, { signal: this.#signal })) {
        if (this.#closed || this.#signal.aborted) break;
        if (event.type === "session.update" && session.id === request.sessionId) {
          session.providerSession = event.payload.providerSession;
          this.#saveBinding(key, session);
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
          if (this.#interactions.size >= 64) throw new Error("IM_INTERACTION_CAPACITY_EXHAUSTED");
          this.#interactions.set(event.payload.interactionId, {
            invocationId: request.invocationId,
            key,
            senderId: message.senderId,
            request: structuredClone(event.payload)
          });
          const interaction = event.payload;
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
          await this.#reply(
            message,
            `${summary?.slice(0, 1000) ?? "执行需要你的确认或输入。"}\n${instruction}`,
            `interaction:${interaction.interactionId}`
          );
        }
        if (event.type === "interaction.resolved")
          this.#interactions.delete(event.payload.interactionId);
        projector.accept(event);
        controls.failed = projector.snapshot().terminal === "failed";
        presentation?.update(projector.snapshot());
      }
      if (!projector.snapshot().terminal) throw new Error("IM_RUN_WITHOUT_TERMINAL");
    } catch {
      if (!projector.snapshot().terminal) {
        // 流断开无法证明执行失败；尽力取消并提示核查，不自动重跑潜在的业务副作用。
        await this.dependencies.host
          .cancel(request.invocationId, "IM execution stream failed")
          .catch(() => undefined);
        this.#diagnostic("IM_EXECUTION_RESULT_UNKNOWN", request.runId);
        presentation?.update({ ...projector.snapshot(), resultUnknown: true });
      }
    } finally {
      this.#log("agent_run.finished", {
        run_id: request.runId,
        invocation_id: request.invocationId,
        session_id: request.sessionId,
        status: projector.snapshot().terminal ?? "unknown"
      });
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
    const snapshot = projector.snapshot();
    const terminal = snapshot.terminal;
    const text =
      terminal === "completed"
        ? projector.finalText || "本轮执行完成，未返回文本。"
        : terminal === "cancelled"
          ? "本轮执行已中断。"
          : terminal === "failed"
            ? `本轮执行未成功，请查看运行记录。${snapshot.failure ? `\n错误码：${snapshot.failure.code}\n诊断编号：${snapshot.failure.diagnosticId}` : ""}`
            : "本轮执行结果未知，请查看运行记录，避免重复执行。";
    // 最终文本拥有独立投递身份，即使进度卡投递失败，也必须尝试回复用户。
    await this.#reply(message, text, `final:${request.runId}`);
  }
  #saveBinding(key: string, session: ImSession): void {
    this.#sessionStore.save(key, {
      id: session.id,
      generation: session.generation,
      providerSession: session.providerSession,
      lastEventId: session.lastEventId,
      lastRunId: session.lastRunId
    });
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#state = "stopped";
    this.#log("channel.stopped", { state: "stopped" });
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

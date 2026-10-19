/**
 * Octo 接入编排：直连 IM Server，完成身份准入、Context 读取、卡片与按钮回传。
 * 此通道就是 IM 事件发起方；只处理 IM 归属，不合成文档评论或其他领域请求。
 */
import { CONTEXT_SCHEMA } from "@mininglamp-oss/octo-runtime-protocol";
import type { ChannelCallbacks, OctoBotConfig, ImRunControls, ImAddress } from "../contracts.js";
import type { InteractionRequestedPayload } from "@mininglamp-oss/octo-runtime-protocol";
import { interactionCard, interactionAnswer } from "./interaction-card.js";
import type { ImCredentialSource } from "../ports.js";
import { imBotIdentity } from "../lifecycle/configuration.js";
import { verifyBotIdentity } from "./auth.js";
import { registerBot, WukongConnection } from "./wukong.js";
import { acceptsImMessage, groupScope } from "./normalize.js";
import { build_im_contexts } from "./contexts.js";
import { OctoConnector, stableEffectKey } from "./connector.js";
import { CardSession } from "./card-session.js";
import { TypingController } from "../presentation/typing.js";
import { ImRunProjector } from "../presentation/run-projector.js";
import { buildReasoningFrame } from "./reasoning-frame.js";
import { ImDeliveryDispatcher } from "../delivery/dispatcher.js";
import { fetchBotEvents, ackBotEvent } from "./api/events.js";
import { parseCardAction } from "./card-action.js";
import { setTimeout as delay } from "node:timers/promises";
import { octoCliEnvironment } from "../execution/tool-environment.js";
import { downloadImageInput } from "./image-input.js";
import { prepareFinalMention } from "./mentions.js";
import { getGroupMembers, type GroupMember } from "./api/conversations.js";
import { getJson } from "./api/client.js";
import { connectionFailure, ImConnectionError } from "./connection-error.js";
import { sendReadReceipt } from "./api/messages.js";
import { deliveryNoticeCard } from "../presentation/delivery-notice.js";
import { ImSendError } from "../delivery/text-send.js";
import type { ImGapTurnToken } from "../application/context-gap.js";
import { observesImScope } from "./normalize.js";

/** Octo IM 平台连接器：WuKong 与 Octo REST 适配；不是 MCP 连接器。 */
export class GatewayTransport {
  identity: string;
  readonly botId: string;
  #detachAbort?: () => void;
  #closing?: Promise<void>;
  #connection?: WukongConnection;
  #spaceId = "";
  get scopedConfig() {
    return { ...this.config, spaceId: this.#spaceId };
  }
  #connected = false;
  #closed = true;
  #abort = new AbortController();
  #typing?: TypingController;
  #api?: OctoConnector;
  #delivery?: ImDeliveryDispatcher;
  #polling?: Promise<void>;
  readonly #bindings = new Map<
    string,
    {
      card: CardSession;
      address: ImAddress;
      senderId: string;
      controls: ImRunControls;
      expires: number;
      active: boolean;
      turn?: ImGapTurnToken;
      interactions: Map<string, { request: InteractionRequestedPayload; messageId: string }>;
    }
  >();
  constructor(
    readonly config: OctoBotConfig,
    readonly credentials: ImCredentialSource,
    readonly callbacks: ChannelCallbacks
  ) {
    this.identity = imBotIdentity(config);
    this.botId = config.bot_id;
  }
  get status() {
    return { connected: this.#connected, cardDeliveries: this.#delivery?.receipts ?? [] };
  }
  async start(signal: AbortSignal): Promise<void> {
    this.#closed = false;
    signal = AbortSignal.any([signal, this.#abort.signal]);
    const token = (await this.credentials(this.config, signal))?.trim();
    if (!token) throw new Error("IM_CREDENTIALS_REQUIRED");
    if (!/^bf_[A-Za-z0-9_-]+$/.test(token)) throw new Error("IM_BOT_TOKEN_INVALID");
    const principal = await verifyBotIdentity(this.config.api_url, token, signal);
    if (principal.bot_uid !== this.config.bot_id) throw new Error("IM_BOT_IDENTITY_MISMATCH");
    this.callbacks.authorizeSpace?.(principal.space_id);
    this.#spaceId = principal.space_id;
    this.identity = `${imBotIdentity(this.config)}:${encodeURIComponent(this.#spaceId)}`;
    const registration = await registerBot(this.config.api_url, token, signal);
    const toolEnvironment = octoCliEnvironment(this.config.api_url, token);
    if (signal.aborted) return;
    if (registration.robot_id !== this.config.bot_id) throw new Error("IM_BOT_IDENTITY_MISMATCH");
    const connection = new WukongConnection(
      (message) => {
        if (this.#closed || !acceptsImMessage(this.scopedConfig, registration.owner_uid, message))
          return;
        let finalReply: { key: string; value: ReturnType<typeof prepareFinalMention> } | undefined;
        let historyTurn: ImGapTurnToken | undefined;
        const outputObserver = () => {
          const turn = historyTurn;
          if (!turn || !observesImScope(this.scopedConfig, message.channelId, message.channelType))
            return undefined;
          return (messageSeq: number) => {
            if (this.#closed || signal.aborted) return;
            this.callbacks.onPosition?.({
              conversationId: message.channelId,
              conversationKind: message.channelType === 5 ? "thread" : "group",
              messageSeq,
              own: true,
              turn
            });
          };
        };
        this.callbacks.onMessage({
          messageId: message.messageId,
          ...(message.channelType === 2 || message.channelType === 5
            ? {
                position: { messageSeq: message.messageSeq },
                bindHistoryTurn: (turn: ImGapTurnToken) => {
                  historyTurn = structuredClone(turn);
                }
              }
            : {}),
          markRead: (turnSignal) =>
            sendReadReceipt({
              apiUrl: this.config.api_url,
              botToken: token,
              channelId: message.channelId,
              channelType: message.channelType,
              messageIds: [message.messageId],
              signal: AbortSignal.any([signal, turnSignal])
            }),
          senderId: message.fromUid,
          conversationId: message.channelId,
          conversationKind:
            message.channelType === 1 ? "direct" : message.channelType === 5 ? "thread" : "group",
          text:
            message.payload.type === 2
              ? ""
              : message.payload.type === 11 || message.payload.type === 14
                ? `收到一条${message.payload.type === 14 ? "富文本" : "合并转发"}新消息；正文见本轮 extra.im/message-content。`
                : message.payload.type === 8 || message.payload.type === 18
                  ? typeof message.payload.content === "string" && message.payload.content.trim()
                    ? message.payload.content
                    : "请根据本轮资源上下文处理此资源。"
                  : String(message.payload.content),
          ...(message.payload.type === 2
            ? {
                buildInputs: (turnSignal: AbortSignal) =>
                  downloadImageInput(
                    message.payload.url,
                    this.config.api_url,
                    token,
                    AbortSignal.any([signal, turnSignal])
                  )
              }
            : {}),
          executionEnvironment: () => {
            if (this.#closed || signal.aborted) throw new Error("IM_CONNECTION_REPLACED");
            return { executionEnvOverrides: structuredClone(toolEnvironment) };
          },
          runMetadata: {
            spaceId: this.#spaceId,
            botId: this.config.bot_id,
            channelType: message.channelType
          },
          isReplyDelivered: (effectKey) =>
            connection.isDelivered(stableEffectKey(this.identity, message, effectKey, "text")),
          replyDeliveryUnknown: async (event, effectKey, replyEffectKey, deliverySignal) => {
            if (
              deliverySignal.aborted ||
              connection.isDelivered(
                stableEffectKey(this.identity, message, replyEffectKey, "text")
              )
            )
              return;
            // F27：REST 跟随 Bot/Extra 的投递期限，不跟随已断开的 WS 连接期限。
            const rest = new OctoConnector(this.config, token, deliverySignal, async () => {});
            const sent = await rest.displayCard(
              message,
              deliveryNoticeCard(event),
              stableEffectKey(this.identity, message, effectKey, "delivery"),
              () =>
                connection.isDelivered(
                  stableEffectKey(this.identity, message, replyEffectKey, "text")
                )
            );
            if (
              !sent &&
              !connection.isDelivered(
                stableEffectKey(this.identity, message, replyEffectKey, "text")
              )
            )
              throw new ImSendError("IM_DELIVERY_NOTICE_UNSUPPORTED", "failed");
          },
          replyFailure: async (event, effectKey) => {
            if (this.#closed || signal.aborted) return;
            const template = await this.#api!.reasoningTemplate();
            if (!template) return;
            const projector = new ImRunProjector(`channel:${effectKey}`, message.channelType === 1);
            projector.accept(event);
            const frame = buildReasoningFrame(projector.snapshot(), template);
            if (!frame) throw Error("IM_CARD_BUDGET_EXCEEDED");
            await this.#api!.card(
              message,
              template,
              frame,
              stableEffectKey(this.identity, message, effectKey, "error"),
              undefined,
              1,
              false
            );
          },
          reply: async (text, effectKey) => {
            // 闭包绑定接收消息的连接和地址；配置替换后不把旧 Run 的回复转到新账号。
            if (this.#closed || signal.aborted) throw new Error("IM_CONNECTION_REPLACED");
            const key = stableEffectKey(
              this.identity,
              message,
              effectKey ?? message.messageId,
              "text"
            );
            await connection.sendText(
              message.channelId,
              message.channelType,
              text,
              key,
              this.#spaceId,
              undefined,
              undefined,
              outputObserver()
            );
          },
          replyFinal: async (text, effectKey) => {
            if (this.#closed || signal.aborted) throw new Error("IM_CONNECTION_REPLACED");
            if (finalReply?.key !== effectKey)
              finalReply = {
                key: effectKey,
                value: prepareFinalMention(text, async () => {
                  if ([2, 5].includes(message.channelType))
                    return getGroupMembers({
                      apiUrl: this.config.api_url,
                      botToken: token,
                      groupNo: groupScope(message.channelId).groupNo,
                      signal
                    });
                  const peer = await getJson<GroupMember>(
                    this.config.api_url,
                    token,
                    `/v1/bot/user/info?uid=${encodeURIComponent(message.fromUid)}`,
                    AbortSignal.any([signal, AbortSignal.timeout(5000)]),
                    { maxResponseBytes: 64 << 10, logRateLimit: false }
                  );
                  return peer?.uid === message.fromUid ? [peer] : [];
                })
              };
            const result = await finalReply.value;
            if (this.#closed || signal.aborted) throw new Error("IM_CONNECTION_REPLACED");
            await connection.sendText(
              message.channelId,
              message.channelType,
              result.text,
              stableEffectKey(this.identity, message, effectKey, "text"),
              this.#spaceId,
              result.mention,
              undefined,
              outputObserver()
            );
          },
          buildContext: async (turnSignal, options) => ({
            schema: CONTEXT_SCHEMA,
            items: await build_im_contexts(
              this.scopedConfig,
              message,
              token,
              AbortSignal.any([signal, turnSignal]),
              options
            )
          }),
          beginPresentation: (runId, onDiagnostic, controls) => {
            const interactions = new Map<
              string,
              { request: InteractionRequestedPayload; messageId: string }
            >();
            const resolveInteraction = async (id: string, status: string) => {
              const entry = interactions.get(id);
              if (!entry) return;
              interactions.delete(id);
              await this.#api!.interactionCard(
                message,
                interactionCard(entry.request, status),
                stableEffectKey(this.identity, message, id, "interaction"),
                entry.messageId
              );
            };
            const stopTyping =
              this.config.typing === false ? () => {} : this.#typing!.acquire(message, runId);
            const card = new CardSession(
              this.#api!,
              this.#delivery!,
              message,
              runId,
              stopTyping,
              onDiagnostic
            );
            this.#bindings.set(runId, {
              card,
              address: message,
              senderId: message.fromUid,
              controls,
              expires: Date.now() + 86_400_000 + 30 * 60_000,
              active: true,
              turn: historyTurn,
              interactions
            });
            if (this.#bindings.size > 128) {
              const idle = [...this.#bindings].find(([, binding]) => !binding.active);
              if (idle) this.#bindings.delete(idle[0]);
            }
            if (!this.#polling)
              this.#polling = this.#pollActions(token, registration.owner_uid, signal);
            return {
              interaction: async (request) => {
                const document = interactionCard(request);
                const effect = stableEffectKey(
                  this.identity,
                  message,
                  request.interactionId,
                  "interaction"
                );
                let messageId: string | undefined;
                const receipt = await this.#delivery!.deliver(effect, async () => {
                  messageId = await this.#api!.interactionCard(message, document, effect);
                  if (!messageId) throw Error("IM_INTERACTION_CARD_UNAVAILABLE");
                  return messageId;
                });
                if (receipt.state !== "delivered" || !receipt.messageId) return false;
                interactions.set(request.interactionId, {
                  request: structuredClone(request),
                  messageId: receipt.messageId
                });
                return true;
              },
              resolveInteraction,
              update: (snapshot) => card.update(snapshot),
              finish: async () => {
                try {
                  for (const id of interactions.keys()) {
                    try {
                      await resolveInteraction(id, "invalidated");
                    } catch {
                      onDiagnostic("IM_INTERACTION_CARD_FAILED");
                    }
                  }
                  await card.finish();
                } finally {
                  const binding = this.#bindings.get(runId);
                  if (binding) {
                    binding.active = false;
                    binding.expires = Date.now() + 30 * 60_000;
                  }
                }
              }
            };
          }
        });
      },
      (error) => {
        this.#connected = false;
        const failure = connectionFailure(error);
        this.callbacks.onDisconnect(failure.message, failure.retryable);
      },
      (position) => {
        if (
          this.#closed ||
          signal.aborted ||
          !observesImScope(
            this.scopedConfig,
            position.channelId,
            position.channelType,
            position.spaceId
          )
        )
          return;
        const own = position.fromUid === this.config.bot_id;
        const binding = own
          ? [...this.#bindings.values()].find(
              (candidate) =>
                candidate.address.channelId === position.channelId &&
                candidate.address.channelType === position.channelType &&
                (candidate.card.effectKey === position.clientMsgNo ||
                  candidate.card.messageId === position.messageId ||
                  [...candidate.interactions.values()].some(
                    (entry) => entry.messageId === position.messageId
                  ))
            )
          : undefined;
        this.callbacks.onPosition?.({
          conversationId: position.channelId,
          conversationKind: position.channelType === 5 ? "thread" : "group",
          messageSeq: position.messageSeq,
          own,
          ...(binding?.turn ? { turn: binding.turn } : {})
        });
      }
    );
    this.#connection = connection;
    this.#api = new OctoConnector(this.config, token, signal, async (address, text, effectKey) => {
      if (this.#closed || signal.aborted) throw new Error("IM_CONNECTION_REPLACED");
      await connection.sendText(
        address.channelId,
        address.channelType,
        text,
        effectKey,
        this.#spaceId
      );
    });
    this.#delivery = new ImDeliveryDispatcher(signal);
    this.#typing = new TypingController(
      (address, typingSignal) => this.#api!.typing(address, typingSignal),
      () => this.callbacks.onDiagnostic?.("IM_TYPING_FAILED")
    );
    const abort = (): void => {
      void connection.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    this.#detachAbort = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) return;
    await connection.connect(registration);
    if (signal.aborted) {
      await connection.close();
      return;
    }
    if (!connection.connected) throw new ImConnectionError("IM_DISCONNECTED", true);
    this.#connected = true;
  }
  async #pollActions(token: string, owner: string, signal: AbortSignal): Promise<void> {
    if (this.config.cards === false) return;
    let cursor = 0,
      failures = 0;
    const handled = new Set<number>();
    while (!signal.aborted && !this.#closed) {
      const started = Date.now();
      try {
        const events = await fetchBotEvents({
          apiUrl: this.config.api_url,
          botToken: token,
          sinceEventId: cursor,
          limit: 100,
          waitSeconds: 30,
          signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)])
        });
        for (const event of events.sort((a, b) => a.event_id - b.event_id)) {
          if (signal.aborted) return;
          if (!Number.isSafeInteger(event.event_id) || event.event_id <= cursor) continue;
          // cursor 仅记录本地读取位置；不认识的领域事件不 ACK，也不转换成 IM 请求。
          const action = parseCardAction(event);
          if (!action) {
            cursor = event.event_id;
            continue;
          }
          if (
            action.spaceId !== this.#spaceId ||
            !(this.config.allowed_sender_ids ?? [owner]).includes(action.operatorUid)
          ) {
            cursor = event.event_id;
            continue;
          }
          let consumed = handled.has(event.event_id);
          for (const [id, binding] of this.#bindings) {
            if (consumed) break;
            if (binding.expires <= Date.now()) {
              this.#bindings.delete(id);
              continue;
            }
            const sameAddress =
              binding.address.channelId === action.channelId ||
              (Number(action.channelType) === 1 &&
                binding.address.channelId === `s${this.#spaceId}_${action.channelId}`);
            // 操作者、空间、原消息和地址均匹配才允许控制 Run，不信任表单中的归属声明。
            const interaction = [...binding.interactions.values()].find(
              (entry) => entry.messageId === action.messageId
            );
            if (
              (binding.card.messageId !== action.messageId && !interaction) ||
              binding.address.channelType !== Number(action.channelType) ||
              binding.senderId !== action.operatorUid ||
              !sameAddress
            )
              continue;
            if (interaction && action.actionId.startsWith("interaction_")) {
              if (!binding.active || !binding.controls.respond) continue;
              await binding.controls.respond(interactionAnswer(interaction.request, action));
              binding.interactions.delete(interaction.request.interactionId);
              try {
                await this.#api!.interactionCard(
                  binding.address,
                  interactionCard(interaction.request, "resolved"),
                  stableEffectKey(
                    this.identity,
                    binding.address,
                    interaction.request.interactionId,
                    "interaction"
                  ),
                  interaction.messageId
                );
              } catch {
                this.callbacks.onDiagnostic?.("IM_INTERACTION_CARD_FAILED");
              }
            } else if (!interaction && action.actionId === "reasoning_stop")
              await binding.controls.cancel();
            else if (!interaction && action.actionId === "reasoning_retry")
              binding.controls.retry(action.operatorUid, `card_action:${event.event_id}`);
            else continue;
            consumed = true;
            handled.add(event.event_id);
            break;
          }
          if (consumed) {
            await ackBotEvent({
              apiUrl: this.config.api_url,
              botToken: token,
              eventId: event.event_id,
              signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
            });
            handled.delete(event.event_id);
          }
          cursor = event.event_id;
          for (const id of handled) if (id <= cursor) handled.delete(id);
        }
        failures = 0;
        if (Date.now() - started < 1000) await delay(2_000, undefined, { signal });
      } catch {
        if (signal.aborted) return;
        this.callbacks.onDiagnostic?.("IM_CARD_ACTION_POLL_FAILED");
        try {
          await delay(Math.min(30_000, 2_000 * 2 ** failures++), undefined, { signal });
        } catch {
          return;
        }
      }
    }
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#connected = false;
    this.#abort.abort();
    this.#detachAbort?.();
    this.#closing = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.#typing?.close()),
        Promise.resolve().then(() => this.#connection?.close()),
        this.#polling
      ]);
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result): unknown => result.reason);
      if (errors.length) throw new AggregateError(errors, "IM_TRANSPORT_DISPOSE_FAILED");
      this.#bindings.clear();
    });
    return this.#closing;
  }
}

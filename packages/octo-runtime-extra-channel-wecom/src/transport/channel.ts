/**
 * 企业微信平台适配：将授权文本映射为统一 IM 事件，并绑定原会话 stream 回复。
 * 执行与会话策略复用公共编排；不注册 MCP 工具，也不继承客户 App 的聊天设置。
 */
import { CONTEXT_SCHEMA } from "@mininglamp-oss/octo-runtime-protocol";
import type { ChannelCallbacks, WecomBotConfig } from "../contracts.js";
import type { ImCredentialSource } from "../ports.js";
import { imBotIdentity } from "../lifecycle/configuration.js";
import { WecomConnection, type WecomMessageFrame } from "./connection.js";
import { WecomStreamSession } from "./stream-session.js";

/** 企业微信 IM 平台连接器；不是 MCP。只处理平台准入、消息映射和 stream 回复。 */
export class WecomTransport {
  readonly identity: string;
  readonly botId: string;
  #detachAbort?: () => void;
  #closing?: Promise<void>;
  #connection?: WecomConnection;
  readonly #streams = new Set<WecomStreamSession>();
  constructor(
    readonly config: WecomBotConfig,
    readonly credentials: ImCredentialSource,
    readonly callbacks: ChannelCallbacks
  ) {
    this.identity = imBotIdentity(config);
    this.botId = config.bot_id;
  }
  get status() {
    return { ...this.#connection?.status, connected: this.#connection?.status.connected ?? false };
  }
  async start(signal: AbortSignal): Promise<void> {
    const secret = await this.credentials(this.config, signal);
    if (!secret) throw new Error("IM_CREDENTIALS_REQUIRED");
    if (signal.aborted) return;
    const connection = new WecomConnection(
      { wsUrl: this.config.ws_url },
      {
        onMessage: (frame) => this.#receive(frame, connection),
        onDisconnect: (code) =>
          this.callbacks.onDisconnect(code, code !== "WECOM_CONNECTION_REPLACED")
      }
    );
    this.#connection = connection;
    const abort = (): void => {
      void connection.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    this.#detachAbort = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) return;
    await connection.connect({ appBot: this.config.bot_id, appSecret: secret });
    if (signal.aborted) await connection.close();
  }
  #receive(frame: WecomMessageFrame, connection: WecomConnection): void {
    const body = frame.body;
    // 企业微信可见范围 / 会话权限是默认准入；用户白名单仅为宿主可选的进一步限制。
    if (
      !body ||
      body.aibotid !== this.config.bot_id ||
      body.msgtype !== "text" ||
      typeof body.msgid !== "string" ||
      !body.msgid ||
      typeof frame.headers?.req_id !== "string" ||
      !frame.headers.req_id ||
      typeof body.from?.userid !== "string" ||
      !body.from.userid ||
      typeof body.text?.content !== "string" ||
      !["single", "group"].includes(body.chattype)
    )
      return;
    const conversationId = body.chattype === "single" ? body.from.userid : body.chatid;
    if (!conversationId || typeof conversationId !== "string") return;
    const stream = new WecomStreamSession((streamId, text, finish) =>
      connection.replyStream(frame.headers.req_id, streamId, fitReply(text), finish)
    );
    this.callbacks.onMessage({
      messageId: body.msgid,
      senderId: body.from.userid,
      conversationId,
      conversationKind: body.chattype === "single" ? "direct" : "group",
      text: body.text.content,
      buildContext: (_signal, options) =>
        Promise.resolve({
          schema: CONTEXT_SCHEMA,
          items: structuredClone([
            ...(options?.configuredItems ?? this.config.context?.items ?? [])
          ])
        }),
      beginPresentation: (_runId, onDiagnostic) => {
        this.#streams.add(stream);
        return stream.begin(onDiagnostic);
      },
      reply: (text, effectKey) =>
        stream.reply(text, effectKey).finally(() => {
          if (effectKey?.startsWith("final:")) this.#streams.delete(stream);
        })
    });
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#detachAbort?.();
    this.#closing = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        ...[...this.#streams].map((stream) => Promise.resolve().then(() => stream.close())),
        Promise.resolve().then(() => this.#connection?.close())
      ]);
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result): unknown => result.reason);
      if (errors.length) throw new AggregateError(errors, "IM_TRANSPORT_DISPOSE_FAILED");
      this.#streams.clear();
    });
    return this.#closing;
  }
}

function fitReply(text: string): string {
  if (Buffer.byteLength(text) <= 20_480) return text;
  const suffix = "\n\n（回复超过企业微信长度上限，已截断。）";
  const budget = 20_480 - Buffer.byteLength(suffix);
  let bytes = 0,
    result = "";
  for (const rune of text) {
    bytes += Buffer.byteLength(rune);
    if (bytes > budget) break;
    result += rune;
  }
  return result + suffix;
}

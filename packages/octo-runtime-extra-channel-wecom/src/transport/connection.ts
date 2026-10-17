/**
 * 企业微信长连接：处理机器人鉴权、心跳 ACK、请求匹配和断线通知。
 * 被其他连接替换时停止本连接，避免两个实例争抢同一账号；不管理模型执行。
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export interface WecomCredentials {
  /** 企业微信智能机器人 Bot ID；协议字段为 bot_id。 */
  appBot: string;
  /** 企业微信智能机器人 Secret；协议字段为 secret。 */
  appSecret: string;
}

export interface WecomConnectionOptions {
  wsUrl?: string;
  heartbeatIntervalMs?: number;
  requestTimeoutMs?: number;
}

export interface WecomMessageFrame {
  cmd: "aibot_msg_callback";
  headers: { req_id: string };
  body: {
    msgid: string;
    aibotid: string;
    chatid?: string;
    chattype: "single" | "group";
    from: { userid: string };
    msgtype: string;
    text?: { content: string };
  };
}

export interface WecomConnectionCallbacks {
  onMessage?(frame: WecomMessageFrame): void;
  onDisconnect?(code: string): void;
}

export interface WecomConnectionStatus {
  connected: boolean;
  authenticatedAt?: string;
  heartbeatAcks: number;
  lastHeartbeatAt?: string;
  error?: string;
}

interface PendingRequest {
  command: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** 企业微信 IM 传输：鉴权、心跳、消息回调和回复；不是 MCP 连接器，不发起 AgentRun。 */
export class WecomConnection {
  readonly #url: string;
  readonly #heartbeatIntervalMs: number;
  readonly #requestTimeoutMs: number;
  #socket?: WebSocket;
  #closing?: Promise<void>;
  #heartbeat?: NodeJS.Timeout;
  #ping?: Promise<void>;
  #closed = false;
  #status: WecomConnectionStatus = { connected: false, heartbeatAcks: 0 };
  readonly #pending = new Map<string, PendingRequest>();

  constructor(
    options: WecomConnectionOptions = {},
    readonly callbacks: WecomConnectionCallbacks = {}
  ) {
    this.#url = options.wsUrl ?? "wss://openws.work.weixin.qq.com";
    const url = new URL(this.#url);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "wss:" &&
        !(url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
    ) {
      throw new Error("WECOM_WS_URL_INVALID");
    }
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    for (const value of [this.#heartbeatIntervalMs, this.#requestTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 300_000)
        throw new Error("WECOM_TIMEOUT_INVALID");
    }
  }

  get status(): WecomConnectionStatus {
    return { ...this.#status };
  }

  async connect(credentials: WecomCredentials): Promise<void> {
    if (this.#socket || this.#closed) throw new Error("WECOM_CONNECTION_ALREADY_USED");
    if (
      typeof credentials.appBot !== "string" ||
      !credentials.appBot.trim() ||
      typeof credentials.appSecret !== "string" ||
      !credentials.appSecret.trim()
    )
      throw new Error("WECOM_CREDENTIALS_REQUIRED");
    const socket = new WebSocket(this.#url, {
      handshakeTimeout: this.#requestTimeoutMs,
      maxPayload: 1024 * 1024,
      followRedirects: false
    });
    this.#socket = socket;
    socket.on("message", (data, binary) => {
      try {
        if (binary) throw new Error("WECOM_FRAME_INVALID");
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
        const frame = JSON.parse(bytes.toString()) as {
          cmd?: string;
          headers?: { req_id?: string };
          errcode?: number;
          body?: { event?: { eventtype?: string } };
        };
        if (!frame || typeof frame !== "object" || Array.isArray(frame))
          throw new Error("WECOM_FRAME_INVALID");
        if (
          frame.cmd === "aibot_event_callback" &&
          frame.body?.event?.eventtype === "disconnected_event"
        ) {
          this.#fail("WECOM_CONNECTION_REPLACED");
          return;
        }
        if (frame.cmd === "aibot_msg_callback") {
          this.callbacks.onMessage?.(frame as WecomMessageFrame);
          return;
        }
        // 回调推送不是鉴权或心跳 ACK，不记录其正文。
        if (frame.cmd) return;
        const reqId = frame.headers?.req_id;
        if (typeof reqId !== "string") return;
        // ACK 必须回到对应请求；不能把普通推送或过期 ACK 当作鉴权/心跳成功。
        const pending = this.#pending.get(reqId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(reqId);
        if (frame.errcode === 0) pending.resolve();
        else {
          const code = Number.isSafeInteger(frame.errcode) ? String(frame.errcode) : "INVALID_ACK";
          pending.reject(
            new Error(
              `WECOM_${pending.command === "aibot_subscribe" ? "AUTH" : pending.command === "ping" ? "HEARTBEAT" : "REPLY"}_REJECTED_${code}`
            )
          );
        }
      } catch {
        this.#fail("WECOM_FRAME_INVALID");
      }
    });
    socket.on("error", () => this.#fail("WECOM_WS_ERROR"));
    socket.on("close", () => {
      if (!this.#closed) this.#fail("WECOM_DISCONNECTED");
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          socket.off("open", opened);
          socket.off("close", failed);
          socket.off("error", failed);
        };
        const opened = (): void => {
          cleanup();
          resolve();
        };
        const failed = (): void => {
          cleanup();
          reject(new Error(this.#status.error ?? "WECOM_DISCONNECTED"));
        };
        socket.once("open", opened);
        socket.once("close", failed);
        socket.once("error", failed);
      });
      await this.#request("aibot_subscribe", {
        bot_id: credentials.appBot,
        secret: credentials.appSecret
      });
      if (this.#closed || socket.readyState !== WebSocket.OPEN)
        throw new Error("WECOM_DISCONNECTED");
      this.#status.connected = true;
      this.#status.authenticatedAt = new Date().toISOString();
      this.#heartbeat = setInterval(() => {
        void this.ping().catch(() => {}); // ping 已记录错误并关闭失效连接。
      }, this.#heartbeatIntervalMs);
      this.#heartbeat.unref();
    } catch (error) {
      const code = error instanceof Error ? error.message : "WECOM_CONNECTION_FAILED";
      this.#fail(code);
      throw new Error(this.#status.error, { cause: error });
    }
  }

  /** 只有 req_id 匹配且 errcode=0 的服务端回执才计为心跳成功。 */
  ping(): Promise<void> {
    if (this.#ping) return this.#ping;
    if (!this.#status.connected || this.#closed)
      return Promise.reject(new Error("WECOM_NOT_READY"));
    this.#ping = this.#request("ping")
      .then(() => {
        this.#status.heartbeatAcks++;
        this.#status.lastHeartbeatAt = new Date().toISOString();
      })
      .catch((error: Error) => {
        this.#fail(error.message);
        throw error;
      })
      .finally(() => {
        this.#ping = undefined;
      });
    return this.#ping;
  }

  replyStream(reqId: string, streamId: string, content: string, finish: boolean): Promise<void> {
    if (!this.#status.connected || !reqId || !streamId)
      return Promise.reject(new Error("WECOM_NOT_READY"));
    if (Buffer.byteLength(content) > 20_480)
      return Promise.reject(new Error("WECOM_REPLY_TOO_LARGE"));
    return this.#request(
      "aibot_respond_msg",
      { msgtype: "stream", stream: { id: streamId, content, finish } },
      reqId
    );
  }

  #request(command: string, body?: Record<string, unknown>, requestId?: string): Promise<void> {
    const socket = this.#socket;
    if (this.#closed || socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("WECOM_NOT_READY"));
    const reqId = requestId ?? `${command}_${randomUUID()}`;
    if (this.#pending.has(reqId)) return Promise.reject(new Error("WECOM_REQUEST_PENDING"));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(reqId);
        reject(
          new Error(
            command === "ping"
              ? "WECOM_HEARTBEAT_TIMEOUT"
              : command === "aibot_subscribe"
                ? "WECOM_AUTH_TIMEOUT"
                : "WECOM_REPLY_TIMEOUT"
          )
        );
      }, this.#requestTimeoutMs);
      this.#pending.set(reqId, { command, resolve, reject, timer });
      socket.send(
        JSON.stringify({ cmd: command, headers: { req_id: reqId }, ...(body ? { body } : {}) }),
        (error) => {
          if (error) this.#fail("WECOM_SEND_FAILED");
        }
      );
    });
  }

  #fail(code: string): void {
    const notify = !this.#closed;
    if (!this.#closed) this.#status.error ??= code;
    void this.close();
    if (notify) this.callbacks.onDisconnect?.(this.#status.error ?? code);
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#status.connected = false;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(this.#status.error ?? "WECOM_CLOSED"));
    }
    this.#pending.clear();
    const socket = this.#socket;
    this.#closing =
      !socket || socket.readyState === WebSocket.CLOSED
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            socket.once("close", resolve);
            socket.terminate();
          });
    return this.#closing;
  }
}

/**
 * WuKong 传输：负责 Bot 注册、加密握手、二进制帧编解码和收发确认。
 * 保留原通道的协议兼容性；授权、Context 和执行策略由上层处理。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomUUID
} from "node:crypto";
import WebSocket from "ws";
import { ImSendError, ImTextSend } from "../delivery/text-send.js";
import type { ImTextMention } from "./mentions.js";
import {
  connectionFetch,
  connectionJson,
  httpConnectionFailure,
  ImConnectionError
} from "./connection-error.js";

export interface ImMessage {
  messageId: string;
  messageSeq: number;
  fromUid: string;
  channelId: string;
  channelType: number;
  timestamp: number;
  payload: Record<string, unknown>;
}
export interface BotRegistration {
  robot_id: string;
  im_token: string;
  ws_url: string;
  owner_uid: string;
  owner_channel_id: string;
}
const LIMIT = 1 << 20;
const md5 = (value: string): string => createHash("md5").update(value).digest("hex");

export async function registerBot(
  apiUrl: string,
  token: string,
  signal?: AbortSignal
): Promise<BotRegistration> {
  const response = await connectionFetch(
    `${apiUrl.replace(/\/$/, "")}/v1/bot/register`,
    {
      method: "POST",
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_platform: "octo-runtime-extra-channel-gateway",
        agent_version: "0.1.0"
      })
    },
    "REGISTER"
  );
  if (!response.ok) {
    throw await httpConnectionFailure(response, "REGISTER");
  }
  const data = (await connectionJson(
    response,
    "REGISTER",
    "IM_REGISTRATION_INVALID"
  )) as BotRegistration;
  if (
    !data ||
    [data.robot_id, data.im_token, data.ws_url].some((value) => typeof value !== "string" || !value)
  )
    throw new Error("IM_REGISTRATION_INVALID");
  const url = new URL(data.ws_url);
  if (!["wss:", "ws:"].includes(url.protocol) || url.username || url.password)
    throw new Error("IM_WS_URL_INVALID");
  if (url.protocol === "ws:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("IM_WS_TLS_REQUIRED");
  return data;
}

class Writer {
  chunks: Buffer[] = [];
  byte(n: number): this {
    this.chunks.push(Buffer.from([n]));
    return this;
  }
  u32(n: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    this.chunks.push(b);
    return this;
  }
  u64(n: bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(n);
    this.chunks.push(b);
    return this;
  }
  string(s: string): this {
    const b = Buffer.from(s);
    if (b.length > 65535) throw new Error("IM_FIELD_TOO_LARGE");
    const h = Buffer.alloc(2);
    h.writeUInt16BE(b.length);
    this.chunks.push(h, b);
    return this;
  }
  bytes(b: Buffer): this {
    this.chunks.push(b);
    return this;
  }
  finish(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
class Reader {
  offset = 0;
  constructor(readonly data: Buffer) {}
  take(n: number): Buffer {
    if (this.offset + n > this.data.length) throw new Error("IM_FRAME_TRUNCATED");
    const value = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return value;
  }
  byte(): number {
    return this.take(1)[0];
  }
  u32(): number {
    return this.take(4).readUInt32BE();
  }
  u64(): bigint {
    return this.take(8).readBigUInt64BE();
  }
  string(): string {
    return this.take(this.take(2).readUInt16BE()).toString();
  }
  rest(): Buffer {
    return this.take(this.data.length - this.offset);
  }
}
function frame(kind: number, body: Buffer, flags = 0): Buffer {
  const length: number[] = [];
  let n = body.length;
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 128;
    length.push(b);
  } while (n);
  return Buffer.concat([Buffer.from([(kind << 4) | flags, ...length]), body]);
}

/** 每个机器人独占 WuKong v4 连接和加密状态；此层只处理传输，不调用模型。 */
export class WukongConnection {
  #socket?: WebSocket;
  #closing?: Promise<void>;
  #key?: Buffer;
  #iv?: Buffer;
  #version = 0;
  #buffer = Buffer.alloc(0);
  #seq = 0;
  #heartbeat?: NodeJS.Timeout;
  #lastPacket = Date.now();
  #closed = false;
  #ready = false;
  #sends = new Map<
    number,
    {
      operation: ImTextSend;
      key: string;
      channelId: string;
      channelType: number;
      spaceId?: string;
      onPosition?: (sequence: number) => void;
    }
  >();
  #active = new Set<ImTextSend>();
  #confirmed = new Set<string>();
  #retained = new Map<ImTextSend, NodeJS.Timeout>();
  #abort = new AbortController();
  constructor(
    readonly onMessage: (message: ImMessage) => void,
    readonly onDisconnect: (error: Error) => void = () => {},
    readonly onPosition?: (position: {
      channelId: string;
      channelType: number;
      messageSeq: number;
      fromUid: string;
      messageId: string;
      clientMsgNo: string;
      spaceId?: unknown;
    }) => void
  ) {}
  get connected(): boolean {
    return this.#ready && this.#socket?.readyState === WebSocket.OPEN;
  }
  async connect(registration: BotRegistration): Promise<void> {
    if (this.#socket) throw new Error("IM_ALREADY_CONNECTED");
    const keys = generateKeyPairSync("x25519");
    const publicKey = keys.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64");
    const socket = new WebSocket(registration.ws_url, {
      maxPayload: LIMIT,
      handshakeTimeout: 15_000,
      followRedirects: false
    });
    this.#socket = socket;
    let failure: Error | undefined;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => {
        failure = new ImConnectionError("IM_CONNECT_TIMEOUT", true);
        socket.terminate();
        reject(failure);
      }, 15_000);
      socket.on("open", () =>
        socket.send(
          frame(
            1,
            new Writer()
              .byte(4)
              .byte(0)
              .string(`${randomUUID()}W`)
              .string(registration.robot_id)
              .string(registration.im_token)
              .u64(BigInt(Date.now()))
              .string(publicKey)
              .finish()
          )
        )
      );
      socket.on("error", () => {
        failure ??= new ImConnectionError("IM_WS_ERROR", true);
        if (!ready) {
          clearTimeout(timeout);
          reject(failure);
        }
      });
      socket.on("close", () => {
        this.#ready = false;
        clearTimeout(timeout);
        if (this.#heartbeat) clearInterval(this.#heartbeat);
        for (const pending of [...this.#active]) pending.disconnected();
        this.#sends.clear();
        for (const timer of this.#retained.values()) clearTimeout(timer);
        this.#retained.clear();
        const error = failure ?? new ImConnectionError("IM_DISCONNECTED", true);
        if (!ready) reject(error);
        else if (!this.#closed) this.onDisconnect(error);
      });
      socket.on("message", (data, binary) => {
        try {
          if (!binary) throw new Error("IM_BINARY_REQUIRED");
          const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
          this.#buffer = Buffer.concat([this.#buffer, bytes]);
          if (this.#buffer.length > LIMIT) throw new Error("IM_FRAME_TOO_LARGE");
          // 保留未收齐的帧；一个 WS 消息也可能包含多帧，必须逐帧解析。
          while (this.#buffer.length) {
            const header = this.#buffer[0],
              kind = header >> 4;
            if (kind === 7 || kind === 8) {
              this.#buffer = this.#buffer.subarray(1);
              this.#lastPacket = Date.now();
              if (kind === 7) socket.send(Buffer.from([8 << 4]));
              continue;
            }
            let length = 0,
              multiplier = 1,
              offset = 1,
              complete = false;
            for (; offset < this.#buffer.length && offset <= 4; offset++) {
              const n = this.#buffer[offset];
              length += (n & 127) * multiplier;
              multiplier *= 128;
              if (!(n & 128)) {
                offset++;
                complete = true;
                break;
              }
            }
            if (!complete) {
              if (offset > 4) throw new Error("IM_LENGTH_INVALID");
              break;
            }
            if (length > LIMIT) throw new Error("IM_FRAME_TOO_LARGE");
            if (this.#buffer.length < offset + length) break;
            const reader = new Reader(this.#buffer.subarray(offset, offset + length));
            this.#buffer = this.#buffer.subarray(offset + length);
            this.#lastPacket = Date.now();
            if (kind === 2 && !ready) {
              if (header & 1) this.#version = reader.byte();
              reader.u64();
              const reason = reader.byte();
              if (reason !== 1) throw new ImConnectionError(`IM_CONNECT_REJECTED_${reason}`, false);
              const remoteKey = reader.string();
              const salt = reader.string();
              if (this.#version >= 4) reader.u64();
              const raw = Buffer.from(remoteKey, "base64");
              if (raw.length !== 32 || Buffer.byteLength(salt) < 16)
                throw new Error("IM_KEY_INVALID");
              // X25519 共享密钥按 WuKong 协议派生 AES 密钥，盐取前 16 字节作为 IV。
              const serverKey = createPublicKey({
                format: "der",
                type: "spki",
                key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), raw])
              });
              this.#key = Buffer.from(
                md5(
                  diffieHellman({ privateKey: keys.privateKey, publicKey: serverKey }).toString(
                    "base64"
                  )
                ).slice(0, 16)
              );
              this.#iv = Buffer.from(salt).subarray(0, 16);
              ready = true;
              this.#ready = true;
              clearTimeout(timeout);
              this.#heartbeat = setInterval(() => {
                if (Date.now() - this.#lastPacket > 90_000) {
                  failure = new ImConnectionError("IM_HEARTBEAT_TIMEOUT", true);
                  socket.terminate();
                } else if (socket.readyState === WebSocket.OPEN) socket.send(Buffer.from([7 << 4]));
              }, 25_000);
              this.#heartbeat.unref();
              resolve();
            } else if (!ready) throw new Error("IM_HANDSHAKE_REQUIRED");
            else if (kind === 5) this.#receive(reader, registration.robot_id);
            else if (kind === 4) {
              const id = reader.u64().toString();
              const seq = reader.u32();
              const messageSeq = reader.u32();
              const reason = reader.byte();
              const pending = this.#sends.get(seq);
              if (pending) {
                if (reason === 1) {
                  pending.onPosition?.(messageSeq);
                  this.#confirmed.add(pending.key);
                  if (this.#confirmed.size > 512)
                    this.#confirmed.delete(this.#confirmed.values().next().value!);
                  this.#forget(pending.operation);
                }
                pending.operation.ack(id, reason);
              }
            } else if (kind === 9)
              throw new ImConnectionError(`IM_SERVER_DISCONNECTED_${reader.byte()}`, false);
          }
        } catch (error) {
          this.#ready = false;
          failure = error instanceof Error ? error : new Error("IM_PROTOCOL_ERROR");
          clearTimeout(timeout);
          if (!ready) reject(failure);
          socket.terminate();
        }
      });
    });
    if (!this.connected) throw failure ?? new ImConnectionError("IM_DISCONNECTED", true);
  }
  #encrypt(value: string): string {
    if (!this.#key || !this.#iv) throw new Error("IM_NOT_READY");
    const cipher = createCipheriv("aes-128-cbc", this.#key, this.#iv);
    return Buffer.concat([cipher.update(value, "utf8"), cipher.final()]).toString("base64");
  }
  #receive(reader: Reader, ownUid: string): void {
    const setting = reader.byte(),
      msgKey = reader.string(),
      fromUid = reader.string(),
      channelId = reader.string(),
      channelType = reader.byte();
    if (this.#version >= 3) reader.u32();
    const clientNo = reader.string(),
      messageId = reader.u64(),
      messageSeq = reader.u32(),
      timestamp = reader.u32();
    if (setting & 8) reader.string();
    const encrypted = reader.rest().toString();
    if (
      md5(
        this.#encrypt(
          `${messageId}${messageSeq}${clientNo}${timestamp}${fromUid}${channelId}${channelType}${encrypted}`
        )
      ) !== msgKey
    )
      throw new Error("IM_MESSAGE_KEY_INVALID");
    const decipher = createDecipheriv("aes-128-cbc", this.#key!, this.#iv!);
    const plain = Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64")),
      decipher.final()
    ]);
    const payload = JSON.parse(plain.toString()) as Record<string, unknown>;
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("IM_PAYLOAD_INVALID");
    if (fromUid === ownUid) {
      const pending = [...this.#sends.values()].find(
        (entry) =>
          entry.key === clientNo &&
          entry.channelId === channelId &&
          entry.channelType === channelType &&
          (!payload.space_id || payload.space_id === entry.spaceId)
      );
      pending?.onPosition?.(messageSeq);
    }
    this.onPosition?.({
      channelId,
      channelType,
      messageSeq,
      fromUid,
      messageId: messageId.toString(),
      clientMsgNo: clientNo,
      spaceId: payload.space_id
    });
    if (fromUid !== ownUid)
      this.onMessage({
        messageId: messageId.toString(),
        messageSeq,
        fromUid,
        channelId: channelType === 1 ? fromUid : channelId,
        channelType,
        timestamp,
        payload
      });
    // 此 ACK 仅确认 IM 消息已接收，不代表 AgentRun 已执行完成。
    this.#socket?.send(frame(6, new Writer().u64(messageId).u32(messageSeq).finish()));
  }
  sendText(
    channelId: string,
    channelType: number,
    text: string,
    clientMsgNo: string = randomUUID(),
    spaceId?: string,
    mention?: ImTextMention,
    signal?: AbortSignal,
    onPosition?: (sequence: number) => void
  ): Promise<string> {
    if (this.#socket?.readyState !== WebSocket.OPEN || !this.#key)
      return Promise.reject(new ImSendError("IM_NOT_READY", "failed"));
    if (
      Buffer.byteLength(text) > 256 * 1024 ||
      this.#active.size >= 64 ||
      this.#socket.bufferedAmount > LIMIT
    )
      return Promise.reject(new ImSendError("IM_SEND_CAPACITY_EXHAUSTED", "failed"));
    const encrypted = this.#encrypt(
      JSON.stringify({
        type: 1,
        content: text,
        ...(spaceId ? { space_id: spaceId } : {}),
        ...(mention ? { mention } : {})
      })
    );
    const operation = new ImTextSend(
      () => {
        if (!this.connected) throw new ImSendError("IM_NOT_READY", "failed");
        if (this.#socket!.bufferedAmount > LIMIT)
          throw new ImSendError("IM_SEND_CAPACITY_EXHAUSTED", "failed");
        const seq = ++this.#seq;
        const body = new Writer()
          .byte(0)
          .u32(seq)
          .string(clientMsgNo)
          .string(channelId)
          .byte(channelType);
        if (this.#version >= 3) body.u32(0);
        body
          .string(md5(this.#encrypt(`${seq}${clientMsgNo}${channelId}${channelType}${encrypted}`)))
          .bytes(Buffer.from(encrypted));
        this.#sends.set(seq, {
          operation,
          key: clientMsgNo,
          channelId,
          channelType,
          spaceId,
          onPosition
        });
        this.#socket!.send(frame(3, body.finish(), 2), (error) => {
          if (error) operation.disconnected();
        });
      },
      (state) => {
        this.#active.delete(operation);
        if (state === "unknown" && !this.#closed) {
          // 留出 REST 降级窗口关联迟到 ACK；映射与计时器均有界。
          while (this.#retained.size >= 64) this.#forget(this.#retained.keys().next().value!);
          const timer = setTimeout(() => this.#forget(operation), 30_000);
          timer.unref();
          this.#retained.set(operation, timer);
        } else this.#forget(operation);
      },
      signal ? AbortSignal.any([this.#abort.signal, signal]) : this.#abort.signal
    );
    this.#active.add(operation);
    operation.start();
    return operation.result;
  }
  isDelivered(clientMsgNo: string): boolean {
    return this.#confirmed.has(clientMsgNo);
  }
  #forget(operation: ImTextSend): void {
    clearTimeout(this.#retained.get(operation));
    this.#retained.delete(operation);
    for (const [seq, pending] of this.#sends)
      if (pending.operation === operation) this.#sends.delete(seq);
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#abort.abort();
    for (const timer of this.#retained.values()) clearTimeout(timer);
    this.#retained.clear();
    this.#sends.clear();
    this.#ready = false;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
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

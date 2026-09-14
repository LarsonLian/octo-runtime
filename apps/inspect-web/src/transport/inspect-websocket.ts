import { isRecord } from "../domain";

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const BATCH_WINDOW_MS = 32;

export interface InspectTransportCallbacks {
  onConnection(state: "connecting" | "live" | "paused" | "disconnected" | "auth-required", message: string): void;
  onStatus(status: unknown, memory: unknown): void;
  onEvents(events: readonly { value: Record<string, unknown>; raw: string }[]): void;
}

export class InspectTransport {
  readonly #callbacks: InspectTransportCallbacks;
  #socket?: WebSocket;
  #token = "";
  #stopped = true;
  #replaySnapshot = true;
  #retryAttempt = 0;
  #retryTimer?: number;
  #batchTimer?: number;
  #logsController?: AbortController;
  #pending: Array<{ value: Record<string, unknown>; raw: string }> = [];

  constructor(callbacks: InspectTransportCallbacks) {
    this.#callbacks = callbacks;
  }

  start(token: string): void {
    this.stop();
    this.#token = token;
    this.#stopped = false;
    this.#retryAttempt = 0;
    this.#replaySnapshot = true;
    if (!token) {
      this.#callbacks.onConnection("auth-required", "需要 Capability Token");
      return;
    }
    this.#connect();
  }

  retry(): void {
    if (!this.#token) return;
    if (this.#retryTimer !== undefined) window.clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#stopped = false;
    this.#retryAttempt = 0;
    this.#connect();
  }

  pause(): void {
    this.#stopped = true;
    if (this.#retryTimer !== undefined) window.clearTimeout(this.#retryTimer);
    if (this.#batchTimer !== undefined) window.clearTimeout(this.#batchTimer);
    this.#retryTimer = undefined;
    this.#batchTimer = undefined;
    this.#pending = [];
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close(1000, "inspect stream paused");
    this.#callbacks.onConnection("paused", "接收已暂停");
  }

  resume(): void {
    if (!this.#token) return;
    this.#stopped = false;
    this.#retryAttempt = 0;
    this.#replaySnapshot = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#retryTimer !== undefined) window.clearTimeout(this.#retryTimer);
    if (this.#batchTimer !== undefined) window.clearTimeout(this.#batchTimer);
    this.#retryTimer = undefined;
    this.#batchTimer = undefined;
    this.#logsController?.abort();
    this.#logsController = undefined;
    this.#pending = [];
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close(1000, "inspect page closed");
  }

  async loadLogs(): Promise<unknown> {
    this.#logsController?.abort();
    const controller = new AbortController();
    this.#logsController = controller;
    try {
      const response = await fetch("/api/logs", {
        headers: { Authorization: `Bearer ${this.#token}` },
        signal: controller.signal
      });
      if (response.status === 401) {
        this.#callbacks.onConnection("auth-required", "Capability Token 无效");
        throw new Error("Capability Token 无效");
      }
      if (!response.ok) throw new Error(`日志加载失败 (${response.status})`);
      return response.json();
    } finally {
      if (this.#logsController === controller) this.#logsController = undefined;
    }
  }

  #connect(): void {
    if (this.#stopped || this.#socket) return;
    this.#callbacks.onConnection("connecting", this.#retryAttempt ? `正在重连 · ${this.#retryAttempt}` : "正在连接");
    const query = new URLSearchParams({ token: this.#token });
    if (!this.#replaySnapshot) query.set("replay", "0");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/events?${query}`);
    this.#socket = socket;
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#retryAttempt = 0;
      this.#replaySnapshot = true;
      this.#callbacks.onConnection("live", "实时");
    };
    socket.onmessage = message => {
      if (typeof message.data !== "string") return;
      try {
        const value: unknown = JSON.parse(message.data);
        if (!isRecord(value)) return;
        if (value.kind === "status") {
          this.#callbacks.onStatus(value.status, value.memory);
          return;
        }
        this.#pending.push({ value, raw: message.data });
        if (this.#batchTimer === undefined) {
          this.#batchTimer = window.setTimeout(() => {
            this.#batchTimer = undefined;
            this.#flush();
          }, BATCH_WINDOW_MS);
        }
      } catch {
        this.#callbacks.onConnection("disconnected", "收到无效事件帧");
      }
    };
    socket.onerror = () => undefined;
    socket.onclose = event => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#flush();
      if (this.#stopped || event.code === 1000) return;
      if (event.code === 4401) {
        this.#stopped = true;
        this.#callbacks.onConnection("auth-required", "Capability Token 缺失或无效");
        return;
      }
      const delay = RETRY_DELAYS_MS[this.#retryAttempt];
      if (delay === undefined) {
        this.#stopped = true;
        this.#callbacks.onConnection("disconnected", "连接已断开，请手动重试");
        return;
      }
      this.#retryAttempt += 1;
      this.#callbacks.onConnection("disconnected", `${Math.round(delay / 1000)} 秒后重连`);
      this.#retryTimer = window.setTimeout(() => {
        this.#retryTimer = undefined;
        this.#connect();
      }, delay);
    };
  }

  #flush(): void {
    if (this.#pending.length === 0) return;
    const pending = this.#pending;
    this.#pending = [];
    this.#callbacks.onEvents(pending);
  }
}

export function initialCapabilityToken(): string {
  const key = tokenStorageKey();
  const queryToken = new URLSearchParams(location.search).get("token") ?? "";
  if (queryToken) sessionStorage.setItem(key, queryToken);
  history.replaceState(null, "", location.pathname);
  return queryToken || sessionStorage.getItem(key) || "";
}

export function saveCapabilityToken(token: string): void {
  sessionStorage.setItem(tokenStorageKey(), token);
}

export function tokenFromInput(value: string): string {
  try {
    return new URL(value).searchParams.get("token") ?? "";
  } catch {
    return value.replace(/^\?token=/, "");
  }
}

function tokenStorageKey(): string {
  return `octo-harness.inspect.token:${location.host}`;
}

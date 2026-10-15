/**
 * Typing 租约：按会话共享续期任务，避免一个 Run 结束后误停另一个 Run 的状态。
 * 每个 Run 独立释放，租约有最长寿命；关闭连接时同时取消计时器和在途发送。
 */
import type { ImAddress } from "../contracts.js";

interface TypingEntry {
  leases: Map<string, NodeJS.Timeout>;
  timer: NodeJS.Timeout;
  abort: AbortController;
  sending: boolean;
}
export class TypingController {
  readonly #entries = new Map<string, TypingEntry>();
  #closed = false;
  #closing?: Promise<void>;
  readonly #tasks = new Set<Promise<void>>();
  constructor(
    readonly send: (address: ImAddress, signal: AbortSignal) => Promise<void>,
    readonly onError: () => void,
    readonly intervalMs = 5_000,
    readonly maxLifetimeMs = 600_000
  ) {}
  acquire(address: ImAddress, leaseId: string): () => void {
    if (this.#closed) return () => {};
    const key = `${address.channelType}:${address.channelId}`;
    let entry = this.#entries.get(key);
    if (!entry) {
      const abort = new AbortController();
      const tick = (): void => {
        const active = this.#entries.get(key);
        if (!active || active.sending) return;
        active.sending = true;
        const task = this.send(address, abort.signal)
          .catch(() => this.onError())
          .finally(() => {
            active.sending = false;
            this.#tasks.delete(task);
          });
        this.#tasks.add(task);
      };
      entry = {
        leases: new Map(),
        timer: setInterval(tick, this.intervalMs),
        abort,
        sending: false
      };
      entry.timer.unref();
      this.#entries.set(key, entry);
      tick();
    }
    const previous = entry.leases.get(leaseId);
    if (previous) clearTimeout(previous);
    const release = (): void => {
      const current = this.#entries.get(key);
      const timer = current?.leases.get(leaseId);
      if (timer) clearTimeout(timer);
      current?.leases.delete(leaseId);
      if (current && !current.leases.size) {
        clearInterval(current.timer);
        current.abort.abort();
        this.#entries.delete(key);
      }
    };
    const timer = setTimeout(release, this.maxLifetimeMs);
    timer.unref();
    entry.leases.set(leaseId, timer);
    return release;
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    for (const entry of this.#entries.values()) {
      clearInterval(entry.timer);
      entry.abort.abort();
      for (const timer of entry.leases.values()) clearTimeout(timer);
    }
    this.#entries.clear();
    this.#closing = Promise.all([...this.#tasks]).then(() => undefined);
    return this.#closing;
  }
  get activeAddresses(): number {
    return this.#entries.size;
  }
}

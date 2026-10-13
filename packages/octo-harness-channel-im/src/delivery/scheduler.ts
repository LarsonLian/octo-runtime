/**
 * 进度调度：合并高频快照并串行发送，避免卡片更新乱序或请求堆积。
 * 终态替换尚未发送的旧进度；flush 等待在途请求与最后一次更新完成。
 */
export class ProgressScheduler<T> {
  #pending?: T;
  #running = false;
  #terminal = false;
  #flushing = false;
  #lastSend = 0;
  #timer?: NodeJS.Timeout;
  readonly #waiters: Array<() => void> = [];
  constructor(
    readonly send: (value: T) => Promise<void>,
    readonly onError: () => void,
    readonly intervalMs = 500
  ) {}
  enqueue(value: T, terminal = false): void {
    if (this.#terminal) return;
    // 快照包含累计进度，覆盖 pending 不会丢过程；终态一旦入队就拒绝后续旧帧。
    this.#terminal = terminal;
    this.#pending = value;
    if (terminal && this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#schedule();
  }
  #schedule(): void {
    if (this.#running || this.#timer || this.#pending === undefined) return;
    if (this.#terminal || this.#flushing) {
      void this.#drain();
      return;
    }
    const delay = this.#lastSend
      ? Math.max(0, this.#lastSend + this.intervalMs - Date.now())
      : this.intervalMs;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#drain();
    }, delay);
    this.#timer.unref();
  }
  async #drain(): Promise<void> {
    if (this.#running || this.#pending === undefined) return;
    this.#running = true;
    this.#lastSend = Date.now();
    const value = this.#pending;
    this.#pending = undefined;
    try {
      await this.send(value);
    } catch {
      this.onError();
    } finally {
      this.#running = false;
      if (this.#pending !== undefined) this.#schedule();
      else {
        this.#flushing = false;
        for (const resolve of this.#waiters.splice(0)) resolve();
      }
    }
  }
  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (!this.#running && this.#pending === undefined) return;
    this.#flushing = true;
    const done = new Promise<void>((resolve) => this.#waiters.push(resolve));
    this.#schedule();
    await done;
  }
  get terminal(): boolean {
    return this.#terminal;
  }
}

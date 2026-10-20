import {
  DEFAULT_STREAM_LIMIT_POLICY,
  protocolError,
  streamCapacityError,
  type StreamLimitPolicy,
  type NativeInteractionResponse
} from "@mininglamp-oss/octo-runtime-protocol";
import type { AdapterOutput } from "./index.js";

/** Bounded queue for provider callbacks; overflow fails the owning invocation. */
export class DriverQueue<T> implements AsyncIterable<T> {
  #items: { value: T; bytes: number }[] = [];
  #bytes = 0;
  #closed = false;
  #error?: Error;
  #waiter?: { resolve: (value: IteratorResult<T>) => void; reject: (error: Error) => void };
  constructor(
    private readonly options: {
      discardOnFailure?: boolean;
      onFailure?: (error: Error) => void;
      limits?: Pick<
        StreamLimitPolicy,
        "adapterQueueItemMaxBytes" | "adapterQueueMaxBytes" | "adapterQueueMaxItems"
      >;
      boundary?: string;
    } = {}
  ) {}
  push(value: T): void {
    if (this.#closed) return;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    const limits = this.options.limits ?? DEFAULT_STREAM_LIMIT_POLICY;
    const boundary = this.options.boundary ?? "adapter.output_queue";
    if (bytes > limits.adapterQueueItemMaxBytes) {
      this.close(
        streamCapacityError("STREAM_QUEUE_ITEM_TOO_LARGE", {
          boundary,
          measuredBytes: bytes,
          limitBytes: limits.adapterQueueItemMaxBytes
        })
      );
      return;
    }
    if (this.#items.length >= limits.adapterQueueMaxItems) {
      this.close(
        streamCapacityError("STREAM_QUEUE_ITEMS_EXCEEDED", {
          boundary,
          itemCount: this.#items.length + 1,
          limitItems: limits.adapterQueueMaxItems
        })
      );
      return;
    }
    if (this.#bytes + bytes > limits.adapterQueueMaxBytes) {
      this.close(
        streamCapacityError("STREAM_QUEUE_BYTES_EXCEEDED", {
          boundary,
          measuredBytes: this.#bytes + bytes,
          limitBytes: limits.adapterQueueMaxBytes
        })
      );
      return;
    }
    if (this.#waiter) {
      this.#waiter.resolve({ value, done: false });
      this.#waiter = undefined;
    } else {
      this.#items.push({ value, bytes });
      this.#bytes += bytes;
    }
  }
  close(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    if (error && this.options.discardOnFailure) this.drain();
    if (this.#waiter) {
      if (error) this.#waiter.reject(error);
      else this.#waiter.resolve({ value: undefined, done: true });
      this.#waiter = undefined;
    }
    if (error) this.options.onFailure?.(error);
  }
  fail(error: Error): void {
    this.close(error);
  }
  drain(): T[] {
    const items = this.#items.splice(0);
    this.#bytes = 0;
    return items.map((item) => item.value);
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      const item = this.#items.shift();
      if (item) {
        this.#bytes -= item.bytes;
        yield item.value;
        continue;
      }
      if (this.#error) throw this.#error;
      if (this.#closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve, reject) => {
        this.#waiter = { resolve, reject };
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

/** Owns raw reverse requests, acknowledged replies, expiry and teardown for one turn. */
export class NativeInteractionBridge {
  readonly queue: DriverQueue<AdapterOutput>;
  readonly #pending = new Map<
    string | number,
    {
      write: (payload: unknown) => Promise<void>;
      validate: (payload: Record<string, unknown>) => void;
      timer: NodeJS.Timeout;
      expiresAt: number;
      responding: boolean;
    }
  >();
  #closed = false;
  #closeTransport?: () => Promise<void>;
  #transportClosed?: Promise<void>;
  readonly #seen = new Set<string | number>();
  constructor(limits?: Readonly<StreamLimitPolicy>) {
    this.queue = new DriverQueue<AdapterOutput>({ limits, boundary: "adapter.native_queue" });
  }
  bindTransport(close: () => Promise<void>): void {
    this.#closeTransport = close;
  }
  #closeTransportOnce(): Promise<void> {
    this.#transportClosed ??= Promise.resolve().then(() => this.#closeTransport?.());
    // 后台关闭也保留同一次失败，stream 收尾负责向调用方报告。
    void this.#transportClosed.catch(() => undefined);
    return this.#transportClosed;
  }
  request(
    requestId: string | number,
    payload: Record<string, unknown>,
    write: (payload: unknown) => Promise<void>,
    validate: (payload: Record<string, unknown>) => void,
    automatic?: Record<string, unknown>
  ): void {
    if (
      this.#closed ||
      this.#seen.has(requestId) ||
      this.#pending.size >= 16 ||
      this.#seen.size >= 4096
    )
      throw protocolError("INTERACTION_NOT_ACTIVE");
    this.#seen.add(requestId);
    const expiresAt = Date.now() + 600_000;
    const timer = setTimeout(() => {
      this.#pending.delete(requestId);
      this.queue.push({
        kind: "control",
        control: { type: "interaction", requestId, status: "expired" }
      });
      this.queue.close(protocolError("INTERACTION_NOT_ACTIVE", "Native interaction expired"));
      void this.#closeTransportOnce();
    }, 600_000);
    timer.unref();
    this.#pending.set(requestId, { write, validate, timer, expiresAt, responding: false });
    this.queue.push({ kind: "native", messageKind: "request", payload });
    this.queue.push({
      kind: "control",
      control: { type: "interaction", requestId, status: "pending", expiresAt }
    });
    if (automatic)
      void this.respond({ requestId, payload: automatic }).catch((error: unknown) => {
        this.queue.close(error instanceof Error ? error : new Error(String(error)));
        void this.#closeTransportOnce();
      });
  }
  async respond(response: NativeInteractionResponse): Promise<void> {
    const pending = this.#pending.get(response.requestId);
    if (this.#closed || !pending || pending.responding || pending.expiresAt <= Date.now())
      throw protocolError("INTERACTION_NOT_ACTIVE");
    pending.validate(response.payload);
    pending.responding = true;
    try {
      await pending.write(response.payload);
    } catch (error) {
      this.close();
      this.queue.close(error instanceof Error ? error : new Error(String(error)));
      try {
        await this.#closeTransportOnce();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Native response and cleanup failed", {
          cause: cleanupError
        });
      }
      throw error;
    }
    if (!this.#pending.has(response.requestId)) throw protocolError("INTERACTION_NOT_ACTIVE");
    clearTimeout(pending.timer);
    this.#pending.delete(response.requestId);
    this.queue.push({
      kind: "control",
      control: { type: "interaction", requestId: response.requestId, status: "resolved" }
    });
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.queue.push({
        kind: "control",
        control: { type: "interaction", requestId, status: "invalidated" }
      });
    }
    this.#pending.clear();
  }
  async *stream(source: AsyncIterable<AdapterOutput>): AsyncGenerator<AdapterOutput> {
    const iterator = source[Symbol.asyncIterator]();
    const producer = (async () => {
      try {
        while (!this.#closed) {
          const next = await iterator.next();
          if (next.done) break;
          this.queue.push(next.value);
        }
        this.close();
        this.queue.close();
      } catch (error) {
        this.close();
        this.queue.close(error instanceof Error ? error : new Error(String(error)));
      }
    })();
    try {
      yield* this.queue;
    } finally {
      this.close();
      // 独立清理均须执行，不能因传输关闭失败跳过源 iterator 的资源释放。
      await Promise.all([
        this.#closeTransportOnce(),
        Promise.resolve().then(() => iterator.return?.()),
        producer
      ]);
    }
  }
}

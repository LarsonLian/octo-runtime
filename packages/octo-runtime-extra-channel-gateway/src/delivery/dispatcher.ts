/**
 * 投递回执与重试：按 effectKey 记录发送结果，避免已确认的消息重复投递。
 * 只重试投递操作；执行失败或网络结果未知都不能由此触发 AgentRun 重跑。
 */
import type { ImDeliveryReceipt } from "../contracts.js";
import { OctoApiError } from "../transport/api/errors.js";

export class ImDeliveryDispatcher {
  readonly #receipts = new Map<string, ImDeliveryReceipt>();
  constructor(readonly signal: AbortSignal) {}
  get receipts(): ImDeliveryReceipt[] {
    return [...this.#receipts.values()].map((r) => ({ ...r }));
  }

  async deliver(
    effectKey: string,
    operation: () => Promise<string | void>,
    options: { transient?: boolean; obsolete?: () => boolean } = {}
  ): Promise<ImDeliveryReceipt> {
    const previous = this.#receipts.get(effectKey);
    if (previous?.state === "delivered") return { ...previous };
    const attempts = options.transient ? 1 : 3;
    let receipt: ImDeliveryReceipt = { effectKey, state: "pending" };
    this.#record(receipt);
    for (let attempt = 0; attempt < attempts && !this.signal.aborted; attempt++) {
      if (options.obsolete?.()) break;
      try {
        const messageId = await operation();
        receipt = { effectKey, state: "delivered", ...(messageId ? { messageId } : {}) };
        this.#record(receipt);
        return receipt;
      } catch (error) {
        const status = error instanceof OctoApiError ? error.status : undefined;
        // 无 HTTP 回应时可能已经送达；保留 unknown，不能把网络异常当作确定未发送。
        receipt = {
          effectKey,
          state: status ? "failed" : "unknown",
          code: status ? `IM_HTTP_${status}` : "IM_DELIVERY_UNKNOWN"
        };
        this.#record(receipt);
        if (status && status !== 429 && status < 500) break;
        if (attempt + 1 === attempts) break;
        const delay =
          error instanceof OctoApiError && status === 429
            ? error.retryAfterMs
            : 200 * (attempt + 1);
        if (delay > 3_000) break;
        try {
          await new Promise<void>((resolve, reject) => {
            const abort = (): void => {
              clearTimeout(timer);
              this.signal.removeEventListener("abort", abort);
              reject(new Error("IM_DELIVERY_CANCELLED"));
            };
            const timer = setTimeout(() => {
              this.signal.removeEventListener("abort", abort);
              resolve();
            }, delay);
            this.signal.addEventListener("abort", abort, { once: true });
            if (this.signal.aborted) abort();
          });
        } catch {
          break;
        }
      }
    }
    if (receipt.state === "pending")
      receipt = { effectKey, state: "failed", code: "IM_DELIVERY_CANCELLED" };
    this.#record(receipt);
    return receipt;
  }
  #record(receipt: ImDeliveryReceipt): void {
    this.#receipts.set(receipt.effectKey, receipt);
    if (this.#receipts.size > 512) this.#receipts.delete(this.#receipts.keys().next().value!);
  }
}

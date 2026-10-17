/** WS 逻辑消息的确认窗口；不重连、不重新执行模型。 */
export class ImSendError extends Error {
  constructor(
    readonly code: string,
    readonly state: "failed" | "unknown"
  ) {
    super(code);
  }
}

/** F27：.octospec/tasks/gateway-august-feature-assessment/assessment.md */
export class ImTextSend {
  #timer?: NodeJS.Timeout;
  #attempt = 0;
  #unknown = false;
  #settled = false;
  #resolve!: (id: string) => void;
  #reject!: (error: ImSendError) => void;
  readonly result = new Promise<string>((resolve, reject) => {
    this.#resolve = resolve;
    this.#reject = reject;
  });
  constructor(
    readonly send: () => void,
    readonly finish: (state: "delivered" | "failed" | "unknown") => void,
    readonly signal: AbortSignal
  ) {}
  start(): void {
    this.signal.addEventListener("abort", this.#abort, { once: true });
    if (this.signal.aborted) this.#abort();
    else this.#send();
  }
  ack(id: string, reason: number): void {
    if (this.#settled) return;
    if (reason === 1) {
      this.#settle("delivered");
      this.#resolve(id);
    } else this.fail(`IM_SEND_REJECTED_${reason}`);
  }
  fail(code: string): void {
    if (this.#settled) return;
    const state = this.#unknown ? "unknown" : "failed";
    this.#settle(state);
    this.#reject(new ImSendError(code, state));
  }
  disconnected(): void {
    if (this.#attempt) this.#unknown = true;
    this.fail("IM_DISCONNECTED");
  }
  #abort = (): void => this.fail("IM_DELIVERY_CANCELLED");
  #send(): void {
    if (this.#settled) return;
    this.#attempt++;
    this.#timer = setTimeout(() => {
      this.#unknown = true;
      const delay = [1000, 5000, 10000][this.#attempt - 1];
      if (delay === undefined) this.fail("IM_SEND_TIMEOUT");
      else this.#timer = setTimeout(() => this.#send(), delay);
    }, 15_000);
    try {
      this.send();
    } catch (error) {
      this.fail(error instanceof ImSendError ? error.code : "IM_SEND_FAILED");
    }
  }
  #settle(state: "delivered" | "failed" | "unknown"): void {
    this.#settled = true;
    clearTimeout(this.#timer);
    this.signal.removeEventListener("abort", this.#abort);
    this.finish(state);
  }
}

import type { ImSessionStore } from "./session-store.js";

/**
 * 工厂句柄的访问租约。停止接纳不立即撤权，Runtime 尾任务仍可写绑定；
 * 收尾完成或 5 秒清理超时后撤权，迟到回调不能再访问宿主数据库。
 * 直接注入的借用 sessions 不经过该所有权包装。
 */
export class HostSessionStore {
  #closed = false;
  #closing?: Promise<void>;
  #draining = false;
  #drainFailed = false;
  #invalidFactory?: Promise<void>;
  constructor(readonly source: ImSessionStore) {}
  validate(): void {
    const source = this.source;
    // JS 宿主可能误传 async 工厂：仍明确拒绝，立即消费拒绝并回收迟到句柄。
    // 不把 Promise 当作合法存储，也不让后台拒绝升级为宿主进程崩溃。
    if (source && typeof source === "object" && typeof Reflect.get(source, "then") === "function") {
      this.#invalidFactory ??= Promise.resolve(source).then(
        async (resolved) => {
          if (typeof resolved?.close === "function") await resolved.close();
        },
        () => undefined
      );
      void this.#invalidFactory.catch(() => undefined);
      throw new Error("IM_SESSION_STORE_INVALID");
    }
    if (
      !source ||
      typeof source !== "object" ||
      ["read", "save", "reset", "occurrence", "remember"].some(
        (key) => typeof Reflect.get(source, key) !== "function"
      ) ||
      (source.patchGap !== undefined && typeof source.patchGap !== "function") ||
      (source.close !== undefined && typeof source.close !== "function")
    )
      throw new Error("IM_SESSION_STORE_INVALID");
  }
  #access(): ImSessionStore {
    if (this.#closed) throw new Error("IM_SESSION_STORE_CLOSED");
    return this.source;
  }
  #perform<T>(operation: (source: ImSessionStore) => T): T {
    const source = this.#access();
    try {
      return operation(source);
    } catch (error) {
      // Runtime 的业务诊断会捕获存储异常，租约另记失败，避免卸载错误地报告写入成功。
      if (this.#draining) this.#drainFailed = true;
      throw error;
    }
  }
  beginDrain(): void {
    this.#draining = true;
  }
  get sessions(): ImSessionStore {
    const sessions: ImSessionStore = {
      read: (...args) => this.#perform((source) => source.read(...args)),
      save: (...args) => this.#perform((source) => source.save(...args)),
      reset: (...args) => this.#perform((source) => source.reset(...args)),
      occurrence: (...args) => this.#perform((source) => source.occurrence(...args)),
      remember: (...args) => this.#perform((source) => source.remember(...args))
    };
    if (this.source.patchGap)
      sessions.patchGap = (...args) => this.#perform((source) => source.patchGap!(...args));
    return sessions;
  }
  revoke(): void {
    this.#closed = true;
  }
  close(): Promise<void> {
    this.revoke();
    // Promise 在调用宿主前固定；失败结果也复用，不重试 close 或假报已释放。
    return (this.#closing ??= Promise.resolve().then(async () => {
      if (this.#invalidFactory) await this.#invalidFactory;
      else if (typeof this.source?.close === "function") await this.source.close();
      if (this.#drainFailed) throw new Error("IM_SESSION_STORE_DRAIN_FAILED");
    }));
  }
}

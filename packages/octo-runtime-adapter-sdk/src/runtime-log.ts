/** 宿主可选的结构化日志；只接受执行元数据，磁盘写入隔离在有界 Worker。 */
import { isAbsolute } from "node:path";
import { Worker } from "node:worker_threads";

export type RuntimeLogLevel = "info" | "warn" | "error";
export type RuntimeLog = (
  level: RuntimeLogLevel,
  event: string,
  data?: Readonly<Record<string, unknown>>
) => void;
export interface RuntimeLoggingOptions {
  directory: string;
}
export const noopRuntimeLog: RuntimeLog = () => {};

const strings = new Set([
  "run_id",
  "invocation_id",
  "session_id",
  "adapter_type",
  "model",
  "status",
  "code",
  "endpoint_id",
  "state",
  "protocol_mode"
]);
const numbers = new Set([
  "duration_ms",
  "input_count",
  "text_input_count",
  "image_input_count",
  "context_count",
  "attempt",
  "frame_count",
  "conversion_count",
  "working_tasks",
  "queued_tasks"
]);

export function assertRuntimeLogging(options?: RuntimeLoggingOptions): void {
  if (
    options !== undefined &&
    (!options || typeof options.directory !== "string" || !isAbsolute(options.directory))
  )
    throw new TypeError("LOG_DIRECTORY_MUST_BE_ABSOLUTE");
}

/** F31：.octospec/tasks/gateway-august-feature-assessment/assessment.md */
export class RuntimeLogging {
  #worker?: Worker;
  #pending = 0;
  #closed = false;
  #closing?: Promise<void>;
  #done?: () => void;
  constructor(options?: RuntimeLoggingOptions) {
    assertRuntimeLogging(options);
    if (!options) return;
    try {
      this.#worker = new Worker(new URL("./runtime-log-worker.js", import.meta.url), {
        workerData: options
      });
    } catch {
      this.#closed = true;
      return;
    }
    this.#worker.on("message", (message: string) => {
      if (message === "written") this.#pending = Math.max(0, this.#pending - 1);
      if (message === "closed") this.#done?.();
    });
    this.#worker.on("error", () => {
      this.#closed = true;
      this.#done?.();
    });
    this.#worker.on("exit", () => {
      this.#closed = true;
      this.#done?.();
    });
    this.#worker.unref();
  }
  readonly kernel: RuntimeLog = (level, event, data) =>
    this.#write("kernel", undefined, level, event, data);
  extra(name: string): RuntimeLog {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new TypeError("EXTRA_NAME_INVALID");
    return (level, event, data) => this.#write("extra", name, level, event, data);
  }
  #write(
    source: "kernel" | "extra",
    extra: string | undefined,
    level: RuntimeLogLevel,
    event: string,
    data?: Readonly<Record<string, unknown>>
  ): void {
    if (!this.#worker || this.#closed || this.#pending >= 128) return;
    try {
      if (!["info", "warn", "error"].includes(level) || !/^[a-z][a-z0-9_.-]{0,63}$/.test(event))
        return;
      const safe: Record<string, string | number> = {};
      // 不做任意对象脱敏或正文截断：白名单之外的字段直接不读取、不序列化。
      for (const key of strings) {
        const value = data?.[key];
        if (
          typeof value === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$/.test(value) &&
          !/^(?:bf_|sk-|Bearer)/i.test(value)
        )
          safe[key] = value;
      }
      for (const key of numbers) {
        const value = data?.[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) safe[key] = value;
      }
      const record = {
        time: new Date().toISOString(),
        level,
        source,
        event,
        ...(extra ? { extra_type: extra } : {}),
        data: safe
      };
      this.#worker.postMessage({ extra, line: `${JSON.stringify(record)}\n` });
      this.#pending++;
    } catch {
      /* 日志不能中断执行，包括恶意 getter 或已退出的 Worker。 */
    }
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    if (!this.#worker) return Promise.resolve();
    const worker = this.#worker;
    this.#closing = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        void worker.terminate();
        resolve();
      }, 1000);
      this.#done = () => {
        clearTimeout(timer);
        resolve();
      };
      try {
        worker.postMessage("close");
      } catch {
        this.#done();
      }
    });
    return this.#closing;
  }
}

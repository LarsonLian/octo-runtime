/** 日志专用线程：复用小时桶、容量与跨进程互斥，不运行任何业务逻辑。 */
import { parentPort, workerData } from "node:worker_threads";
import { join } from "node:path";
import { HourlyLogWriter } from "./hourly-log.js";
import type { RuntimeLoggingOptions } from "./runtime-log.js";

const directory = (workerData as RuntimeLoggingOptions).directory;
const writers = new Map<string, HourlyLogWriter>();
parentPort!.on("message", (message: "close" | { extra?: string; line: string }) => {
  if (message === "close") {
    for (const writer of writers.values()) writer.close();
    parentPort!.postMessage("closed");
    parentPort!.close();
    return;
  }
  try {
    const category = message.extra ?? "kernel";
    const key = message.extra ? `extra:${message.extra}` : "kernel";
    let writer = writers.get(key);
    if (!writer && writers.size < 128) {
      writer = new HourlyLogWriter(
        message.extra ? join(directory, "extras") : directory,
        category,
        { onError: () => {} }
      );
      writers.set(key, writer);
    }
    writer?.write(message.line);
  } catch {
    /* 写入失败只丢弃本条诊断，不影响执行。 */
  }
  parentPort!.postMessage("written");
});

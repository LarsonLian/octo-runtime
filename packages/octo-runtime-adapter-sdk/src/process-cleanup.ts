import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/**
 * 只回收调用方创建的进程/独立进程组；leader 退出不代表工具后代已退出。
 * R06：.octospec/tasks/pr1-yujiawei-review/assessment.md
 * 同一 close Promise 覆盖 TERM、KILL 和确认阶段，不扫描全机、不缓存历史 PGID。
 */
export function createProcessCleanup(
  child: ChildProcess,
  { processGroup = false, termGraceMs = 400, killGraceMs = 200 } = {}
): () => Promise<void> {
  let cleanup: Promise<void> | undefined;
  let signalError: Error | undefined;
  const grouped = processGroup && process.platform !== "win32" && child.pid !== undefined;
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;
  const exists = (): boolean => {
    if (!grouped) return !exited() && child.pid !== undefined;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      // kill(0) 的 EPERM 仍表示目标存在；继续有界确认，绝不当作清理成功。
      if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
      throw error;
    }
  };
  const signal = (value: NodeJS.Signals): void => {
    try {
      if (grouped) process.kill(-child.pid, value);
      else child.kill(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        // macOS 的退出窗口可能暂时拒绝组信号；仅在后续确认 ESRCH 后成功。
        signalError ??= error as Error;
        return;
      }
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const wait = async (deadline: number): Promise<boolean> => {
    while (exists()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await delay(Math.min(10, remaining));
    }
    return true;
  };
  return () =>
    (cleanup ??= (async () => {
      // 无 PID 的 spawn 失败没有可回收的 OS 进程；测试注入的子进程仍接收终止通知。
      if (!exists()) {
        if (!exited() && child.pid === undefined) child.kill("SIGTERM");
        return;
      }
      const started = Date.now();
      signal("SIGTERM");
      if (await wait(started + termGraceMs)) return;
      signal("SIGKILL");
      if (!(await wait(started + termGraceMs + killGraceMs))) {
        throw Object.assign(new Error("PROCESS_CLEANUP_TIMEOUT", { cause: signalError }), {
          code: "PROCESS_CLEANUP_TIMEOUT"
        });
      }
    })());
}

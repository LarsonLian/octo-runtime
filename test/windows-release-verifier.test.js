import assert from "node:assert/strict";
import test from "node:test";
import { commandDiagnostic, waitForDaemonReady } from "../scripts/verify-windows-release.mjs";

function clock() {
  let milliseconds = 0;
  return {
    now: () => milliseconds,
    delay: async (duration) => {
      milliseconds += duration;
    }
  };
}

test("Windows readiness 在总 deadline 内接受延迟就绪", async () => {
  const time = clock();
  let attempts = 0;
  await waitForDaemonReady({
    ...time,
    timeoutMs: 1_000,
    pollIntervalMs: 100,
    daemonExited: () => false,
    queryStatus: async () => ++attempts === 3
  });
  assert.equal(attempts, 3);
});

test("Windows readiness 超时保留最后一次 status 错误和 daemon stderr", async () => {
  const time = clock();
  await assert.rejects(
    () =>
      waitForDaemonReady({
        ...time,
        timeoutMs: 250,
        pollIntervalMs: 100,
        daemonExited: () => false,
        daemonErrors: () => "daemon detail",
        queryStatus: async () => {
          throw new Error("cannot connect to expected pipe");
        }
      }),
    (error) => {
      assert.match(error.message, /daemon readiness timed out/);
      assert.match(error.message, /last status error:[\s\S]*cannot connect to expected pipe/);
      assert.match(error.message, /daemon stderr:[\s\S]*daemon detail/);
      return true;
    }
  );
});

test("Windows daemon 提前退出时立即报告已有诊断", async () => {
  await assert.rejects(
    () =>
      waitForDaemonReady({
        daemonExited: () => true,
        daemonErrors: () => "startup failed",
        queryStatus: async () => false
      }),
    /daemon exited before reporting ready[\s\S]*startup failed/
  );
});

test("Windows daemon 在 status 查询期间退出时立即结束等待", async () => {
  let statusAborted = false;
  await assert.rejects(
    () =>
      waitForDaemonReady({
        daemonExited: () => false,
        daemonStopped: Promise.resolve(),
        daemonErrors: () => "spawn failed",
        queryStatus: async (_remainingMs, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                statusAborted = true;
                reject(signal.reason);
              },
              { once: true }
            );
          })
      }),
    /daemon exited before reporting ready[\s\S]*spawn failed/
  );
  assert.equal(statusAborted, true);
});

test("命令诊断有界且保留 stderr", () => {
  const error = Object.assign(new Error("status failed"), { stderr: "x".repeat(5_000) });
  const diagnostic = commandDiagnostic(error);
  assert.ok(diagnostic.length <= 4_000);
  assert.match(diagnostic, /x{100}/);
});

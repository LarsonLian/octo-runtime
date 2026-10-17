import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runCodexAppServerTurn } from "../packages/octo-runtime-adapter-codex/dist/app-server.js";
import { codexAppServerFixture, invokeRequest } from "./runtime-fixture.js";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
async function waitGone(pid) {
  const deadline = Date.now() + 2000;
  while (alive(pid) && Date.now() < deadline) await delay(10);
  assert.equal(alive(pid), false, `process ${pid} must exit`);
}

for (const protocolMode of ["canonical", "native"]) {
  for (const mode of ["cancel", "complete", "complete-eof", "cancel-paused"]) {
    test(
      `Codex ${protocolMode} ${mode} reaps tools after leader exits`,
      {
        skip: process.platform === "win32", // POSIX 组专项；Windows 真机验收由 issue #2 跟踪。
        timeout: 6000
      },
      async () => {
        const directory = await mkdtemp(join(tmpdir(), "octo-codex-owned-"));
        const readyPath = join(directory, "ready.json"),
          tickPath = join(directory, "ticks");
        const controller = new AbortController();
        let pids;
        const events = [];
        const stream = runCodexAppServerTurn({
          request: invokeRequest({
            signal: controller.signal,
            workdir: directory,
            approvalMode: "full_access"
          }),
          spec: {
            command: process.execPath,
            args: [
              fileURLToPath(new URL("../test-support/fake-codex-owned-tree.mjs", import.meta.url)),
              mode,
              readyPath,
              tickPath
            ],
            cwd: directory,
            env: process.env
          },
          context: { protocolMode }
        });
        try {
          for await (const event of stream) {
            events.push(event);
            const session =
              event.type === "session.update" ||
              (event.kind === "control" &&
                event.control.type === "evidence" &&
                event.control.name === "session");
            if (session) {
              pids = JSON.parse(await readFile(readyPath, "utf8"));
              if (mode.startsWith("cancel")) controller.abort("owned-tree-test");
              // 明确覆盖父先退；消费尚未结束时后代仍工作，随后 generator finally 必须回收。
              if (mode !== "complete-eof") await waitGone(pids.parentPid);
              if (mode === "cancel-paused") {
                // 消费者停在 session 帧，取消仍必须独立完成清理。
                await waitGone(pids.childPid);
              } else assert.equal(alive(pids.childPid), true);
            }
          }
          assert.ok(pids);
          assert.equal(
            alive(pids.childPid),
            false,
            "close must reap the TERM-resistant descendant"
          );
          const before = await readFile(tickPath, "utf8");
          await delay(100);
          assert.equal(
            await readFile(tickPath, "utf8"),
            before,
            "tools must stop writing after return"
          );
          const terminals = events.filter((event) =>
            protocolMode === "canonical"
              ? ["run.completed", "run.failed", "run.cancelled"].includes(event.type)
              : event.kind === "control" &&
                event.control.type === "state" &&
                event.control.state !== "running"
          );
          assert.equal(terminals.length, 1);
          const expected = mode.startsWith("cancel") ? "cancelled" : "completed";
          assert.equal(
            protocolMode === "canonical" ? terminals[0].type : terminals[0].control.state,
            protocolMode === "canonical" ? `run.${expected}` : expected
          );
        } finally {
          controller.abort("fixture-cleanup");
          if (!pids)
            pids = await readFile(readyPath, "utf8")
              .then(JSON.parse)
              .catch(() => undefined);
          if (pids) {
            for (const pid of [pids.parentPid, pids.childPid]) {
              if (alive(pid)) process.kill(pid, "SIGKILL");
              await waitGone(pid);
            }
          }
          await stream.return().catch(() => {});
          await rm(directory, { recursive: true, force: true });
        }
      }
    );
  }
}

for (const protocolMode of ["canonical", "native"]) {
  test(`Codex ${protocolMode} preserves execution and cleanup failures`, async () => {
    const fixture = codexAppServerFixture({ turnStartError: "original provider failure" });
    const child = fixture.spawnFn();
    // 纯模拟 child：不发送系统信号，验证新关闭失败不会覆盖原始 RPC 错误。
    child.pid = 123;
    child.stdin.end = () => child.stdin;
    const cleanupError = Object.assign(new Error("fixture cleanup denied"), { code: "EACCES" });
    child.kill = () => {
      throw cleanupError;
    };
    let released = false;
    try {
      const stream = runCodexAppServerTurn({
        request: invokeRequest(),
        spec: {
          command: "fixture",
          args: [],
          cwd: process.cwd(),
          env: {},
          cleanup: () => {
            released = true;
          }
        },
        spawnFn: () => child,
        context: { protocolMode }
      });
      await assert.rejects(
        async () => {
          for await (const event of stream) {
            void event;
          }
        },
        (error) => {
          assert.ok(error instanceof AggregateError);
          assert.match(error.errors[0].message, /original provider failure/);
          assert.equal(error.errors[1], cleanupError);
          assert.equal(error.cause, cleanupError);
          return true;
        }
      );
      assert.equal(released, true);
    } finally {
      fixture.close();
    }
  });
}

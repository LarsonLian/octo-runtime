# 07 Operations

## Runtime Files

默认目录是启动 daemon 时 cwd 下的 `.orbtex/`：

```text
.orbtex/
  daemon.sock   mode 0600 Unix socket
  state.json    mode 0600 versioned store
```

用绝对路径 `ORBTEX_HOME` 固定运行实例。不要让两个 daemon 共享 state file；当前 store 是 single-writer。

## Health And Discovery

```bash
pnpm cli status
pnpm cli adapter list
pnpm cli adapter probe codex
pnpm cli agent list
pnpm cli trigger list
pnpm cli task list
```

`probe` 只确认 binary 可执行；认证、模型、网络仍需 live invocation 验证。

## Run Inspection

```bash
pnpm cli run get <run-id>
pnpm cli run events <run-id>
pnpm cli run wait <run-id>
pnpm cli run cancel <run-id> --reason operator_cancel
```

诊断时先看最后一个 terminal event，再看此前的 provider error/tool event。事件 seq 是单 run 单调递增；不要用 wall-clock timestamp 代替顺序。

## Restart Semantics

使用 SIGINT/SIGTERM 停止 daemon，server 会关闭 host 并删除自己的 socket。state file 保留。重启会重新调度 queued run，并为已 materialize 但尚未建 run 的 queued Task 补建 attempt；running run 因 provider process 已丢失被明确标为 failed，而不是盲目重复执行有副作用的 turn。

需要 provider reattach 时，应新增 adapter capability、durable stdout/native run handle，再改变 recovery 策略；不能仅凭 provider session ID 假装能恢复正在流式执行的进程。

## Failure Boundaries

- daemon 崩溃：JSON 最近一次 atomic commit 可恢复。
- adapter-host 崩溃：RPC pending requests 立即 reject，daemon 将 run 收敛为 error。
- provider 非零退出：stderr tail 或结构化 provider error 进入 run.error。
- adapter 无 terminal：host 合成 stopped。
- cancel/complete 竞态：host 只发布一个 terminal。
- event 重放：`triggerId + externalEventId` 去重。

## Production Gaps

在多租户/多节点部署前补：数据库事务与 schema migration、outbox、worker lease/fencing、socket/API 身份认证、secret references、quota、audit、interaction/approval control tools、delivery outbox、provider host per-process isolation 和 observability。

# 07 Operations

## Runtime Files

默认目录固定在当前用户 home 下，不受启动 cwd 影响：

```text
~/.octo-harness/
  sockets/
    octo-harness-daemon.sock   mode 0600 Unix socket
  state.db                      SQLite durable state
  logs/
    YYYY-MM-DD/
      daemon.N.jsonl            operational events
      adapter-host.N.jsonl
      evaluation/               restricted RPC/provider evidence
```

用绝对路径 `OCTO_HARNESS_HOME` 固定运行实例。不要让两个 daemon 共享 state file；当前 store 是 single-writer。

`pnpm daemon` 通过 launcher 把最终生效的绝对路径作为 daemon argv 传入。以下环境变量可覆盖默认值：

```text
OCTO_HARNESS_HOME
OCTO_HARNESS_SOCKET
OCTO_HARNESS_STORE
OCTO_HARNESS_MANIFEST
OCTO_HARNESS_ADAPTER_HOST
OCTO_HARNESS_LOG_DIR
OCTO_HARNESS_LOG_LEVEL
OCTO_HARNESS_VERBOSE
OCTO_HARNESS_TRACE_RPC
OCTO_HARNESS_CAPTURE_PROVIDER_IO
```

daemon 也直接接受 `--socket`、`--store`、`--manifest`、`--adapter-host`、`--log-dir`、
`--log-level`、`--verbose`、`--trace-rpc` 和 `--capture-provider-io`。旧的
`--host-entrypoint` 继续作为 `--adapter-host` 的兼容别名。

## Process Discovery

launcher 会设置真实的 `argv[0]`，并把已解析的非敏感运行配置作为真实 argv 传给
daemon 和 adapter-host：

```bash
ps -axo pid=,ppid=,args= | grep '[o]rbtex-'
```

典型输出：

```text
octo-harness-daemon /absolute/apps/daemon/dist/index.js --socket /Users/name/.octo-harness/sockets/octo-harness-daemon.sock --store /Users/name/.octo-harness/state.db --manifest /absolute/config/adapters.json --adapter-host /absolute/apps/adapter-host/dist/index.js
octo-harness-adapter-host /absolute/apps/adapter-host/dist/index.js --manifest /absolute/config/adapters.json
```

进程参数只用于本机快速发现，不放入 token、prompt 或 provider 凭据。脚本和监控应使用
`octo-harness status` 的结构化结果，不应解析 `ps` 文本。

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

`status` 同时返回 daemon PID、socket/store/manifest 的有效绝对路径、adapter-host PID/入口、
已加载 adapter 类型和领域对象计数。

## Local Logs And Trace Viewer

daemon 默认把 operational 日志写入 `~/.octo-harness/logs/YYYY-MM-DD/`，按日和文件大小滚动。
日志不会持续打印到 stderr；stderr 只保留启动失败或日志系统降级等兜底元数据。查看有效目录和
采集状态：

```bash
octo-harness logs path
octo-harness logs query <run-id>
octo-harness logs open --run <run-id>
```

`logs open` 启动仅绑定 loopback 的临时 Viewer。页面用 Run 时间线展示 state.db 中的权威状态和
canonical event，以及 JSONL 中的 WSS、ChatTurn、adapter 和 provider dispatch 证据。

需要完整 RPC 和最终 provider input 时，以 verbose 模式启动 daemon：

```bash
octo-harness daemon --verbose
```

也可以分别使用 `--trace-rpc` 和 `--capture-provider-io=input|full`。受限 evidence 默认不会被
普通查询或 Viewer 返回；终端查询需要 `--sensitive`，Viewer 需要显式确认，并会在空闲十分钟
后自动折叠：

```bash
octo-harness logs query <run-id> --sensitive
```

### Migration From Stderr Trace

旧版本的 `OCTO_HARNESS_TRACE_RPC=1` 会把完整 frame 连续写入 daemon stderr。现在同一开关仍然
有效，但 frame 写入受限的本地 JSONL 文件，不再输出到终端或 service-manager journal。
依赖 stderr 文本的脚本应迁移到 `logs query`；人工诊断应使用 `logs open`。修改采集配置后仍需
重启 daemon。完整 provider input 可能包含客户数据和凭据，只能在受控本机环境中启用和查看。

## Run Inspection

```bash
pnpm cli run get <run-id>
pnpm cli run events <run-id>
pnpm cli run wait <run-id>
pnpm cli run stream <run-id>
pnpm cli run cancel <run-id> --reason operator_cancel
```

## Agent Work Runtime

daemon 可选连接 `octo-harness-agent-work` 的 Runtime WSS，并继续复用同一个 adapter-host。
配置、事件映射和边界见 [Agent Work Runtime 模式](13-agent-work-runtime.md)。

诊断时先看最后一个 terminal event，再看此前的 provider error/tool event。事件 seq 是单 run 单调递增；不要用 wall-clock timestamp 代替顺序。

## Restart Semantics

使用 SIGINT/SIGTERM 停止 daemon 会启动关闭流程：停止调度、等待 Unix server 关闭、终止 host
并删除 socket，state file 保留。当前 `server.close()` 会等待现有连接；未完成的 `run.wait`
可能拖住关闭流程，使 host 终止和 socket 删除延后，且尚无 connection drain timeout。

重启会重新调度 queued run，并为已 materialize 但尚未建 run 的 queued Task 补建 attempt；
running run 因 provider process 已丢失被明确标为 failed，而不是盲目重复执行有副作用的 turn。

需要 provider reattach 时，应新增 adapter capability、durable stdout/native run handle，再改变 recovery 策略；不能仅凭 provider session ID 假装能恢复正在流式执行的进程。

## Failure Boundaries

- daemon 崩溃：SQLite 中最近一次 atomic commit 可恢复。
- adapter-host 崩溃：RPC pending requests 立即 reject，daemon 将 run 收敛为 error。
- provider 非零退出：stderr tail 或结构化 provider error 进入 run.error。
- adapter 无 terminal：host 合成 stopped。
- cancel/complete 竞态：host 只发布一个 terminal。
- event 重放：`triggerId + externalEventId` 去重。

## Production Gaps

在多租户/多节点部署前补：数据库事务与 schema migration、outbox、worker lease/fencing、socket/API 身份认证、secret references、quota、audit、interaction/approval control tools、delivery outbox、provider host per-process isolation 和 observability。

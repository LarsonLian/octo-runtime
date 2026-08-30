# @orbtex-ai/daemon-app

Orbtex 的长驻 daemon 可执行程序与装配根。它把持久化 Store、领域 Engine、后台
`HarnessDaemon` 和独立 adapter-host 子进程组合起来，并通过本地 Unix Domain Socket 暴露
控制面。

## 作用

- 解析 socket、store、manifest 和 adapter-host 运行路径；
- 启动独立 adapter-host，并通过 `list` 完成就绪握手；
- 打开 `JsonFileStore`，创建 `HarnessEngine` 和 `HarnessDaemon`；
- 恢复 queued 工作并启动 interval schedulers；
- 监听本地 Unix socket，把 CLI method 分派到 Engine、Daemon、Store 或 Host client；
- 在 SIGINT/SIGTERM 时启动停止调度、关闭 server、终止 host 和删除 socket 的关闭流程；
- 向 `status` 暴露 daemon/host PID、有效路径、adapter 列表和领域对象计数。

当前运行拓扑：

```text
CLI
  -> Unix socket
daemon app
  -> JsonFileStore
  -> HarnessEngine
  -> HarnessDaemon
  -> AdapterHostRpcClient
       -> 独立 adapter-host 进程
            -> n 个 adapter 模块
```

## App 与 Package 的区别

`apps/daemon` 和 `packages/orbtex-daemon` 不是重复实现：

| 模块 | 作用 |
|---|---|
| `apps/daemon` | 可执行程序、路径配置、进程装配、Unix socket server 和 method dispatch |
| `packages/orbtex-daemon` | 可复用的 `HarnessDaemon` 调度库，负责 queue、trigger、wait、cancel 和 recovery |

package 不知道 socket、manifest、host entrypoint 或进程信号；app 负责把这些外部资源装配起来。

## 架构约束

daemon 是有状态控制面，不得直接 import 或加载 `@orbtex-ai/orbtex-adapter-*`。provider
adapter 必须由独立 `apps/adapter-host` 加载，daemon 只通过
`AdapterHostRpcClient` 的 `list/probe/invoke/cancel` 契约访问执行层。

这样可以避免可信但可能有 bug 的 adapter 异常直接发生在 daemon 进程内，并允许未来把
daemon 迁移到 Go/Rust 等运行时而保留 Node.js adapter 生态。完整约束与当前非保证见
[Adapter Host App](../adapter-host/README.md)。

## 运行文件

默认运行目录与启动 cwd 无关：

```text
~/.orbtex/
  sockets/
    orbtex-daemon.sock
  state.json
```

- socket 启动后权限设为 `0600`；
- socket 父目录自动创建；
- daemon 正常关闭时删除 socket；
- `state.json` 保留，用于下一次启动恢复；
- 当前 JSON Store 只支持单 daemon writer，不得让两个 daemon 共用同一 store。

## 配置优先级

显式命令参数优先于环境变量，环境变量优先于默认值：

| 资源 | 参数 | 环境变量 | 默认值 |
|---|---|---|---|
| Socket | `--socket` | `ORBTEX_SOCKET` | `~/.orbtex/sockets/orbtex-daemon.sock` |
| Store | `--store` | `ORBTEX_STORE` | `~/.orbtex/state.json` |
| Adapter manifest | `--manifest` | `ORBTEX_MANIFEST` | 仓库 `config/adapters.json` |
| Adapter-host entrypoint | `--adapter-host` | `ORBTEX_ADAPTER_HOST` | `apps/adapter-host/dist/index.js` |

`--host-entrypoint` 是 `--adapter-host` 的兼容别名。`ORBTEX_HOME` 会同时改变默认 socket 和
store 根目录，但不会覆盖显式的 `ORBTEX_SOCKET` 或 `ORBTEX_STORE`。

## 启动

在仓库根目录执行：

```bash
pnpm daemon
```

也可以运行 workspace app：

```bash
pnpm --filter @orbtex-ai/daemon-app start
```

launcher 会把有效配置转换为绝对路径和真实 argv，daemon 在就绪后向 stderr 输出 PID、
socket、adapter-host PID 和已加载 adapters。

另一个终端检查状态：

```bash
pnpm cli status
pnpm cli adapter list
```

## Socket 方法

daemon 当前暴露以下方法组：

```text
status
adapter.list / adapter.probe
agent.create / agent.list
chat.create / chat.list / chat.get / chat.send
trigger.create / trigger.list / trigger.fire
event.ingest
task.list / task.get / task.continue
run.get / run.events / run.wait / run.stream / run.cancel
```

CLI 到 daemon 使用一行 JSON request/response，不是 JSON-RPC 2.0。每个连接只读取第一行。
`run.stream` 是例外：request 仍为一行 JSON，response 使用多行 NDJSON 回放并实时推送
canonical events，terminal 后以 `done` 结束连接。daemon 到 adapter-host 才使用 stdio
NDJSON JSON-RPC 2.0。

## ACK、执行与恢复

- Chat、Trigger 和 Task continuation 在 queued Run 落 Store 后快速返回；
- provider invocation 通过 `setImmediate` 进入后台，不阻塞提交请求；
- daemon 启动时重新调度 queued Run；
- daemon 无法重新附着重启前仍为 running 的 provider 进程，因此将对应 Run 标记为 failed；
- interval Trigger 只由当前 daemon 进程的 timer 驱动；
- queued Run 由 Core 在本地同步取消并持久化为 cancelled，不调用 Host；
- running Run 的 cancel ACK 只表示取消已向 Host 传播，最终状态以随后到达的 terminal event 为准。

## 当前限制

- 单机、单 writer JSON Store，不是多节点生产调度器；
- 没有数据库事务、lease/fencing、outbox 或跨节点选主；
- adapter-host 崩溃后当前不会自动重启，需要重启 daemon；
- host 被异常终止时，不保证活动 provider CLI 子进程同步退出；
- `server.close()` 会等待现有 socket 连接结束；未完成的 `run.wait` 可能拖住关闭流程，使 host
  终止和 socket 删除延后，当前没有 connection drain timeout；
- Unix socket 只依赖宿主用户文件权限，没有额外应用层认证。

## 可复用入口

测试或其他本地 app 可以直接 import：

```ts
import { startDaemonServer } from "@orbtex-ai/daemon-app";
import { resolveDaemonRuntimePaths } from "@orbtex-ai/daemon-app/runtime-options";
```

`startDaemonServer` 返回 Store、Engine、Daemon、host process、runtime metadata 和 `close()`，
便于使用临时目录启动隔离的集成测试。

运维语义见 [Operations](../../docs/07-operations.md)，模块依赖和 transport 见
[Current Modules And Transport Flow](../../docs/02-module-and-transport-flow.md)。

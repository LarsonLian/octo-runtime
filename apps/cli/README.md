# @mininglamp-oss/octo-harness-cli

Octo Harness 面向用户和本地脚本的命令行入口。它把命令行参数转换为 daemon method，通过 Unix
Domain Socket 发送一行 JSON request，读取一行 JSON response，并把结果输出为 JSON。

## 作用

- 启动前台 daemon launcher；
- 查看 daemon、adapter、Agent、Chat、Task、Trigger 和 Run；
- 创建 Agent、Chat 和 Trigger；
- 发送 Chat turn、触发 Trigger、摄入外部事件和继续 Task；
- 等待、检查或取消 Run；
- 查询本地日志，或启动仅监听 loopback 的 Run Trace Viewer；
- 把相对 workdir 规范化为绝对路径。

运行链路：

```text
用户或本地脚本
  -> apps/cli
  -> ~/.octo-harness/sockets/octo-harness-daemon.sock
  -> apps/daemon
```

CLI 到 daemon 的协议是“一行 JSON request + 一行 JSON response”，不是 JSON-RPC 2.0。
每条普通命令新建一个 socket 连接，服务端只处理第一行请求。

## 职责边界

CLI 只负责参数解析、请求映射、socket I/O 和 JSON 展示，不负责：

- 直接读取或修改 `state.db` 或日志文件；
- 执行 Task/Run 状态迁移；
- 加载 provider adapter；
- 启动 Codex、Claude Code 等 provider CLI；
- 实现后台调度或恢复。

领域规则属于 `octo-harness-core`，后台编排属于 `octo-harness-daemon`，provider 执行通过独立
adapter-host 完成。

## 启动

先在终端 A 启动 daemon：

```bash
pnpm daemon
```

终端 B 执行 CLI：

```bash
pnpm cli status
pnpm cli adapter list
pnpm cli adapter probe codex
```

通过 workspace bin 安装或链接后，也可以直接使用 `octo-harness`：

```bash
octo-harness status
octo-harness adapter list
```

`octo-harness daemon` 会进入 daemon launcher，与根命令 `pnpm daemon` 使用相同的运行路径解析规则。

## 命令概览

| 命令 | 作用 |
|---|---|
| `status` | 查看 daemon/adapter-host PID、运行路径、adapter 和对象计数 |
| `adapter list` | 列出 host 已加载的 adapters |
| `adapter probe <type>` | 检查 provider CLI 是否可执行 |
| `logs path/query/open` | 查看日志状态、终端查询或打开本地 Trace Viewer |
| `agent create/list` | 创建或列出 Agent 配置 |
| `chat create/list/get/send` | 管理 Chat session，提交 turn，并可用 `--follow` 跟随结果 |
| `trigger create/list/fire` | 管理 manual/event/interval Trigger |
| `event ingest` | 摄入外部事件并匹配 event Trigger |
| `task list/get/continue` | 查看 Task 或创建后续 Attempt |
| `run get/events/wait/stream/cancel` | 查看、等待、实时跟随或取消 Run |

完整参数可执行：

```bash
pnpm cli help
```

## 最小流程

```bash
pnpm cli agent create \
  --name demo \
  --adapter codex \
  --workdir "$PWD" \
  --sandbox read-only

pnpm cli chat create --agent <agent-id> --title "Repository chat"
pnpm cli chat send <session-id> --prompt "Summarize this repository" --follow
```

不带 `--follow` 时，Chat/Task 提交在 Run 持久化为 queued 后快速返回。`chat send --follow`
会在同一个 CLI 进程中先输出 ACK，再以 NDJSON 实时输出每个 canonical event，直到 terminal
event 和 `done`。已有 Run 可以执行：

```bash
node apps/cli/dist/index.js run stream <run-id>
node apps/cli/dist/index.js run stream <run-id> --from-seq 5
```

`run stream` 会先回放 `fromSeq` 之后已经持久化的事件，再继续跟随新增事件，因此不会漏掉
CLI 建立流连接前已经到达的早期事件。

## 本地日志与 Viewer

```bash
octo-harness logs path
octo-harness logs query <run-id>
octo-harness logs open --run <run-id>
```

`logs query` 在终端返回 JSON；`logs open` 启动临时 HTTP Viewer 并默认打开浏览器。Viewer 只
监听 loopback，访问能力放在 URL fragment 中并在页面载入后移除。页面通过 daemon 的
`logs.viewer` 只读方法增量获取有界记录，而不是直接读取 state 或 JSONL 文件。

restricted RPC/provider evidence 默认不返回。终端查询使用 `--sensitive`；Viewer 必须由用户
显式确认，并在空闲十分钟后自动折叠。Viewer 从 `state.db` 获取 Run 状态和 canonical-event
时序，再与 JSONL 的 WSS、ChatTurn、adapter 和 provider 证据合并。

## 运行目录与 Socket

默认 socket：

```text
~/.octo-harness/sockets/octo-harness-daemon.sock
```

CLI 和 daemon 复用 `@mininglamp-oss/octo-harness-daemon-app/runtime-options`，避免默认路径漂移。可以通过以下
环境变量覆盖：

```text
OCTO_HARNESS_HOME
OCTO_HARNESS_SOCKET
```

`OCTO_HARNESS_HOME=/custom/home` 时，默认 socket 为
`/custom/home/sockets/octo-harness-daemon.sock`；`OCTO_HARNESS_SOCKET` 优先级更高。

## 输出与错误

- 成功结果以格式化 JSON 写入 stdout；
- 参数错误、daemon RPC 错误和连接错误以 JSON 写入 stderr；
- 失败时进程退出码非零；
- daemon 未启动时，错误会包含实际 socket 路径和启动提示。

命令行参数可能出现在 shell history 和本机进程列表中。不要通过 `--prompt`、
`--instruction`、`--payload` 或其他 flags 传递 token、私钥等长期凭据。

运维与诊断见 [Operations](../../docs/07-operations.md)，完整调用链见
[Current Modules And Transport Flow](../../docs/02-module-and-transport-flow.md)。

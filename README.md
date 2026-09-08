# Octo Harness

Octo Harness 是 provider-neutral 的本地 Agent Runtime。它把 Codex、Claude Code、CodeBuddy、OpenCode 和 OpenClaw local 统一成一套 invocation 与 canonical event 协议，但不拥有 IM、Loop、AutoPilot、Webhook 等业务的任务模型或调度状态。

生产链路只有一种执行抽象：Agent Worker 创建 `AgentSession` 和 `AgentRun`，Harness 接收 `run.start`，调用 provider，并把事件与 opaque provider session 回传。Chat 和 Task 只是上游产品形态，不是 Harness 的两套执行模式。

## 责任边界

| 组件 | 持有 | 不持有 |
|---|---|---|
| 业务服务 | namespace 内的触发规则、父子任务、重试、投递策略 | provider 进程和恢复协议 |
| Agent Worker | Agent、AgentSession、AgentRun、run lease 与生命周期 | Loop Task、IM 会话、Webhook 定义 |
| Octo Harness | invocation、provider adapter、canonical events、本地可靠 outbox | Chat/Task/Attempt/Trigger 业务表 |
| Channel Gateway | 外部事件归一化、Trigger Occurrence、IM delivery | AgentRun 生命周期 |

`namespace` 用来隔离业务语义，例如 `loop`、`autopilot`、`webhook`、`im`。稳定会话由 `(namespace, agent_id, session_key)` 唯一确定；`trigger_occurrence_id` 表示一次外部触发事实，并用于同一会话内的提交去重。

## 代码结构

```text
apps/
  daemon/              Worker WSS Runtime、可靠 outbox、本地诊断 socket
  cli/                 daemon 运维与本地 AgentRun 诊断
  adapter-host/        独立 provider host 进程
installers/
  macos/install.sh     macOS 一键安装 stage-0
  windows/install.ps1  Windows 一键安装 stage-0
packages/
  octo-harness-protocol/            invoke / canonical event contract
  octo-harness-core/                AgentSession / AgentRun reference engine
  octo-harness-daemon/              单会话 FIFO、执行与恢复
  octo-harness-adapter-host/        invocation lifecycle + NDJSON RPC
  octo-harness-adapter-sdk/         adapter helpers
  octo-harness-adapter-*/           provider adapters
  octo-harness-cross-service/       launchd/systemd user/Task Scheduler 生命周期
```

Core 中的 SQLite `AgentSession`/`AgentRun` 是单机 reference profile 的诊断投影。接入 Agent Worker 时，Worker 数据库是云端唯一权威，Harness 的 `agent-work.db` 只保存尚未 durable ACK 的命令/事件，不能成为第二套控制面。

## 一键安装

面向最终用户的入口按平台拆分。两个位置参数固定为 `server-url`、`enrollment-token`；token 是短期、单次使用的设备 enrollment grant，不是 Human Session、`bf_` Bot key 或永久 Runtime Bearer token。

程序与运行状态刻意分离。CLI 走 npm 全局安装，Harness Home 不保存程序版本：

| 平台 | CLI / package | Harness Home |
|---|---|---|
| macOS | `npm install -g @mininglamp-oss/octo-harness`；shim 位于 `<npm prefix -g>/bin/octo-harness` | `~/.octo-harness/` |
| Windows | `npm install -g @mininglamp-oss/octo-harness`；shim 位于 `<npm prefix -g>\octo-harness.cmd` | `%LOCALAPPDATA%\OctoHarness\` |

安装器会验证全局 shim，并在需要时自动把 npm global bin 加入 macOS shell profile 或 Windows 当前用户 PATH，所以安装后可直接用 `octo-harness` 调试。Harness Home 只保存 profile、`runtime_id`、设备凭证、SQLite/outbox、PID/socket 和日志。升级或普通卸载 package 时保留它；`uninstall --purge --yes` 才删除身份与状态。

### macOS

```bash
curl -fsSL https://im-test.deepminer.com.cn/octo-harness/install.sh \
  | sh -s -- \
      "https://im-test.deepminer.com.cn" \
      "octo_enroll_REPLACE_WITH_ONE_TIME_TOKEN"
```

### Windows PowerShell

```powershell
& ([scriptblock]::Create((irm https://im-test.deepminer.com.cn/octo-harness/install.ps1))) `
  "https://im-test.deepminer.com.cn" `
  "octo_enroll_REPLACE_WITH_ONE_TIME_TOKEN"
```

命令成功后应达到以下状态：

1. 检查 Node.js 24+ 与 npm；macOS 可用已有 Homebrew 安装 `node@24`，Windows 可用已有 `winget` 安装当前 Node LTS。
2. stable 默认执行 `npm install -g @mininglamp-oss/octo-harness@latest`，beta 对应 npm `beta` tag，并确保 CLI shim 可从 PATH 直接调用。
3. 同版本 CLI 从 stdin 消费一次性 token，创建或对账 profile 的永久 `runtime_id` 与设备凭证。
4. CLI 通过用户级原生管理器安装自启动：macOS LaunchAgent、Windows 当前用户 Task Scheduler；service definition 使用绝对 Node 与 daemon 入口路径，不依赖 shell PATH。
5. daemon 启动后，CLI 分别等待本地 IPC Ready 和云端 Runtime Online；任一步失败都返回非零。
6. 重跑时先取得 Home 与 npm prefix 安装锁；若旧 CLI 已存在，先执行 `setup --prepare-update` drain/stop，再更新 npm package，最后由新 CLI repair/start。npm 更新失败会尝试 `setup --recover-update` 恢复旧 service；全过程不创建第二个 Runtime，也不覆盖已有身份和 durable outbox。

把 token 直接放在位置参数里最适合 Web 页面生成“复制即安装”的一次性命令，但它会进入 shell/PowerShell 历史。更安全的人工安装方式是省略第二个参数，安装器会从 TTY/SecureString 隐藏读取 token：

```bash
curl -fsSL https://im-test.deepminer.com.cn/octo-harness/install.sh \
  | sh -s -- "https://im-test.deepminer.com.cn"
```

```powershell
& ([scriptblock]::Create((irm https://im-test.deepminer.com.cn/octo-harness/install.ps1))) `
  "https://im-test.deepminer.com.cn"
```

安装器源码、npm 发布合同、PATH 与提权边界见 [installers](installers/README.md)。它们是 stage-0，只负责 Node/npm 检查、全局安装和调用 `octo-harness setup`；凭证、service 与 readiness 状态机必须留在 TypeScript CLI。

> 当前仓库尚未具备可公开发布的一键安装链路：`apps/cli` 还未实现真正的 `setup`，npm package 也尚未正式发布。现有脚本会在 setup 失败时返回非零，不会把“npm package 已安装”假装成“Runtime 已上线”。

## 源码开发与验证

要求 Node.js 24+。真实 provider 还要求对应 CLI 已安装并完成认证。

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

测试使用 fake provider 和临时 SQLite，不调用真实模型。

## 启动 Runtime

连接 Agent Worker 时，非敏感连接信息可放参数或环境变量；Runtime token 只允许通过环境变量注入：

```bash
export OCTO_HARNESS_AGENT_WORK_URL=http://127.0.0.1:8092
export OCTO_HARNESS_AGENT_WORK_RUNTIME_TOKEN=dev-runtime-token
export OCTO_HARNESS_AGENT_WORK_TENANT_ID=tenant-1
export OCTO_HARNESS_AGENT_WORK_SUBJECT_ID=device-local-1
export OCTO_HARNESS_AGENT_WORK_RUNTIME_NAME=octo-harness-local
pnpm daemon
```

本地运维命令：

```bash
pnpm cli status
pnpm cli adapter list
pnpm cli adapter probe codex
pnpm cli agent-session list
pnpm cli agent-run list
pnpm cli agent-run events <agent-run-id>
```

这些命令只查看当前 daemon 的本地 reference/诊断投影。创建 AgentRun、reset AgentSession 或查询云端权威状态，应调用 Agent Worker API 或 `octo-cli harness agent-run ...`。

## 会话恢复

Harness 永远不生成业务 `session_key`。上游业务服务按统一规则生成：

- IM 群：`v1/<platform>/<endpoint_id>/group/<group_id>`
- IM 私聊：`v1/<platform>/<endpoint_id>/dm/<user_id>`
- Loop Task：`v1/task/<task_id>`
- AutoPilot 单次节点：`v1/execution/<execution_id>/node/<node_instance_id>`
- AutoPilot 长期节点：`v1/plan/<plan_id>/node/<node_id>`
- Webhook subject：`v1/hook/<endpoint_id>/subject/<subject_id>`
- Buddy conversation：`v1/workspace/<workspace_id>/conversation/<conversation_id>`

Provider 返回的 Codex thread ID、Claude session UUID 或 OpenCode session ID 存在 Worker 的 `AgentSession.provider_session` 中。下一次 `run.start` 将它放入 `InvokeRequest.providerSession.sessionId`；该字段对 Worker 与 Harness 都是 opaque。`/reset` 由 Worker 增加 session generation/provider epoch 并清空 provider session，下一轮 provider 创建新的 thread/session。

## 进一步阅读

- [Architecture](docs/01-architecture.md)
- [Module And Transport Flow](docs/02-module-and-transport-flow.md)
- [Prompt And Workdir](docs/04-prompt-and-workdir.md)
- [Provider Adapters](docs/05-provider-adapters.md)
- [Transport And Multi-node](docs/09-transport-and-multinode.md)
- [Agent Worker Runtime](docs/13-agent-work-runtime.md)

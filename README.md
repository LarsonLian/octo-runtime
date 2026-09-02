# Octo Harness

从零实现的 Agent harness reference implementation。它统一 Codex、Claude Code、CodeBuddy、OpenCode、OpenClaw local 与 Dify 远程应用，同时把 Chat、Task、Trigger、Run、provider session 与流式事件保持为明确的领域对象。

项目仓库：[dmwork/octo-harness/octo-harness](https://codex.mlamp.cn/dmwork/octo-harness/octo-harness)。本目录使用 pnpm workspace 和严格 TypeScript，所有可复用协议、runtime 与 adapters 位于 `packages/*`，所有可执行项目位于 `apps/*`。源码统一为 `src/*.ts`，构建后从 `dist/*.js` 运行并发布对应的 `*.d.ts` 类型声明。

## 当前能力

- Chat 与 Task 共用 `Session -> Run -> EventEnvelope`，Task 额外拥有 Attempt/trigger source。
- `manual`、`event + filter`、`interval` triggers；trigger occurrence 幂等落 Task。
- daemon 快速 ACK 后后台执行，支持 comment-style Task continuation。
- 原子 JSON 持久化、daemon 重启恢复、每个 Task/Chat session 单 active run。
- 独立 Node adapter-host 进程，manifest 动态加载 adapters，NDJSON JSON-RPC 调用/事件/取消。
- canonical message/tool/usage/session/run events；final/analysis channel 分离；terminal exactly once。
- Codex、Claude Code、CodeBuddy ACP、OpenCode、OpenClaw local、Dify Chatflow 与 Dify Workflow adapters。
- provider session 恢复、命令 probe、CLI 和契约测试。

这是可运行的架构基线，不是多节点生产调度器。JSON store 假设单 daemon writer；生产环境应替换成事务数据库、outbox、lease/fencing 和鉴权控制面。

本地 stdio 与跨云 WebSocket 共用上层 Agent 逻辑的目标架构、双向 JSON-RPC 样例、event ACK/重放和多节点 lease 设计见 [Transport And Multi-node](docs/09-transport-and-multinode.md)。该文档描述下一阶段设计，不代表当前代码已经具备跨云运行能力。

## 项目结构

```text
apps/
  cli/                 Unix socket CLI
  daemon/              durable control plane + worker
  adapter-host/        独立 provider host 进程
  example-basic/       in-process Codex example
packages/
  octo-harness-protocol/            canonical event / invoke contract
  octo-harness-core/                Chat/Task/Trigger/Run domain engine
  octo-harness-daemon/              queue, scheduler, recovery
  octo-harness-adapter-host/        host lifecycle + NDJSON RPC
  octo-harness-adapter-sdk/         adapter helpers + subprocess runtime
  octo-harness-acp-client/          CodeBuddy ACP JSON-RPC client
  octo-harness-adapter-codex/       Codex provider adapter
  octo-harness-adapter-claude-code/ Claude Code provider adapter
  octo-harness-adapter-codebuddy/   CodeBuddy ACP adapter
  octo-harness-adapter-opencode/    OpenCode provider adapter
  octo-harness-adapter-openclaw/    OpenClaw local adapter
  octo-harness-dify-client/         Dify HTTP/SSE transport client
  octo-harness-adapter-dify-chatflow/ Dify Chatbot/Chatflow adapter
  octo-harness-adapter-dify-workflow/ Dify Workflow/Completion adapter
config/adapters.json   adapter manifest
test/                  contract and integration tests
```

## 安装与验证

要求 Node.js 20+。真实 provider 还需要相应 CLI 已安装并完成认证。

```bash
cd octo-harness
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

`pnpm test` 会先构建全部 workspace。测试不会调用真实模型；它使用测试内 adapter fixture、native event fixtures、真实 fake ACP 子进程、独立 adapter-host 进程和临时 JSON store。

每个 adapter 的运行环境、认证、参数和完整教程统一收录在 [Packages And Adapter Guide](packages/README.md)，并可继续进入各 adapter package 的独立 README。

## 启动 daemon

终端 A：

```bash
pnpm daemon
```

默认状态位于 `~/.octo-harness/state.json`，socket 位于
`~/.octo-harness/sockets/octo-harness-daemon.sock`。可显式隔离：

```bash
export OCTO_HARNESS_HOME=/absolute/path/to/runtime-state
pnpm daemon
```

终端 B：

```bash
pnpm cli status
pnpm cli adapter list
pnpm cli adapter probe codex
```

## 最小 Task 示例

以下示例使用 Codex adapter，需要先安装并登录 Codex CLI：

```bash
pnpm cli agent create \
  --name demo \
  --adapter codex \
  --workdir "$PWD" \
  --sandbox read-only

pnpm cli trigger create \
  --name inspect-repo \
  --kind manual \
  --agent <agent-id> \
  --title "Inspect repository" \
  --instruction "Summarize this repository"

pnpm cli trigger fire <trigger-id> \
  --event-id manual-001 \
  --payload '{"requestedBy":"local"}'
```

`trigger fire` 立即返回 `taskId/runId`。随后：

```bash
pnpm cli run wait <run-id>
pnpm cli run events <run-id>
pnpm cli task continue <task-id> \
  --source-id comment-001 \
  --instruction "Now focus on the test strategy"
```

第二次 Task attempt 复用同一个 harness/provider session，但获得新的 run ID 和独立 event seq。

也可以用进程内示例执行同一流程：

```bash
pnpm demo
```

## Chat 示例

```bash
pnpm cli chat create --agent <agent-id> --title "Repository chat"
pnpm cli chat send <session-id> --prompt "What is the architecture?"
pnpm cli run wait <run-id>
pnpm cli chat send <session-id> --prompt "Continue with failure modes"
```

Chat 没有伪造 Task/Attempt；它与 Task 只共享 Session/Run/Event 和 provider session binding。

## Event 与 Interval Trigger

事件 trigger：

```bash
pnpm cli trigger create \
  --name main-changed \
  --kind event \
  --event-type repo.changed \
  --filter '{"branch":"main"}' \
  --agent <agent-id> \
  --title "Review change" \
  --instruction "Review the incoming repository change"

pnpm cli event ingest \
  --type repo.changed \
  --event-id github-delivery-123 \
  --payload '{"branch":"main","commit":"abc123"}'
```

Interval trigger：

```bash
pnpm cli trigger create \
  --name periodic-check \
  --kind interval \
  --every-ms 60000 \
  --agent <agent-id> \
  --title "Periodic check" \
  --instruction "Inspect current repository health"
```

## 真实 Provider Agent

以下命令必须在 Octo Harness 仓库根目录执行，并且需要先在另一个终端运行 `pnpm daemon`。创建 Agent 只保存配置并检查 adapter 已加载，不会立即调用模型。

```bash
# Codex: default workspace-write sandbox
pnpm cli agent create --name codex --adapter codex --workdir "$PWD" --sandbox read-only

# Claude Code: unattended bypass by default; requires an externally isolated runtime
pnpm cli agent create --name claude --adapter claude-code --workdir "$PWD"

# CodeBuddy: ACP transport
pnpm cli agent create --name codebuddy --adapter codebuddy --workdir "$PWD" --permission-mode dontAsk

# OpenCode: model is often best made explicit
pnpm cli agent create --name opencode --adapter opencode --workdir "$PWD" --model opencode/hy3-free

# OpenClaw: one local CLI subprocess per invocation; no Gateway required
pnpm cli agent create --name openclaw --adapter openclaw --provider-agent main --thinking medium

# Dify Chatbot/Chatflow: remote HTTPS + SSE; requires DIFY_CHATFLOW_API_KEY
pnpm cli agent create --name dify-chat --adapter dify-chatflow --workdir "$PWD"

# Dify Workflow: fixed inputs are configured in the adapter manifest or an Input Resolver
pnpm cli agent create --name dify-workflow --adapter dify-workflow --workdir "$PWD"
```

Claude Code 默认绕过 provider 权限确认以支持无人值守执行，必须由容器、VM 或等价的 Runtime 隔离限制文件系统、网络和凭证。Codex 的 `--dangerously-bypass-permissions` 与 OpenCode 的 `--auto-approve` 仍需显式打开；不要在没有外部 sandbox 的环境启用危险权限。

取消执行：

```bash
pnpm cli run cancel <run-id> --reason user_cancelled
```

## 进一步阅读

- [Architecture](docs/01-architecture.md)
- [Current Modules And Transport Flow](docs/02-module-and-transport-flow.md)
- [Pnpm Monorepo](docs/03-monorepo.md)
- [Packages And Adapter Guide](packages/README.md)
- [Prompt And Workdir](docs/04-prompt-and-workdir.md)
- [Provider Adapters](docs/05-provider-adapters.md)
- [OpenClaw Local Adapter](docs/06-openclaw-local-adapter.md)
- [Operations](docs/07-operations.md)
- [Adapter 开发指南](docs/08-adapter-authoring.md)
- [Transport And Multi-node](docs/09-transport-and-multinode.md)
- [Protocol Schema And Codegen](docs/10-protocol-schema-codegen.md)
- [Aily 多触发机制与 Octo Harness 统一 Blueprint](docs/11-aily-trigger-and-execution-review.html)
- [Aily Task、Run 与 Agent 执行概念模型](docs/12-aily-task-agent-run-concept-model.md)
- [Agent Work Runtime 模式](docs/13-agent-work-runtime.md)

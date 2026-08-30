# @orbtex-ai/orbtex-adapter-codex

Codex provider adapter。

Adapter type：`codex`

## 作用与适用场景

把本地 `codex exec` CLI 接入 Orbtex 的统一 `InvokeRequest -> CanonicalEvent` 契约。适合代码审阅、仓库修改、测试执行等需要 Codex 工具能力，并希望由 Orbtex 统一管理 Chat/Task、session resume、取消和事件汇报的场景。

它只负责 Codex provider 差异，不负责排队、Trigger、持久化或远端节点调度。

## 设计原则

- 用户 prompt 走 stdin；harness control instructions 走 invocation-private shadow `CODEX_HOME`。
- 复用真实认证与 sessions，但不修改用户真实 `config.toml`。
- Codex thread ID 作为 opaque provider session 上报，由 Core 保存后用于 `exec resume`。
- native item/turn 事件在 adapter 内转换，Core 不出现 Codex 专用分支。
- 权限与 sandbox 由 Codex CLI 执行，workdir 本身不被描述成安全边界。

## 它运行在哪里

这是一个 **本地 CLI subprocess adapter**。`orbtex` 的 adapter-host 在当前运行节点上为每次 invocation 启动一个 `codex exec` 进程，通过 stdin 发送用户 prompt，并从 stdout 读取 JSONL 事件。

“本地”只表示 CLI 和工具执行发生在 host 所在机器；模型通常仍由 Codex 配置的远程 provider 提供。当前 Orbtex 是单机 daemon + 本机 adapter-host，不会把这次执行自动调度到另一台云节点。

| 项目 | 当前实现 |
|---|---|
| Process model | 每次 invocation 一个 `codex` 子进程 |
| Native transport | stdin + stdout JSONL |
| Workdir | Orbtex Agent 的 `workdir`，作为 CLI cwd；实际访问边界由 Codex sandbox 决定 |
| Session resume | `codex exec resume <thread-id>` |
| Control instructions | invocation-private shadow `CODEX_HOME/config.toml` |
| User prompt | stdin，不进入 argv |
| 本机验证版本 | `codex-cli 0.149.0`，2026-08-28 |

## 环境准备

1. 安装 Node.js 20+，在 `orbtex` 根目录执行 `pnpm install`。
2. 安装 Codex CLI，确保 adapter-host 的 `PATH` 能找到 `codex`。
3. 在启动 daemon 的同一个用户环境完成认证。

```bash
codex --version
codex login status
```

adapter 会读取真实的 `CODEX_HOME`，未设置时使用 `~/.codex`。它复制用户 `config.toml` 到临时 shadow home，并按存在情况链接 `auth.json`、`sessions`、`skills` 和 `rules`，因此不需要把认证信息复制到项目 workdir。

在 shadow 副本中，adapter 会用本次 daemon-owned control context **覆盖** 原有 `developer_instructions`，而不是拼接；真实 `CODEX_HOME/config.toml` 不会被修改。这能保证本次 harness contract 唯一，但也意味着用户原有 developer instructions 不会自动继承。若业务依赖两者合并，应先为 adapter 增加显式 merge policy 和测试。

## 创建 Agent

先启动 daemon，再在另一个终端 probe：

```bash
cd /absolute/path/to/orbtex
pnpm daemon
```

```bash
cd /absolute/path/to/orbtex
pnpm cli adapter probe codex

pnpm cli agent create \
  --name codex-reviewer \
  --adapter codex \
  --workdir /absolute/path/to/repository \
  --sandbox read-only
```

创建命令会返回 Orbtex Agent ID。随后走统一 Chat 流程：

```bash
pnpm cli chat create --agent <agent-id> --title "Codex review"
pnpm cli chat send <session-id> --prompt "Review this repository without modifying files"
pnpm cli run wait <run-id>
pnpm cli run events <run-id>
```

## 可配置项

| `agent create` 参数 | `agentConfig` 字段 | 作用 |
|---|---|---|
| `--workdir DIR` | `workdir` | Codex cwd 和预期代码目标，本身不是文件系统隔离 |
| `--model MODEL` | `model` | 传给 `codex exec --model` |
| `--sandbox MODE` | `sandbox` | 新 session 的 sandbox，默认 `workspace-write`；可用值取决于 CLI 版本 |
| `--dangerously-bypass-permissions` | `dangerouslyBypassPermissions` | 传入 `--dangerously-bypass-approvals-and-sandbox` |

危险 bypass 只适用于已经有外部隔离的执行节点。普通代码审阅优先使用 `read-only`；需要修改仓库时使用默认 `workspace-write`。

## 实际命令形态

首次 turn：

```text
codex exec --json --skip-git-repo-check [--model ...] [--sandbox ...] -
```

后续 turn：

```text
codex exec resume <provider-thread-id> --json --skip-git-repo-check [--model ...] -
```

adapter 从 `thread.started` 取出 provider thread ID，以 `session.update` 上报。Core 保存这个 opaque ID，下一轮自动放回 `InvokeRequest.providerSession`。当前实现不暴露 `exec fork`，所以 capability 中没有 `session.fork`。

新 session 会显式设置 sandbox；resume 不重复追加 `--sandbox`，依赖已恢复 session 和 Codex 配置延续原策略。危险 bypass 若启用则每次都会显式传入。

## Prompt 与事件

- daemon 生成的 control/context 写入临时 `config.toml` 的 `developer_instructions`。
- 用户 prompt 通过 stdin 传入。
- `thread.started` -> `session.update`。
- agent message -> `message.delta`。
- command/tool item -> `tool_call.create/update`。
- `turn.completed` -> `usage.update`、`message.update`、`run.finished`。
- `turn.failed` -> `message.update(failed)`、`run.error`。

临时 shadow home 在 invocation 结束后删除；provider session 文件仍位于真实 Codex sessions 目录，供下一轮恢复。

## 取消与限制

`run cancel` 会 abort 本次子进程，host 最终只发布一个 `run.stopped`。当前通用 JSON CLI runtime 终止直接子进程，生产环境仍应补进程组级回收，避免 provider 派生工具进程残留。

当前限制：

- 没有暴露 Codex image、output schema、fork、review 等额外 CLI 能力。
- adapter 使用 `--skip-git-repo-check`，因此非 Git 目录也可运行；这不等于目录可信。
- `probe` 只检查 executable，不检查认证、网络、模型额度或 workdir 权限。
- provider 升级后应运行契约测试，再做受控的只读 live smoke test。

实现：[src/index.ts](src/index.ts)。公共使用流程见 [Adapter Guide](../README.md)。

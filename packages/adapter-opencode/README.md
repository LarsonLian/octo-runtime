# OpenCode Adapter

Adapter type：`opencode`

## 它运行在哪里

这是一个 **本地 OpenCode CLI subprocess adapter**。adapter-host 在当前节点为每次 invocation 启动 `opencode run --format json`，读取 stdout JSON events 并转换成 Orbtex canonical events。

OpenCode CLI 与文件工具在 host 节点执行；模型位置由 OpenCode provider 配置决定，通常是远程服务。不要把 OpenCode 和 OpenClaw 混淆：它们是两个 adapter、两个 executable 和两套 session 格式。

| 项目 | 当前实现 |
|---|---|
| Process model | 每次 invocation 一个 `opencode run` 子进程 |
| Native transport | argv message + stdout JSON events |
| Workdir | Orbtex Agent 的 `workdir`，作为 CLI cwd；本身不是 sandbox |
| Session resume | `--session <opencode-session-id>` |
| Control instructions | mode `0600` 临时文件 + inline config |
| User prompt | OpenCode positional argv |
| 默认权限 | provider 正常询问；`autoApprove=true` 时传 `--auto` |
| 本机验证版本 | OpenCode `1.18.21`，2026-08-28 |

## 环境准备

1. 安装 Node.js 20+，在 `orbtex` 根目录执行 `pnpm install`。
2. 安装 OpenCode CLI，使 `opencode` 位于 daemon/host 的 `PATH`。
3. 配置至少一个 provider 和凭证。

```bash
opencode --version
opencode auth list
```

需要新增 provider 时使用当前 CLI 的认证入口：

```bash
opencode auth login
```

具体 provider/model 名称随本地 OpenCode 配置变化；不要把示例模型当成跨环境固定值。

## 创建 Agent

```bash
cd /absolute/path/to/orbtex
pnpm daemon
```

另一个终端：

```bash
cd /absolute/path/to/orbtex
pnpm cli -- adapter probe opencode

pnpm cli -- agent create \
  --name opencode-reviewer \
  --adapter opencode \
  --workdir /absolute/path/to/repository \
  --model provider/model
```

然后使用统一 Chat 流程：

```bash
pnpm cli -- chat create --agent <agent-id> --title "OpenCode review"
pnpm cli -- chat send <session-id> --prompt "Summarize the repository"
pnpm cli -- run wait <run-id>
pnpm cli -- run events <run-id>
```

## 可配置项

| `agent create` 参数 | `agentConfig` 字段 | 作用 |
|---|---|---|
| `--workdir DIR` | `workdir` | OpenCode cwd 和预期代码目标，不构成文件访问隔离 |
| `--model provider/model` | `model` | 传给 `opencode run --model` |
| `--auto-approve` | `autoApprove` | 传给危险的 `--auto` |

`--auto-approve` 会允许 provider 自动批准没有被显式拒绝的权限。只应在受控 workdir 和外部隔离节点使用。

## 实际命令形态

首次 turn：

```text
opencode run --format json [--model provider/model] [--auto] <user-prompt>
```

后续 turn：

```text
opencode run --format json --session <provider-session-id> [--model ...] [--auto] <user-prompt>
```

OpenCode 原生支持 `--fork` 和 `--agent`，但当前 Orbtex adapter 没有暴露这两个能力。公共 CLI 的 `--provider-agent` 目前只由 OpenClaw adapter 消费，不能用它配置 OpenCode agent。

## Prompt、配置与 session

daemon instructions 写到 `0600` 临时 Markdown 文件。adapter 读取已有 `OPENCODE_CONFIG_CONTENT`，保留其中的 `instructions`，再把临时文件追加到列表中，并把合并结果注入子进程环境。

用户 prompt 作为 `opencode run` positional message 出现在 argv。这意味着同机进程检查工具可能看到 prompt；如需更强隐私，应改用 OpenCode server/API 或增加 stdin/message-file carrier，而不是声称当前实现已经隐藏 argv。

- `step_start/session.created` -> `session.update`。
- text part -> `message.delta`。
- running tool part -> `tool_call.create`。
- completed/error tool part -> `tool_call.update`。
- step finish -> `usage.update`。
- structured error -> `run.error`。
- 进程正常退出且 provider 未发 terminal -> adapter 合成 message terminal 和 `run.finished`。

Core 保存 OpenCode session ID，后续 Chat turn 或 Task continuation 自动恢复。

## 取消与限制

`run cancel` abort 当前 OpenCode CLI。host 保证最终只有一个 `run.stopped`。

当前限制：

- 用户 prompt 在 argv 中，不适合含 secret 的请求。
- 不暴露 OpenCode agent、variant、thinking、attach/server、fork 等选项。
- `OPENCODE_CONFIG_CONTENT` 必须是合法 JSON；非法值会在 spawn 前失败。
- `probe` 只检查 executable，不检查 provider credential、model 或 network。
- 当前通用 subprocess runtime 没有完整进程组回收保证。

实现：[src/index.js](src/index.js)。公共使用流程见 [Adapter Guide](../README.md)。

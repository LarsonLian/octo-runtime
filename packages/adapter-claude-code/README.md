# Claude Code Adapter

Adapter type：`claude-code`

## 它运行在哪里

这是一个 **本地 Claude Code CLI subprocess adapter**。adapter-host 在当前节点为每次 invocation 启动 `claude --print`，用户 prompt 走 stdin，Claude stream-json 走 stdout。

CLI、文件工具和 shell 在 host 节点运行；模型请求通常发往 Anthropic 或 Claude Code 配置的云 provider。“本地 adapter”不代表模型权重在本机，也不代表当前 Orbtex 已支持跨云节点调度。

| 项目 | 当前实现 |
|---|---|
| Process model | 每次 invocation 一个 `claude` 子进程 |
| Native transport | stdin text + stdout stream-json |
| Workdir | Orbtex Agent 的 `workdir`，作为 CLI cwd；本身不是文件系统隔离 |
| Session resume | `--resume <claude-session-uuid>` |
| Control instructions | mode `0600` 临时文件 |
| User prompt | stdin，不进入 argv |
| 默认 permission mode | `acceptEdits` |
| 本机验证版本 | Claude Code `2.1.145`，2026-08-28 |

## 环境准备

1. 安装 Node.js 20+ 并在 monorepo 根目录执行 `pnpm install`。
2. 安装 Claude Code，使 `claude` 位于 daemon/host 的 `PATH`。
3. 使用同一操作系统用户完成认证。

```bash
claude --version
claude auth status
```

也可以使用 Claude Code 支持的 provider 环境变量，但 secret 必须只存在于进程环境或凭证存储，不能写入 Agent prompt、Orbtex state 或 workdir。

当前 adapter 固定使用 `--print`。本机 Claude Code `2.1.145` 的帮助明确说明非交互 print 模式跳过 workspace trust 对话框，因此必须只配置已经审查并信任的 workdir；Orbtex 不会代替该对话框判断目录可信度。

## 创建 Agent

```bash
cd /absolute/path/to/orbtex
pnpm daemon
```

另一个终端：

```bash
cd /absolute/path/to/orbtex
pnpm cli -- adapter probe claude-code

pnpm cli -- agent create \
  --name claude-reviewer \
  --adapter claude-code \
  --workdir /absolute/path/to/repository \
  --permission-mode dontAsk
```

然后使用公共 Chat API：

```bash
pnpm cli -- chat create --agent <agent-id> --title "Claude review"
pnpm cli -- chat send <session-id> --prompt "Explain the current architecture"
pnpm cli -- run wait <run-id>
pnpm cli -- run events <run-id>
```

`dontAsk` 适合无法弹出交互确认的保守自动化，但具体哪些工具可执行仍由 Claude Code 配置决定；它不是 Orbtex 自己实现的文件 sandbox。

## 可配置项

| `agent create` 参数 | `agentConfig` 字段 | 作用 |
|---|---|---|
| `--workdir DIR` | `workdir` | Claude Code cwd 和预期代码目标，不构成安全边界 |
| `--model MODEL` | `model` | `--model`，可用别名/完整名称取决于 CLI |
| `--permission-mode MODE` | `permissionMode` | 默认 `acceptEdits`；本机版本支持 `acceptEdits/auto/bypassPermissions/default/dontAsk/plan` |

当且仅当 mode 为 `bypassPermissions` 时，adapter 还会传入 `--dangerously-skip-permissions`。不要在无外部 sandbox 的共享机器上启用。

## 实际命令形态

```text
claude --print \
  --input-format text \
  --output-format stream-json \
  --verbose \
  --append-system-prompt-file <temporary-file> \
  [--resume <provider-session-id>] \
  [--model <model>] \
  --permission-mode <mode> \
  -
```

首次 invocation 从 Claude `system` 事件取得 session UUID；Core 持久化后，下一轮自动加 `--resume`。Claude CLI 原生支持 fork，但当前 host/core 没有 fork 流程，因此 adapter 不声明 `session.fork`。

## Prompt 与事件

- daemon-owned context 和 per-turn instructions 写入 `0600` 临时文件，通过 `--append-system-prompt-file` 注入。
- 用户 prompt 走 stdin。
- `system.session_id` -> `session.update`。
- assistant text block -> `message.delta`。
- assistant `tool_use` block -> `tool_call.create`。
- result -> usage、完整 message terminal 和 run terminal。

当前 parser 没有把 Claude 的 tool result 单独归一化为 `tool_call.update`；如果上层必须依赖完整工具终态，应先扩展 parser 和 fixture，再把它当成稳定合同。

## 取消与限制

`run cancel` 通过 AbortSignal 终止当前 Claude 子进程，host 负责 message 收尾和唯一 `run.stopped`。

当前限制：

- 不暴露 fork、MCP config、allowed tools、budget、effort、structured output 等 Claude 参数。
- 默认 `acceptEdits` 可能修改 workdir；只读任务应显式选更保守的 provider 策略，并使用文件系统隔离。
- `probe` 不验证认证、provider 网络、额度和模型名。
- 取消目前只保证直接 CLI 进程终止，生产环境应补进程组回收。

实现：[src/index.js](src/index.js)。公共使用流程见 [Adapter Guide](../README.md)。

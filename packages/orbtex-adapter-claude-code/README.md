# @orbtex-ai/orbtex-adapter-claude-code

Claude Code provider adapter。

Adapter type：`claude-code`

## 作用与适用场景

把本地 Claude Code `--print` 模式接入 Orbtex。适合需要 Claude Code 读取或修改可信代码目录，同时由 Orbtex 统一管理 Chat/Task、session resume、流式消息、tool call 和取消的场景。

它不实现 Claude 模型 API，也不负责 workspace trust、容器隔离或业务任务状态。

## 设计原则

- 用户 prompt 走 stdin，control instructions 走 mode `0600` 的临时 system-prompt file。
- Claude session UUID 原样保存和恢复，Core 不解释其格式。
- stream-json 只在 adapter 内归一化为 canonical message/tool/usage/run events。
- 无人值守 invocation 默认使用 bypassPermissions；外层 Runtime 必须提供真正的隔离边界。
- AskUserQuestion、EnterPlanMode 和 ExitPlanMode 在无交互通道的执行中固定禁用。
- 临时控制文件在 invocation 的 `finally` 阶段清理。

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
| 默认 permission mode | `bypassPermissions` + `--dangerously-skip-permissions` |
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
pnpm cli adapter probe claude-code

pnpm cli agent create \
  --name claude-reviewer \
  --adapter claude-code \
  --workdir /absolute/path/to/repository
```

然后使用公共 Chat API：

```bash
pnpm cli chat create --agent <agent-id> --title "Claude review"
pnpm cli chat send <session-id> --prompt "Explain the current architecture"
pnpm cli run wait <run-id>
pnpm cli run events <run-id>
```

默认 bypass 只解决 daemon 无法回答 provider 权限提示的问题，不提供安全隔离。生产 Runtime 必须使用容器、VM 或等价机制限制子进程可访问的文件系统、网络和凭证。需要保守执行时可以显式选择 `dontAsk`，但没有 Claude allow rules 的工具会直接被拒绝。

## 可配置项

| `agent create` 参数 | `agentConfig` 字段 | 作用 |
|---|---|---|
| `--workdir DIR` | `workdir` | Claude Code cwd 和预期代码目标，不构成安全边界 |
| `--model MODEL` | `model` | `--model`，可用别名/完整名称取决于 CLI |
| `--permission-mode MODE` | `permissionMode` | 默认 `bypassPermissions`；本机版本支持 `acceptEdits/auto/bypassPermissions/default/dontAsk/plan` |
| `--dangerously-bypass-permissions` | `dangerouslyBypassPermissions` | 强制使用 `bypassPermissions`，优先于 `permissionMode` |

当 mode 为 `bypassPermissions` 时，adapter 同时传入 `--dangerously-skip-permissions`。adapter 固定通过 `--disallowedTools` 禁用 AskUserQuestion、EnterPlanMode 和 ExitPlanMode，避免无人值守 Run 进入无法完成的交互流程。

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
  [--dangerously-skip-permissions] \
  --disallowedTools AskUserQuestion \
  --disallowedTools EnterPlanMode \
  --disallowedTools ExitPlanMode \
  -
```

首次 invocation 从 Claude `system` 事件取得 session UUID；Core 持久化后，下一轮自动加 `--resume`。Claude CLI 原生支持 fork，但当前 host/core 没有 fork 流程，因此 adapter 不声明 `session.fork`。

## Prompt 与事件

- daemon-owned context 和 per-turn instructions 写入 `0600` 临时文件，通过 `--append-system-prompt-file` 注入。
- 用户 prompt 走 stdin。
- `system.session_id` -> `session.update`。
- assistant text block -> `message.delta`。
- assistant `tool_use` block -> `tool_call.create`。
- user `tool_result` block -> `tool_call.update(completed/error)`。
- result -> usage、完整 message terminal 和 run terminal。

## 取消与限制

`run cancel` 通过 AbortSignal 终止当前 Claude 子进程，host 负责 message 收尾和唯一 `run.stopped`。

当前限制：

- 不暴露 fork、MCP config、allowed tools、budget、effort、structured output 等 Claude 参数。
- 默认 bypass 可以执行 shell、修改 workdir 并访问宿主机用户可访问的其他资源；没有外部隔离时不得用于不可信任务。
- `probe` 不验证认证、provider 网络、额度和模型名。
- 取消目前只保证直接 CLI 进程终止，生产环境应补进程组回收。

实现：[src/index.ts](src/index.ts)。公共使用流程见 [Adapter Guide](../README.md)。

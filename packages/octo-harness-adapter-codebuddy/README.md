# @mininglamp-oss/octo-harness-adapter-codebuddy

CodeBuddy provider adapter。

Adapter type：`codebuddy`

## 作用与适用场景

通过 ACP stdio JSON-RPC 驱动本地 CodeBuddy CLI，并把 session updates 转换成 Octo Harness canonical events。适合需要 CodeBuddy Agent 能力、思考/最终消息分频道、tool call 和跨 invocation session load 的场景。

它不在 Core 中暴露 ACP 细节；通用 ACP request/response 由 `@mininglamp-oss/octo-harness-acp-client` 承担。

## 设计原则

- ACP transport 与 CodeBuddy event mapping 分层，client 可独立测试。
- 新建和恢复 session 最终都进入同一条 `session/prompt` 流。
- agent thought 映射为 `analysis` channel，agent message 映射为 `final` channel。
- provider 反向权限请求默认拒绝，除非调用方显式提供策略。
- 每次 invocation 的 ACP 子进程必须可取消并在结束后回收。

## 它运行在哪里

这是一个 **本地 ACP subprocess adapter**。adapter-host 在当前节点启动 `codebuddy --acp`，然后通过 stdin/stdout 上的 NDJSON JSON-RPC 2.0 驱动 ACP protocolVersion 1 session。

CodeBuddy CLI、工具和代码目录位于本机；模型通常由 CodeBuddy 配置的云 provider 提供。ACP 只是本地进程间协议，不等于模型请求也在本地。

| 项目 | 当前实现 |
|---|---|
| Process model | 每次 invocation 一个 `codebuddy --acp` 子进程 |
| Native transport | ACP JSON-RPC over stdio NDJSON |
| Workdir | Octo Harness Agent 的 `workdir`，作为进程 cwd 并传给 `session/new/load`；本身不是 sandbox |
| Session resume | ACP `session/load` |
| Prompt carrier | ACP `session/prompt` text content |
| 默认 permission mode | `acceptEdits`，未处理权限请求时 deny fallback |
| 本机验证版本 | CodeBuddy `2.140.0`，2026-08-28 |

## 环境准备

1. 安装 Node.js 20+，在 monorepo 根目录执行 `pnpm install`。
2. 安装 CodeBuddy CLI，并确保 `codebuddy` 对 daemon 用户可见。
3. 先用同一个用户直接启动 CodeBuddy，按安装渠道完成登录或 provider 配置。

```bash
codebuddy --version
codebuddy --help
```

CodeBuddy 当前 CLI 没有与其他 provider 完全一致的 `auth status` 契约，所以 `adapter probe` 只做 executable 检查。认证是否可用应通过受控的 provider smoke test 确认。

## 创建 Agent

```bash
cd /absolute/path/to/octo-harness
pnpm daemon
```

另一个终端：

```bash
cd /absolute/path/to/octo-harness
pnpm cli adapter probe codebuddy

pnpm cli agent create \
  --name codebuddy-reviewer \
  --adapter codebuddy \
  --workdir /absolute/path/to/repository \
  --permission-mode dontAsk \
  --model glm-5.3
```

公共 Chat 使用方式不变：

```bash
pnpm cli chat create --agent <agent-id> --title "CodeBuddy review"
pnpm cli chat send <session-id> --prompt "Inspect the test coverage"
pnpm cli run wait <run-id>
pnpm cli run events <run-id>
```

## 可配置项

| `agent create` 参数 | `agentConfig` 字段 | 作用 |
|---|---|---|
| `--workdir DIR` | `workdir` | ACP cwd 和预期代码目标，不限制读取其他宿主路径 |
| `--model MODEL` | `model` | 只在新建 ACP session 时传给 `session/new` |
| `--permission-mode MODE` | `permissionMode` | 传给 `codebuddy --permission-mode`，默认 `acceptEdits` |

恢复已有 session 时 adapter 调用 `session/load`，不会重新设置 model；provider session 自己保留原模型上下文。

## ACP 调用顺序

子进程参数：

```text
codebuddy --acp \
  --permission-mode <mode>
```

RPC 顺序：

```text
initialize(protocolVersion=1)
session/new(cwd, model?) | session/load(sessionId, cwd)
session/prompt(sessionId, prompt=[{type:"text", text:"..."}])
session/update notifications...
```

adapter 不通过 CLI 参数删减 provider 的工具目录。ACP server 反向发起权限请求时，当前 client 会优先选择 reject/deny 选项；不能把 provider 没有弹窗误解成自动批准，也不能把“工具可见”误解成 surface 已实现所有交互合同。

## Prompt、事件与 session

当前 adapter 把用户 prompt 与 daemon instructions 合并为一个 ACP text：

```text
<user prompt>

<append instructions>
```

它不是独立 system role。若需要更强的 prompt 隔离，应扩展 ACP 初始化或 provider 原生 system prompt 配置，而不是把控制协议藏进 workdir skill。

- `session/new/load` 的 ID -> `session.update`。
- `agent_message_chunk` -> final `message.delta`。
- `agent_thought_chunk` -> analysis `message.delta`，并标记 `exposure=unknown` 与 CodeBuddy provenance；ACP 事件没有更强的公开语义，因此默认不进入公开 Presentation。
- `tool_call` / `tool_call_update` -> canonical tool lifecycle。
- prompt result usage -> `usage.update`。
- 正常 stream 结束 -> `message.update` + `run.finished`。

## 取消与限制

host abort 时 ACP client 关闭 CodeBuddy 子进程；虽然 client 实现了 `session/cancel`，当前 adapter 取消路径使用的是进程关闭，不是可重连的远端 cancel。

当前限制：

- 每次 invocation 都启动新的 ACP process；session transcript 由 CodeBuddy provider session 持久化并通过 `session/load` 恢复。
- 不声明 session fork、reattach 或 message append。
- 没有把 CodeBuddy sandbox、effort、agents、MCP 等参数暴露到公共 CLI。
- `probe` 不验证登录、模型可用性或额度。
- analysis 内容是否存在取决于 provider 实际发送的 ACP update；adapter 不伪造思考内容。

实现：[src/index.ts](src/index.ts)，ACP client：[../octo-harness-acp-client/src/index.ts](../octo-harness-acp-client/src/index.ts)。公共使用流程见 [Adapter Guide](../README.md)。

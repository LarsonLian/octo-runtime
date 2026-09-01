# 05 Provider Adapters

## Capability Matrix

| Adapter | Native transport | Resume | Fork capability | Default permission |
|---|---|---|---|---|
| [`codex`](../packages/orbtex-adapter-codex/README.md) | app-server JSON-RPC 2.0 stdio | `thread/resume`，失败 fresh fallback | not exposed | workspace-write sandbox |
| [`claude-code`](../packages/orbtex-adapter-claude-code/README.md) | `claude --print --output-format stream-json` | `--resume <uuid>` | not exposed | `bypassPermissions` + external isolation required |
| [`codebuddy`](../packages/orbtex-adapter-codebuddy/README.md) | ACP JSON-RPC stdio | `session/load` | not declared | `acceptEdits` + deny fallback |
| [`opencode`](../packages/orbtex-adapter-opencode/README.md) | `opencode run --format json` | `--session <id>` | not exposed | provider asks unless `autoApprove` |
| [`openclaw`](../packages/orbtex-adapter-openclaw/README.md) | `openclaw agent --local --json` JSONL | `--session-id <id>` | not exposed | OpenClaw agent policy |
| [`dify-chatflow`](../packages/orbtex-adapter-dify-chatflow/README.md) | HTTPS `POST /chat-messages` + SSE | `conversation_id` | not applicable | Dify app policy |
| [`dify-workflow`](../packages/orbtex-adapter-dify-workflow/README.md) | HTTPS `POST /workflows/run` + SSE | stateless | not applicable | Dify workflow policy |

上层按 capability 做决策，不按 adapter type 写分支。虽然 Codex、Claude Code 和 OpenCode 原生 transport 可 fork，当前 host 没有 fork RPC，因此 adapters 不声明 `session.fork`；新增完整 host/daemon/CLI 流程后才能打开该 capability。

## Native Event Mapping

Codex：`thread.started -> session.update`，agent message item -> message delta，command/tool item -> tool lifecycle，`turn.completed -> usage + message.update + run.finished`。

Claude Code：system init -> session update，assistant content blocks -> text/tool create events，user tool result blocks -> tool update，result -> usage/message terminal/run terminal。

CodeBuddy：ACP `session/update` 的 `agent_message_chunk` 和 `agent_thought_chunk` 映射为 final/analysis channels；tool_call/update 保留 ID；prompt result usage 映射 usage update。

OpenCode：step start -> session update，text part -> delta，tool part state -> tool lifecycle，step finish -> usage；进程成功退出后产生 message update/run finished。结构化 provider error 进入 run.error。

OpenClaw：adapter 先生成或恢复 provider session ID；`text/tool_use/tool_result/step_finish` 映射为公共事件，多行 final result blob 用来补齐最终文本、usage 和 session。取消终止本次 local CLI 并收敛为 `run.stopped`，不调用 Gateway `sessions.abort`。

Dify Chatflow：`conversation_id -> session.update`，`message -> message.delta`，workflow/node events -> progress surface，Chatbot 在 `message_end` 收尾，Chatflow 继续等待 `workflow_finished`。当前 manifest 显式选择 `applicationMode: chatbot`；仅当同一应用可能返回 advanced Chatflow workflow events 时才使用 `auto`。Dify Workflow/Completion 不制造 provider session；固定 inputs 进入 native request，文本或结构化 outputs 分别映射 message/surface。

## Local Verification On 2026-08-28

本机版本：Codex CLI `0.149.0`、Claude Code `2.1.145`、CodeBuddy `2.140.0`、OpenCode `1.18.21`。这四个 adapter 都完成了隔离目录 live invocation：

- Codex：provider thread `01a046e3-...`，有 usage 和 run.finished。
- Claude Code：provider session `bfcc9bd7-...`，有 usage 和 run.finished。
- CodeBuddy：ACP session `a370c065-...`，analysis/final chunks 和 run.finished。
- OpenCode：使用 `opencode/hy3-free`，session `ses_fb9185921ffe...`，有 usage 和 run.finished。

OpenClaw local adapter 使用 fake CLI 完成命令、双输出形态、tool、usage、session 和取消契约测试；本机 `OpenClaw 2026.7.1-2` probe 通过，但没有执行真实模型调用。因此它不能列入上面的 live invocation 证据。

2026-09-01 使用 Dify Cloud Chatbot app 完成两轮 live invocation：`/parameters` probe 为 200；两轮均产生 usage 与 `run.finished`，第二轮复用第一轮 `session.update` 返回的同一个 `conversation_id`。测试 key 未写入仓库或日志。

这证明当前机器上的真实 wire shape 可被 parser 消费；不是未来版本兼容承诺。升级 provider 后先运行 tests，再做一个只读 live smoke test。

## Adding Provider Options

Agent config 作为 InvokeRequest 的 `agentConfig` 传给 adapter。公共 CLI 当前支持 `model`、`providerAgentId`、`thinking`、`timeoutSeconds`、`permissionMode`、`sandbox`、`dangerouslyBypassPermissions`、`autoApprove`。provider-specific 新字段应由相应 adapter 读取，不应进入 core 分支。OpenClaw 的详细行为见 [OpenClaw Local Adapter](06-openclaw-local-adapter.md)。

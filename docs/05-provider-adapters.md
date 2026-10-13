# 05 Provider Adapters

## Capability Matrix

| Adapter | Native transport | Resume | Fork capability | Default permission |
|---|---|---|---|---|
| [`codex`](../packages/octo-harness-adapter-codex/README.md) | app-server JSON-RPC 2.0 stdio | `thread/resume`，失败 fresh fallback | not exposed | workspace-write sandbox |
| [`claude-code`](../packages/octo-harness-adapter-claude-code/README.md) | `claude --print --output-format stream-json` | `--resume <uuid>` | not exposed | `bypassPermissions` + external isolation required |
| [`codebuddy`](../packages/octo-harness-adapter-codebuddy/README.md) | ACP JSON-RPC stdio | `session/load` | not declared | `acceptEdits` + deny fallback |
| [`opencode`](../packages/octo-harness-adapter-opencode/README.md) | `opencode run --format json --thinking --auto` | `--session <id>` | not exposed | adapter always auto-approves |
| [`openclaw`](../packages/octo-harness-adapter-openclaw/README.md) | Gateway WS protocol v4 RPC + events | isolated session per AgentRun | not exposed | dedicated OpenClaw agent policy |
| [`zcode-gui`](../packages/octo-harness-adapter-zcode-gui/README.md) | ZCode private NDJSON RPC stdio | `session/resume`，失败 fresh fallback | not exposed | `build` fail-closed；显式 auto-approve / `yolo` |

上层按 capability 做决策，不按 adapter type 写分支。虽然 Codex、Claude Code 和 OpenCode 原生 transport 可 fork，当前 host 没有 fork RPC，因此 adapters 不声明 `session.fork`；新增完整 host/daemon/CLI 流程后才能打开该 capability。

## Native Event Mapping

Codex：`thread.started -> session.update`；agent message 的原生 `phase=commentary` 归一为 `channel=commentary`，`phase=final_answer` 归一为 `channel=final`；reasoning/plan 分别按授权级别进入 `channel=analysis`；command/tool item -> tool lifecycle；`turn.completed -> usage + run.finished`。下游只消费这些 canonical 字段，不读取 Codex 原生 phase。

Claude Code：system init -> session update，assistant content blocks -> text/tool create events，user tool result blocks -> tool update，result -> usage/message terminal/run terminal。

CodeBuddy：ACP `session/update` 的 `agent_message_chunk` 和 `agent_thought_chunk` 映射为 final/analysis channels；tool_call/update 保留 ID；prompt result usage 映射 usage update。

OpenCode：step start/finish -> `model_step.started/finished`（并从 step start 更新 session），text/reasoning part -> final/public reasoning analysis delta，tool part state -> tool lifecycle，step finish 同时更新 usage；同一原生 `messageID` 作为 `stepId` 关联一轮中的 reasoning/tool/text。进程成功退出后产生 message update/run finished，结构化 provider error 进入 run.error。

OpenClaw：adapter 先用 `config.get` 验证隔离配置，再用 `sessions.create.cwd` 建立绑定 Harness workdir 的唯一 session，调用 `sessions.messages.subscribe` 打开完整事件流，最后调用 `agent`；Gateway 的 assistant/thinking/tool/usage/lifecycle streams 映射为公共事件。终态必须经 `agent.wait` 确认，取消通过 `sessions.abort` 收敛为 `run.stopped`。

## Custom / Remote Integrations

上层契约 `InvokeRequest -> AsyncIterable<CanonicalEvent>` 与传输无关，因此可以实现非本地 CLI 的适配器（例如通过 HTTPS + SSE 接入 Dify 这类远程编排/应用平台）。**但当前不建议这样做。**

原因在于定位歧义：本项目的目标是**统一本地 Agent CLI**——代码执行、工具调用与文件操作发生在 adapter-host 所在节点。远程应用平台是一个能力边界与权限模型均不透明的“黑盒工作流服务”，把它与本地适配器并列会让使用者误判系统的安全与执行语义；同时远程集成将执行与凭证移出本机边界，`workdir`、sandbox、进程隔离等本地约束不再适用，取消与终态语义也更弱。

若确需自行接入此类集成，除事件翻译外，**该适配器必须在 agent 配置层显式声明其 capability 能力包与限制**（如是否支持 `session.serialize`、是否具备文件/工具能力、可用的取消语义），使上层按 capability 而非按 adapter type 做决策与限制。注意当前 `capabilities` 仅为 metadata、尚未在运行时强制校验，能力边界目前依赖约定而非强制。

## Local Verification On 2026-08-28

本机版本：Codex CLI `0.149.0`、Claude Code `2.1.145`、CodeBuddy `2.140.0`、OpenCode `1.18.21`。这四个 adapter 都完成了隔离目录 live invocation：

- Codex：provider thread `01a046e3-...`，有 usage 和 run.finished。
- Claude Code：provider session `bfcc9bd7-...`，有 usage 和 run.finished。
- CodeBuddy：ACP session `a370c065-...`，analysis/final chunks 和 run.finished。
- OpenCode：使用 `opencode/hy3-free`，session `ses_fb9185921ffe...`，有 usage 和 run.finished。

OpenClaw Gateway adapter 使用 fake Gateway 完成 RPC、runId 隔离、seq 去重、tool、session、最终响应回退和取消契约测试。此前本机 `OpenClaw 2026.9.4` 的真实模型验证包含托管 runner 和 `sessions.create.cwd`；该执行方式已经删除，历史结果不能证明当前已有 Agent 接入链路通过。当前 Adapter 保留用户的原生 workspace、Skill 和 memory，不创建 Agent 或修改 Gateway 配置；真实已有 Agent 与线上 Worker 联合验收需要按当前合同执行。

这证明当前机器上的真实 wire shape 可被 parser 消费；不是未来版本兼容承诺。升级 provider 后先运行 tests，再做一个只读 live smoke test。

## Adding Provider Options

`agentConfig.effort` 承载 Harness 统一档位 `low / medium / high / xhigh`，不是原生提供方档位。未配置时保留提供方默认值，不补 `medium`。原生档位转换仅在 adapter 生成命令或 RPC 参数时发生，不修改 Context、执行快照或 Core 中的用户选择。旧 `thinking` 配置仍不允许。

默认映射与验证见 [Adapter SDK reasoning.ts](../packages/octo-harness-adapter-sdk/src/reasoning.ts)，行为与验收见 [思考强度映射](reasoning-level-mapping.md)。其他 provider-specific 配置也由相应 adapter 读取，不进入 Core 分支。OpenClaw 的详细行为见 [OpenClaw Gateway Adapter](06-openclaw-local-adapter.md)。

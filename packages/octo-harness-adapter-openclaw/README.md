# @mininglamp-oss/octo-harness-adapter-openclaw

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../docs/context-llm-injection.md) 与 [IPD-SE 0.3](../../../docs/event-context-rendering-ipd-se.md)；旧链路退出仍待完成。

Octo Harness 的 OpenClaw Gateway adapter。Adapter 连接用户已经配置的 Agent，通过公开 Gateway protocol v4 执行并回传 canonical events。

## 责任边界

本地用户或 OpenClaw 管理 Agent 的 persona、Skill、Plugin、MCP、memory、tools、workspace 和原生审批。Harness 不创建 Agent，不调用 `config.patch`，不清空 workspace，也不设置 Gateway 的 `skipBootstrap`。

每次 Run 通过 `agents.list` 验证 Agent 存在。不存在时拒绝执行，不创建或修复 Agent。`sessions.create` 和 `agent` 不覆盖已有 Agent 的工作目录。模型、推理强度和本次输入仍按执行请求传入。

## 连接已有 Agent

先完成 Harness profile 登录，再保存本地连接与独立凭据：

```bash
printf '%s' "$OPENCLAW_GATEWAY_TOKEN" | \
  octo-harness --profile <profile> adapter connect openclaw \
    --binding-id <octo-external-binding-id> \
    --gateway-url wss://gateway.example.com \
    --agent-id research-agent \
    --workspace /srv/openclaw/research-agent \
    --token-stdin
```

`--workspace` 记录已有 Agent 的本地连接信息，不创建目录或覆盖执行工作目录。远程 Gateway 必须使用 `wss://`。Gateway token 和 device private key 只保存在 profile credential，不进入云端 revision、模型输入或 provider observation。

旧 `adapter setup openclaw`、`adapter openclaw configure/init` 和托管 runner 迁移已删除。用户通过 OpenClaw 自己的管理入口完成安装和配置。

## 执行合同

- 一次 AgentRun 使用一条已认证 WebSocket 和一个唯一 session key。
- Adapter 在 `agent` 前调用 `sessions.messages.subscribe`，接收完整增量事件。
- user input 进入 `message`，本次控制上下文进入 `extraSystemPrompt`。
- 事件按 runId 隔离、按 seq 去重。未知 stream 忽略。
- lifecycle terminal 由 `agent.wait` 确认。取消通过 `sessions.abort` 处理，断线后按 runId 对账。
- 若事件流缺失但 `agent` RPC 返回完整结果，Adapter 从实际结果补齐 final text、usage 和终态。
- 原生工具审批通过已有 interaction 合同回传，不证明工具已经安装。

协议版本或所需公开 method/event 缺失时拒绝执行。当前完整责任与验收见[本地插件责任改造](../../docs/24-local-plugin-ownership-refactor.md)。

## 模块责任边界

- 负责：将 openclaw 原生执行协议映射为 InvokeRequest / CanonicalEvent，由 adapter-host 调用。
- 不负责：Worker/IM WS、聊天历史、Event/AgentRun 登记。
- 协作边界：见 [根架构与包边界](../../README.md#模块责任边界)。所有执行来源共用 adapter-host IPC；模块按职责提供协议、执行或宿主能力。

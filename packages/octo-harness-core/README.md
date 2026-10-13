# @mininglamp-oss/octo-harness-core

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../docs/context-llm-injection.md) 与 [IPD-SE](../../../docs/event-context-rendering-ipd-se.md)。Host 仅按白名单 pattern 保序拼接，不做业务检查或编译。

单机 reference profile 的统一执行核心。它只定义 `Agent`、`AgentSession`、`AgentRun` 和 `EventEnvelope`，用于 adapter 合同测试与本地诊断。

## 模型

| 对象          | 含义                                                  |
| ------------- | ----------------------------------------------------- |
| Agent         | 本地可执行的 adapter 配置                             |
| AgentSession  | `namespace + agentId + sessionKey` 标识的连续上下文   |
| AgentRun      | 一次排队、执行、取消并进入终态的调用                  |
| EventEnvelope | 带 run ID、session ID 与单 Run seq 的 canonical event |

`submitAgentRun` 使用 `(agentSessionId, trigger.occurrenceId)` 去重。相同 occurrence 与相同请求返回原 Run；请求内容不同则冲突。同一 Session 的 Run 按 `runNo` FIFO，任何时刻最多一个 active Run。

Provider session 从 `session.update` 保存到 AgentSession，并在下一次 InvokeRequest 中原样恢复。Core 不解释 provider 的 `sessionId`。

## 非职责

Core 不定义 Chat、Task、TaskAttempt、Trigger scheduler、父子任务、IM delivery 或业务 retry。生产部署的 AgentSession/AgentRun 权威在 Agent Worker；本包的 SQLite store 不能与 Worker 同时充当控制面。

## 模块责任边界

- 负责：维护本地执行状态和引擎，经注入的 adapter 调用能力执行。
- 不负责：Worker/IM WS、群聊、业务投递。
- 协作边界：见 [根架构与包边界](../../README.md#模块责任边界)。所有执行来源共用 adapter-host IPC；模块按职责提供协议、执行或宿主能力。

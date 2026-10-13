# 可执行入口与责任边界

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../docs/context-llm-injection.md) 与 [IPD-SE 0.3](../../docs/event-context-rendering-ipd-se.md)；旧链路退出仍待完成。

| 入口 | 负责 | 实现依赖 |
|---|---|---|
| [cli](cli/README.md) | 运维、Home/profile、原生服务与诊断 | cross-service、daemon |
| [daemon](daemon/README.md) | 配置、进程启动、信号转发 | daemon 装配 worker-access 与共享 Host |
| [adapter-host](adapter-host/README.md) | 独立 Host 进程与 stdio IPC | adapter-host、Adapters |

沿用已有 CLI，不为 IM 或本地助理新增 Runtime 项目。Worker 与 IM 是 packages 中的接入模块，所有 AgentRun 通过同一个 adapter-host 执行。IM 包当前仅骨架。

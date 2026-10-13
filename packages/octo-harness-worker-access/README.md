# Worker 接入

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../docs/context-llm-injection.md) 与 [IPD-SE 0.3](../../../docs/event-context-rendering-ipd-se.md)；旧链路退出仍待完成。

> 目标职责见 [Event Context IPD-SE 0.3](../../../docs/event-context-rendering-ipd-se.md)：模型上下文只校验和转发，场景追加、任务材料预取、Compiler/Pipeline 与摘要计划退出；授权、租约、工作区及执行管理继续保留。以下记录当前实现，尚未实施本次退出清单。

## 责任边界

- 负责：管理 Worker 注册、profile、WS 建连重连、远端命令与准备回执、执行 envelope 转换和事件回传。构造 AgentWorkRuntime / AgentWorkSupervisor 时由宿主传入 AdapterHostRpc。
- 不负责：不启动 Daemon 或 adapter-host，不实现 IM Server 协议。其他入口使用 Host 不需要实例化本包。
- 接口与现状：从 Daemon 提取远程接入实现。旧 Channel context 已移除；本包保留远端执行需要的材料准备和 ContextPipeline 编排。事件重放采用有界内存，不使用 durable ACK/outbox。通用本地上下文准备位于 context-builder，向 Worker 提交回执位于 context-preparation-receipt.ts。

整体架构见 [根 README](../../README.md)。

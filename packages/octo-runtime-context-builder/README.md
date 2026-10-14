# 发起侧上下文构造

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../docs/context-llm-injection.md) 与 [IPD-SE](../../../docs/event-context-rendering-ipd-se.md)。Host 仅按白名单 pattern 保序拼接，不做业务检查或编译。

本包只提供发起侧可选构造工具。业务方可以直接创建 ContextEnvelope，不必注册 Provider 或经过构造流水线。执行侧 Compiler、压缩及 Node 子入口已删除。

## 责任边界

- 负责：提供浏览器可用的 awareness → ContextEnvelope 构造工具；采集和发送策略由业务方选择。
- 不负责：不编译模型输入，不读取执行侧材料，不调用摘要模型，不依赖 Daemon 或 Worker。
- 执行准备：工作区准备位于 adapter-host/execution-preparation；授权图片读取位于 worker-access/input-images；Worker 执行准备回执位于 worker-access/context-preparation-receipt。

整体架构见 [根 README](../../README.md)。

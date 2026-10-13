# Worker 接入

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../docs/context-llm-injection.md) 与 [IPD-SE](../../../docs/event-context-rendering-ipd-se.md)。Host 仅按白名单 pattern 保序拼接，不做业务检查或编译。

本包直接转发当前 Event 的模型上下文。场景追加、任务材料预取、Compiler/Pipeline、材料摘要与扩展投影已删除。授权、租约、工作区及执行管理继续保留。

## 责任边界

- 负责：管理 Worker 注册、profile、WS 建连重连、远端命令与准备回执、执行 envelope 转换和事件回传。构造 AgentWorkRuntime / AgentWorkSupervisor 时由宿主传入 AdapterHostRpc。
- 不负责：不启动 Daemon 或 adapter-host，不实现 IM Server 协议。其他入口使用 Host 不需要实例化本包。
- 接口与现状：事件重放采用有界内存，不使用 durable ACK/outbox。工作区准备调用 adapter-host 的 prepareRunContext；图片按原输入与已有授权读取。准备回执只确认本次执行身份和工作区，不包含编译版本、材料消费或摘要证据。

整体架构见 [根 README](../../README.md)。

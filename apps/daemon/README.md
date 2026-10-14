# Daemon 启动入口

现行设计见 [Runtime 本地存在与按需在线合同](../../docs/runtime-local-and-online-contract.md)。本启动器是标品配置装配入口；客户使用 daemon 包本地 SDK，不调用此 app launcher。

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../docs/context-llm-injection.md) 与 [IPD-SE 0.3](../../../docs/event-context-rendering-ipd-se.md)；旧链路退出仍待完成。

## 责任边界

- 负责：解析配置、启动现有 Daemon、转发信号，接入既有用户服务管理。
- 不负责：不承载 Worker WS 业务实现，不为 IM 建第二套启动器。
- 接口与现状：实现分别由 daemon、worker-access、adapter-host 包持有。原有小型转导出文件仅用于现有入口调用。

整体架构见 [根 README](../../README.md)。

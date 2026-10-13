# 上下文构造与本地准备

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../docs/context-llm-injection.md) 与 [IPD-SE 0.3](../../../docs/event-context-rendering-ipd-se.md)；旧链路退出仍待完成。

> 目标职责见 [Event Context IPD-SE 0.3](../../../docs/event-context-rendering-ipd-se.md)：本包保留发起侧构造工具；编译与材料摘要计划删除，工作区和图片准备迁入执行模块。以下记录当前实现，尚未实施本次退出清单。

## 责任边界

- 负责：根入口提供浏览器可用的场景上下文构造。context-preparation、run-context、context-compaction、input-images 和两种 material-compaction 子入口提供 Node 侧执行准备工具。
- 不负责：根入口不导入 Node 工具。包不依赖 Daemon 或 Worker 接入，不提交 Worker HTTP 回执，不创建 AgentRun，不处理 IM 投递。
- 接口与现状：prepareRunContext 只依赖 WorkspaceAssignments 端口，由调用方提供工作区分配。Worker 特有 recordContextPreparation 在 worker-access 包。

整体架构见 [根 README](../../README.md)。

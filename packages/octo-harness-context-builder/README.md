# 上下文构造与本地准备

## 责任边界

- 负责：根入口提供浏览器可用的场景上下文构造。context-preparation、run-context、context-compaction、input-images 和两种 material-compaction 子入口提供 Node 侧执行准备工具。
- 不负责：根入口不导入 Node 工具。包不依赖 Daemon 或 Worker 接入，不提交 Worker HTTP 回执，不创建 AgentRun，不处理 IM 投递。
- 接口与现状：prepareRunContext 只依赖 WorkspaceAssignments 端口，由调用方提供工作区分配。Worker 特有 recordContextPreparation 在 worker-access 包。

整体架构见 [根 README](../../README.md)。

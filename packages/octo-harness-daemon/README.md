# Daemon 装配与本地执行

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../docs/context-llm-injection.md) 与 [IPD-SE 0.3](../../../docs/event-context-rendering-ipd-se.md)；旧链路退出仍待完成。

## 责任边界

- 负责：管理共享 adapter-host 进程及重启、本地 UDS/Pipe 控制接口、reference Run 调度、诊断与观测。通过注入同一个 AdapterHostRpc 装配 Worker 和 IM 接入模块。HostRunService 提供本地源流的序号、短窗口重放、终态查询和取消；不保存聊天历史。
- 不负责：Worker WS、注册和远端命令处理实现归 worker-access；IM 业务归 IM 包。不得为新入口复制 Host 或 provider 执行逻辑。
- 接口与现状：server.ts 是装配根，runtime-core.ts 是本地调度。index.ts 为现有 SDK 消费者保留转导出；转导出不代表实现仍由 Daemon 持有。

整体架构见 [根 README](../../README.md)。

本地 Run API：`agent_run.submit` / `invoke` / `subscribe` / `get` / `cancel` / `respond`，使用 UDS/Windows Pipe。源流查询使用 `run_id`，订阅带 `stream_id` 和 `after_seq`；断开订阅不取消 Run。现有 `runId` reference 查询仍由本地调度处理。详细实现范围见 [本地流方案](../../docs/26-channel-local-stream-and-ack-plan.md)。

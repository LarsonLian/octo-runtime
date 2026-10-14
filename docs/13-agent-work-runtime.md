# 可选 Worker Runtime 接入

日期：2026-10-14。当前原则见 [Runtime 合同](runtime-local-and-online-contract.md)，本地与远程路径见 [模块流程](02-module-and-transport-flow.md)。

## 当前边界

本地 Runtime 先初始化稳定身份，直接通过 daemon SDK／IPC／Host 执行。Worker 注册和连接仅在 HostApp 明确启用 worker-access 后发生；不创建或 ensure 业务 Agent，不读取 Worker Agent defaults／mandatory。

现有接入包的注册实现位于 `worker-access/src/enrollment.ts`，模块工厂为 `createWorkerAccessModule`。工厂通过注入的共享 Host 处理当前远程执行，不另建 Host。客户仅本地或 IM 时无需携带该包。

当前包仍组合 enrollment、WS 与远程执行。access 的最终注册职责及设备连接／heartbeat 划分待评审，不能宣称当前工厂已经完成最终拆分。

## 请求与执行

业务发起方准备目标、五元组和本轮 Context v3。Worker 的独立 Run 接入保留身份、权限、路由、lease／fencing 等执行校验；这些校验不要求恢复 Agent registry 或业务 Event／ActionExecution 表。

Provider session 是执行链返回的 opaque 数据；其存在不保证恢复成功。本轮模型上下文由业务选择，底层不依据会话首轮自动注入 instructions，不补背景、不合并或去重。恢复失败后由业务方重新提供必要材料。

执行 limits 使用本轮执行配置和 Host 当前合同，见 [Context 执行分类](context-llm-injection.md)。历史 AgentRevision 配置不是当前注册或调用入口。

## 流与状态

连接、命令接纳、执行终态和业务保存分别判断。源流及远程 relay 是有界内存，不保证 durable outbox 或重启后完整重放；断流只能沿原源游标修复，缺口／过期明确失败，不自动重执行。

当前 API 见 [接入指南](../INTEGRATION.md#26-可选远程执行worker-接入)及 [Worker 路由](../../octo-agent-worker/internal/handler/router.go)。真实验证及剩余范围见 [包解耦记录](validation/daemon-package-modules-2026-10-14.md)。

旧 AgentRevision、自动 ensure、首轮指令注入、Channel Context 缓存和 durable ACK 方案存放在 [历史快照](13-agent-work-runtime-historical-2026-10-14.md)，不作为现行合同。

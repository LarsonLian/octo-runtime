# Worker 接入-该方案尚未通过架构评审

现行设计见 [Runtime 本地存在与按需在线合同](../../docs/runtime-local-and-online-contract.md)。本包仅在 HostApp 明确选择 Worker 接入时携带并启用；客户本地 SDK 无需部署本包。

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../docs/context-llm-injection.md) 与 [IPD-SE](../../../docs/event-context-rendering-ipd-se.md)。Host 仅按白名单 pattern 保序拼接，不做业务检查或编译。

本包直接转发当前 Event 的模型上下文。场景追加、任务材料预取、Compiler/Pipeline、材料摘要与扩展投影已删除。授权、租约、工作区及执行管理继续保留。

## 最终架构期望

access 的已确认职责仅为显式注册设备和 Runtime。注册必须复用稳定的本地 Runtime ID，不创建 Agent，不读取业务 defaults／mandatory。导入本包或启动本地 Host 不得自动注册或建立连接；注册失败不影响本地 IPC。

daemon 根据宿主配置装配对外模块，注入对应 token 和服务地址。待实施的设备在线开关应保存在宿主本地，与 IM 频道启用独立；关闭时不加载设备连接，并停止已有连接。设备 WS、heartbeat、云端失效和本包能力的最终拆分尚待架构评审，不能将下文现有实现全部纳入最终 access 定义。

## 现有实现（待按目标调整）

2026-10-14 包迁移：原 embedded 的 enrollment 已移入本包的 `enrollment.ts`，公开 `createWorkerAccessModule` 工厂接收宿主显式配置。daemon 不依赖本包；仅导入或携带本包不注册、不建立 WS。工厂使用 daemon 注入的同一个 Host，注册沿用本地 Runtime ID。此迁移不表示设备 WS 的最终架构已通过评审。

- 负责：管理 Worker 注册、profile、WS 建连重连、远端命令与准备回执、执行 envelope 转换和事件回传。构造 AgentWorkRuntime / AgentWorkSupervisor 时由宿主传入 AdapterHostRpc。
- 不负责：不启动 Daemon 或 adapter-host，不实现 IM Server 协议。其他入口使用 Host 不需要实例化本包。
- 接口与现状：事件重放采用有界内存，不使用 durable ACK/outbox。工作区准备调用 adapter-host 的 prepareRunContext；图片按原输入与已有授权读取。准备回执只确认本次执行身份和工作区，不包含编译版本、材料消费或摘要证据。

整体架构见 [Runtime README](../../README.md#设计原则与实施状态)，需求与验收见 [IPD-SE 基线](../../../docs/local-runtime-ipc-on-demand-ipd-se.md)。

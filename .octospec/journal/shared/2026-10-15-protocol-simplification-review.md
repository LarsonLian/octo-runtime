---
type: Journal
title: 业务标签删除后的协议简化检查
description: 区分可删除的占位合同、应回归业务层的字段及仍有实际用途的执行协议。
tags: [architecture, protocol, review]
timestamp: 2026-10-15T00:00:00Z
---

# 检查范围

后续状态：重复执行入口已按[统一输入任务](../../tasks/unify-invoke-transport/brief.md)收敛，只有 Host 解析执行配置。SDK、RPC 和 CLI 不再准备 InvokeRequest。Work App 也已移除旧场景依赖并完成真实 renderer 执行，见[验收记录](2026-10-15-unify-invoke-transport.md)。以下建议保留原检查时含义，不能据此判断当前入口仍为三参数。

检查当前本地 Runtime 的协议定义和生产调用者，以及桌面消费边界。第 1 项按[计划字段任务](../../tasks/remove-unused-plan-fields/brief.md)删除，第 2 项按[业务场景任务](../../tasks/remove-business-scenarios/brief.md)删除，第 3 项按[快照任务](../../tasks/remove-context-snapshot/brief.md)删除；重复执行参数和统一调用链尚待收敛，不将占位、仅格式校验或单测当作端到端执行支持。

## 优先处理

1. 执行计划中的 `required_execution_features` 与 `provider_compatibility`：在当前 Runtime 源码中仅定义和校验，Core 不生成它们，Host 不使用它们执行要求匹配。它们没有形成可信执行保证。建议删除未消费字段；真实执行检查继续由审批、图片、MCP、输出模式等具体合同承担。不能将业务 capabilities 改名迁入此字段。
2. `ScenarioRequest` 与 `scenarioBuilders`：协议包硬编码 `doc.selection.review`、`loop_discussion`、`loop_task` 及 builder/version，桌面提交前调用此白名单校验。业务新增场景因此需要改 Runtime 协议，违反业务发起方拥有上下文内容的边界。建议场景构建和校验移至拥有业务的模块，Runtime 只处理已构造的 Context。
3. `ChannelContextSnapshotRef` / `contextSnapshot`：通用 InvokeInput 专门校验 scope_key、consumer_key、trigger_message_id、trigger_seq、serializer_version、主/恢复投影 hash 等渠道采集细节。当前本地生产链路只校验并转发该引用，没有据此恢复或准备输入。建议将渠道快照合同放回渠道包；通用执行只接收显式输入及 opaque 业务关联信息，不建立材料预取或自动恢复。

## 第二批收敛

- Context、ResolvedExecutionPlan 与 InvokeRequest 多次表达 Adapter、模型、工作区、审批、envs、MCP 等相同事实。准确说，Core 的 `prepareInvokeInput` 从 Context 调用 `resolveLocalContext`，得到内存中的 plan，再组装 InvokeRequest；调用方并不需要提交三份。桌面的 `prepareLocalAgentRun` 另行提取 Context 字段并构造 plan，交给 `prepareRunContext` 准备实际工作目录，再组装请求。应收敛的是重复字段和不同入口重复组装，不是删除所有内部参数计算。建议统一派生入口，并让资源准备函数只接收所需参数；完成消费者迁移前保留一致性和权限校验。
- ToolAuthorization / IssuedToolAuthorization 留在通用 Runtime schema，但本地执行不消费，桌面仍用于业务远程请求。建议把合同移到实际签发、验证和使用它的业务边界。不能因本地无消费者就全局删除授权或降低授权检查。

## 保留的边界

JSON-RPC 两层传输分别对应 SDK → daemon 和 daemon → Host 的不同进程边界；不能仅因都是转发就认定无用。原生响应与 canonical 响应分别服务不同输出模式。调用身份、源流序号、取消、交互期限、真实终态与有界窗口均有生产实现和故障用途。是否继续缩减字段，需要先证明相关恢复或错误隔离需求已经退出。

## 核对入口

- [执行计划校验](../../../packages/octo-runtime-protocol/src/context.ts)、[本地计划解析](../../../packages/octo-runtime-executor-core/src/context.ts)、[Host 执行接纳](../../../packages/octo-runtime-adapter-host/src/index.ts)。
- 旧场景白名单已删除，原定义可从删除前 Git 版本追溯；当前边界见[Context 扩展](../../rules/context-extensions.md)。
- [公共输入与渠道快照校验](../../../packages/octo-runtime-protocol/src/invoke-input.ts)、[内部请求准备](../../../packages/octo-runtime-executor-core/src/invoke-input.ts)。
- [多份输入一致性](../../../packages/octo-runtime-protocol/src/execution-plan.ts)、[协议 Schema](../../../packages/octo-runtime-protocol/schema/protocol.schema.json)。

## 场景和快照的真实用途

删除前，桌面 `docSelectionBuilder.ts` 构造文档评审场景和标准 Context，`useDocumentReview.ts` 发起预检和发送，`agent-conversation-service.ts` 在发送前调用 `assertScenarioRequest`。这说明旧白名单曾有业务调用，不属于 Runtime 执行所需条件。用户明确 Work App 为测试程序，本次不维护该旧依赖，直接从通用协议删除。统一执行入口处理构造好的 Context，不按业务场景执行分支。Channel Gateway Extra 作为业务接入层保留自身业务职责，不依赖此次删除的白名单。

“通用输入”指 SDK 的 `invoke(input)` 参数 `InvokeInput`，不是额外的业务协议。删除前，其 `contextSnapshot` 引用包含渠道采集游标、序列化版本和渲染 hash；Core 仅克隆进 InvokeRequest，没有据此恢复上下文或补取消息。它不是 RPC 的确认、重试或防丢机制，现已从通用合同及转发链路删除。业务自行保存材料并决定本轮提交内容。桌面自动化中同名的 `contextSnapshot: ContextEnvelope` 是业务配置保存，不属于此次删除。

本记录中的调用链为源码静态核对，不增加实机验收声明。已删除业务标签的验证范围见[实施记录](2026-10-15-remove-business-capability-contract.md)。

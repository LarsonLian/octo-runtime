---
type: Journal
title: 业务标签删除后的协议简化检查
description: 区分可删除的占位合同、应回归业务层的字段及仍有实际用途的执行协议。
tags: [architecture, protocol, review]
timestamp: 2026-10-15T00:00:00Z
---

# 检查范围

检查当前本地 Runtime 的协议定义和生产调用者，以及桌面消费边界。以下为后续收敛建议，尚未实施；不将占位、仅格式校验或单测当作端到端执行支持。

## 优先处理

1. 执行计划中的 `required_execution_features` 与 `provider_compatibility`：在当前 Runtime 源码中仅定义和校验，Core 不生成它们，Host 不使用它们执行要求匹配。它们没有形成可信执行保证。建议删除未消费字段；真实执行检查继续由审批、图片、MCP、输出模式等具体合同承担。不能将业务 capabilities 改名迁入此字段。
2. `ScenarioRequest` 与 `scenarioBuilders`：协议包硬编码 `doc.selection.review`、`loop_discussion`、`loop_task` 及 builder/version，桌面提交前调用此白名单校验。业务新增场景因此需要改 Runtime 协议，违反业务发起方拥有上下文内容的边界。建议场景构建和校验移至拥有业务的模块，Runtime 只处理已构造的 Context。
3. `ChannelContextSnapshotRef` / `contextSnapshot`：通用 InvokeInput 专门校验 scope_key、consumer_key、trigger_message_id、trigger_seq、serializer_version、主/恢复投影 hash 等渠道采集细节。当前本地生产链路只校验并转发该引用，没有据此恢复或准备输入。建议将渠道快照合同放回渠道包；通用执行只接收显式输入及 opaque 业务关联信息，不建立材料预取或自动恢复。

## 第二批收敛

- Context、ResolvedExecutionPlan 与 InvokeRequest 多次表达 Adapter、模型、工作区、审批、envs、MCP 等相同事实。内部派生执行参数有用，但不必让调用方维护多份权威合同。建议只在公共接纳边界冻结一次，然后在内部派生请求；完成消费者迁移前保留一致性和权限校验，不能直接删校验掩盖多源输入冲突。
- ToolAuthorization / IssuedToolAuthorization 留在通用 Runtime schema，但本地执行不消费，桌面仍用于业务远程请求。建议把合同移到实际签发、验证和使用它的业务边界。不能因本地无消费者就全局删除授权或降低授权检查。

## 保留的边界

JSON-RPC 两层传输分别对应 SDK → daemon 和 daemon → Host 的不同进程边界；不能仅因都是转发就认定无用。原生响应与 canonical 响应分别服务不同输出模式。调用身份、源流序号、取消、交互期限、真实终态与有界窗口均有生产实现和故障用途。是否继续缩减字段，需要先证明相关恢复或错误隔离需求已经退出。

## 核对入口

- [执行计划校验](../../../packages/octo-runtime-protocol/src/context.ts)、[本地计划解析](../../../packages/octo-runtime-core/src/context.ts)、[Host 执行接纳](../../../packages/octo-runtime-adapter-host/src/index.ts)。
- [场景白名单](../../../packages/octo-runtime-protocol/src/scenario.ts)。
- [公共输入与渠道快照校验](../../../packages/octo-runtime-protocol/src/invoke-input.ts)、[内部请求准备](../../../packages/octo-runtime-core/src/invoke-input.ts)。
- [多份输入一致性](../../../packages/octo-runtime-protocol/src/execution-plan.ts)、[协议 Schema](../../../packages/octo-runtime-protocol/schema/protocol.schema.json)。

本轮新增的是源码静态检查结论，不增加实机验收声明。已删除业务标签的验证范围见[实施记录](2026-10-15-remove-business-capability-contract.md)。

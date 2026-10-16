---
type: Task
title: DSH 独立 Adapter 接入整体评估
description: F28 遗留 P1 专项，在架构与内核稳定后评估 DSH 原生接入及统一执行合同，当前不实施。
tags: [adapter, dsh, architecture, assessment, backlog]
timestamp: 2026-10-16T00:00:00Z
---

# DSH 独立 Adapter 接入整体评估

## 状态与优先级

**遗留 TODO，P1，尚未开展整体评估，当前不实施。** 来源为 [F28 逐项评审](../gateway-august-feature-assessment/assessment.md#逐项-reviewf28-dsh-独立-adapter-遗留专项)。用户对旧 Gateway 接入方案有异议，要求按当前 Runtime 架构重新整体评估，不能沿用旧接法直接进入开发。

**P0 是整体架构与内核稳定性，优先于新增 DSH Adapter。** 本专项安排在系统稳定后的重要后续工作，不作为当前稳定性工作完成的前置条件；当前无实施排期，不安装 DSH、不修改默认 Adapter 集合、不启动技术原型或线上调试。

确定的是架构方向：未来采用独立的 **DSH Adapter**，通过当前 Adapter 公共接口接入。具体包名、Provider 启动方式、原生协议、支持范围和实施方案均待专项评估；本记录不意味着已经批准旧 SDK、某个版本或某套 DSH profile。

## 已知事实与待核实问题

旧仓有 `DshAdapter`、`DshSdkEngine` 及 `runtime=dsh` 的条件装配，锁定 `@deepseek-ai/dsh-sdk-client@0.1.0-rc.6`。其代码通过 SDK 启动 `dsh` 子进程；这只能证明旧仓存在接线，不能证明线上已使用、适配完整或适合当前架构。

2026-10-16 核对的[官方 SDK 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md)描述了通过 stdio JSON-RPC 驱动完整 DSH 运行进程的方式；[架构文档](https://deepseek-harness.github.io/deepseek-harness/en/reference/)区分 Web、SDK 等 profile。它们不等于已经证明“存在可直接嵌入的独立内核”，也不能替旧锁定版本提供运行证据。用户对“DSH 是否仅有 WebUI、可用外部执行边界是什么”的疑问保留为专项核实对象，不把质疑写成已证实无接口。

原 F28 可执行性 **50/100** 仅为未完成整体设计的历史初评，不表示实现完成一半，也不表示已有方案通过。后续须基于固定版本和真实证据重新评分；本轮实施必要性为 0、实施覆盖为 0%，与后续 P1 优先级分开。未来具体功能范围待评估，不承诺复制旧 Gateway 的 100% 功能。

## 整体评估范围

| 评估项 | 需要产出的结论 |
| --- | --- |
| 官方入口与版本 | 固定评估版本、来源、运行依赖及公开外部驱动合同；区分 WebUI、CLI、SDK、协议与可嵌入组件。选择有依据的入口，不从旧 engine 名称推导能力 |
| 执行与会话 | 明确输入接纳、输出事件、真实终态、新建/恢复会话和 reset 的映射；核实中断、未知结果、并发与共享进程的影响，不擅自替产品选择会话策略 |
| 取消与生命周期 | 核实能否按 Run 取消、是否只能关闭进程，以及其他会话是否受影响；评估 signal、清理、进程树回收和真实退出证据。不能靠宣称支持掩盖 Provider 限制 |
| Context 与执行配置 | 沿用 octo.context-envelope/v3，保留业务方对本轮内容、顺序和发送时机的决定权；执行配置按已有合同映射，不能拼进模型业务文本或由底层补历史背景 |
| 输出与交互 | 映射 CanonicalEvent 及真实错误；核实工具事件、审批、interaction.requested/respondInteraction 等合同实际可用范围，记录无法满足的行为，不通过 Channel 自定义解析补偿 |
| 身份、权限与环境 | 验证 Provider 配置、工具环境、凭据隔离、工作目录与原生权限的实际传递；不得把提示词当权限，不删除或重建现有身份、Home、profile 与会话数据 |
| 集成与安装 | Adapter 使用现有 SDK/AdapterHost 接口；HostApp 决定安装与启用，执行层只探测、校验及执行明确方案。Channel 只调用已注册 Adapter，不管理 DSH 内核或进程细节 |
| 验证与取舍 | 后续获准开展时，使用线上测试环境验证真实调用及取消/恢复/失败路径；区分源码、文档、模拟测试与实机证据，按限制形成接入、缩小范围或暂缓的结论 |

## 后续交付

- [ ] 固定 DSH 版本与原生接口证据，澄清 WebUI 与外部运行进程的边界。
- [ ] 输出与现行 Adapter 合同逐项对照、缺口及技术方案，不搬旧 Gateway 执行栈。
- [ ] 重新给出必要性、技术可执行性和明确范围的目标覆盖度，说明未满分原因及需要产品决定的取舍。
- [ ] 完成架构评审后再形成独立实施及验收计划；本专项的登记不授权实施。

现行依据：[Adapter 开发](../../guides/adapter-authoring.md)、[Adapter 责任](../../rules/adapter-metadata.md)、[统一 Context](../../rules/context-input.md)、[输出协议](../../rules/output-protocol.md)、[Runtime 安装归属](../../rules/runtime-lifecycle.md)。不得为 DSH 新增 Channel 特殊执行分支、Provider 专属内核依赖或已删除的 capability 注册体系。

---
type: Journal
title: 接入指南确定性错误复核
description: 对照当前源码修正公共调用示例、桌面发行配置和身份表述，记录静态验证范围。
tags: [documentation, integration, verification]
timestamp: 2026-10-15T00:00:00Z
---

# 范围与结果

用户再次明确责任边界：Runtime 只管理设备与 invoke；外部连接及业务状态由 Extra 自己处理。指南已移除把“远程连接管理”放进 RuntimeDevice 职责的标题与状态表，将 SDK 示例改为转发插件自定义状态，不在通用层解析 bots。IM 章节保留具体插件配置示例，不将其升级为 Runtime 合同。

本次只修正 [INTEGRATION.md](../../../INTEGRATION.md)，保留工作树已有的 Extra 接口调整，不修改 Runtime、App 或现有身份与配置。

- 公共示例直接构造 InvokeInput，使用 inputs、contexts 和 sessionId；AbortSignal 只通过 invoke 的第二参数传递。保留已准备 InvokeRequest 的转换说明，明确 invokeFrames 仍使用内部参数。
- 补充 CLI 插件安装前提、Electron distribution 的路径赋值和插件绝对入口，区分客户示例布局与 Work App 实际布局。
- 明确 SDK API 位于宿主进程，daemon 和 AdapterHost 位于子进程；设备虚拟身份决策与当前 subject/tenant profile 实现分别说明。
- 核实 doctor 的真实检查项，不将其作为 Provider 认证或 Bot 在线证据；保留 Worker 归档说明，不恢复归档接入步骤。插件加载与逐 Bot 连接使用不同状态查询。

历史 [插件接入任务](../../tasks/plugin-sdk-app-integration/brief.md) 与 [当时验证记录](2026-10-15-plugin-sdk-app-integration.md) 中的 configureExtra/requestExtra、增量更新和“新决策尚未实施”描述已不适合作为当前接口说明。当前接口见 [Extra 合同](../../rules/extras.md)，历史测试不证明后续接口已通过验收。

# 验证边界

INTEGRATION.md 的全部 TypeScript 代码块按 Node 与 Electron 两套初始化组合，使用 TypeScript strict/NodeNext、已安装的 Node 24 类型与 SDK 导出声明检查，均为 0 个诊断；Electron 组合仅为 resourcesPath 补充类型声明。知识库 lint 和本地文件链接检查通过，git diff --check 通过。

本轮未修改 UI、接口或协议，未运行真实 App、Provider 或 im-test 调试，也未构建桌面安装包。静态检查不作为“App 现有功能保留”或 Bot 成功连接的运行验收证据。

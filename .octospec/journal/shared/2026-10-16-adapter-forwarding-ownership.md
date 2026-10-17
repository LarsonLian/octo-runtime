---
type: Journal
title: 宿主管理 Adapter 支持范围与撤回 executionFeatures 机制
description: 记录 Adapter 适配转发的责任决定、自建能力标签的过度设计问题及待实施范围。
tags: [architecture, adapter, ownership]
timestamp: 2026-10-16T00:00:00Z
---

# 决定与理由

用户确认 CLI、desktop 及其他 SDK 宿主知道自己选择、交付的 Adapter 和版本，功能选择与展示归宿主管理。Adapter 负责将明确输入适配转发给 Provider，返回实际事件和结果。Runtime 不需要额外建立一套“Adapter 支持哪些功能”的标签机制。

`executionFeatures` 是自建字符串数组，不是 Provider 强制要求的协议。Git 最早引入点为 `89445f8`（2026-10-09，“统一 Agent 来源与执行能力并接入 OpenClaw 现有 Agent”）；Git 作者字段不能证明实际由哪个编码 Agent 编写。此前 `b0200b4` 只删除业务 capabilities/react、required_capabilities 和 ExecutionTarget，保留了这套执行特性标签。不能把两项清理混为一谈。

已接受的决定为删除 `executionFeatures` 机制。静态声明与实现重复维护，标签也不能证明实际可执行；不得将它改成另一份布尔字段表、能力 struct 或注册中心继续维持。

## 责任与保留边界

- 宿主管理 Adapter 集合、版本、功能使用及选项展示。Runtime 按宿主明确选择调用，不额外做功能标签发现、匹配、准入或自动改选。
- Adapter 的“透传”保持业务语义，仍执行必要的参数映射、原生协议编码、事件转换、交互响应和取消。对应 Adapter 对不支持输入返回具体错误或合同已约定的未应用结果，不静默丢参或放宽权限。
- 安装、登录及连接可用性属于当前运行状态，仅在必要边界检查。Provider 缺失由执行层报告，HostApp 决定安装；不为标签探测额外扫描用户 Home 或启动 Provider。
- Codex / ACP / MCP 的原生握手只按实际通信需要在 Adapter 内处理，不投影为 Runtime 统一能力目录。诸如 `tool.computer_use` 的探测与展示，不能仅因名称关联 Provider 就视为必要握手。
- Run=7、Context=v3 及原生协议版本保持各自合同。本次决定不授权删除或重置 Home、身份、profile、配置和运行状态。

## 当前事实与后续清理

本轮仅更新 OKF 规则、开发指南及入口，没有修改产品代码。现有 `AdapterMetadata.executionFeatures`、协议常量、Adapter 静态标签、Host 发现结果及标签驱动检查仍在。已确认的架构决定不能写成代码删除已完成。

后续实施应盘点各标签的实际消费者，删除声明和投影，将图片、审批、交互响应及活动进度等现有消费者逐项落实到具体执行合同。没有执行消费者的标签及其专用探测直接清理；不能复制为另一套声明表，也不能通过删除检查接受不合法请求。其他元数据字段是否调整需按实际消费和合同另行判断。

实施验收须同时验证：公共类型、发现结果和调用链不再依赖 `executionFeatures`；有效请求、明确不支持的请求、审批往返、取消和超时仍返回真实结果。按受影响模块执行构建、类型检查及回归；涉及桌面/真实接口时重启相应进程并连接 im-test 验证，不能把本次文档检查当作执行验收。

## 本轮文档核对

已读取规则索引、基础架构、Adapter 元数据规则、开发验证规则、中文协作规则及 Adapter 开发指南。规则正文分别回写[基础架构](../../rules/architecture.md)和[Adapter 责任边界](../../rules/adapter-metadata.md)，开发指南保留当前接口示例并明确其待清理状态。仅检查 OKF 格式、索引、本地链接和 diff；未执行线上调试或运行行为验收。

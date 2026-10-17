---
type: Task
title: 群聊明确点名无响应事故分析与处理计划
description: CLI 与 SDK 共用准入错误的根因、影响、止损、修复、发布和验收。
tags: [channel, identity, testing]
timestamp: 2026-10-17T00:00:00Z
---

# 群聊明确点名无响应事故

状态：**本地修复、合同对齐及 im-test 的 CLI/SDK 实时链路已验证，发行安装随后执行；第三方宿主尚未升级，事故不宣称全部恢复。** 用户已授权不做兼容、更新整体设计、实施、提交推送及安装到本机；不删除或初始化现有 Home、身份和配置。详细历史证据见[事故分析](analysis.md)，执行与关闭条件见[处理计划](plan.md)，本轮证据见[实施记录](../../journal/shared/2026-10-17-channel-group-admission-delivery.md)。

暂按 P1 功能事故管理：默认示例配置下，群/话题入口系统性不可用，私聊仍可用。此级别为本地排障优先级建议，不代替组织的正式事故定级；影响用户数、首次发生时间与全部部署范围尚未统计。

## 问题与目标

用户报告私聊正常、群聊明确 @Bot 无回复。修复前入站 acceptsImMessage 将 `!config.group_ids?.includes(...)` 作为拒绝条件，导致省略 group_ids 时拒绝所有群/话题。CLI 默认示例和本机 Bot 配置均省略该字段，与省略不限制群范围的说明矛盾。

由 Channel 分别表达启停和范围：groups_enabled 省略或 true 启用群/话题，false 关闭群/话题；group_ids 省略、null 或 [] 均不增加群范围限制，非空数组只允许列出的父群。二者均不影响私聊；话题使用父群校验，接收和回复保留原话题地址。不保留旧空数组拒绝群的语义或迁移分支；希望禁用群的配置必须明确使用 groups_enabled: false。groups_enabled 的 null 和非布尔值非法。

发送者默认仍只允许服务端认证所得 owner，显式 allowed_sender_ids 替代默认名单；自身、错误 Space、无真实 mention、未知类型和非法消息继续拒绝。Schema/README 中“省略发送者名单不限制”的错误说明同步改为 owner 默认。群成员关系和真实投递由 IM 服务端校验，Context、模型权限和 Provider 不参与此准入决策。

## 范围与验收

修改 Gateway 入站判断、针对性准入/transport 测试及说明；不修改 Host、Provider、SDK 接口或协议版本，不新增免 @ 或正文猜测。构造回归覆盖省略/空/命中/不命中群范围、群与话题、私聊和独立授权拒绝，并确认真实 transport 能转交任务和原频道回复。

业务目标是让已授权用户在 Bot 可访问的群/话题明确点名后获得正常回复，同时能独立表达关闭入口和限制范围。宿主拥有配置决定权，明确传入开关、范围和发送者授权；Channel 执行合同内检查，向共享内核提交已接纳任务。越界动作包括宿主接管插件内部鉴权、Host 补造 mention、放开所有发送者或重建 Home。变更只作用于加载 Gateway 的产品，不改变其他 Extra、普通 SDK invoke 或 Provider 的执行权限。

真实调试仅连接 im-test：只读历史重放已验证新合同，另使用既有隔离 QA 群和话题，分别通过 CLI 和 SDK 默认装配完成真实 WS → 独立 AdapterHost → 原频道回复。发送者为明确授权的 QA Bot，owner 默认由自动化 transport 测试验证；确定性测试 Adapter 不调用模型，不能冒充实际模型或第三方 App 产品验收。构建、类型/lint、1074 项 Node 通过（9 跳过）及 35 项 UI 测试通过。第三方 App 自带 SDK 副本需由对应宿主更新并重启，全局 npm 安装不会更新该副本。

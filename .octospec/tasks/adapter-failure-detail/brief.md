---
type: Task
title: 统一展示 Adapter 执行失败原始原因
description: 保留 CanonicalEvent 错误，经统一链路展示到失败卡片，并纠正 cwd ENOENT 的误导。
tags: [adapter, channel, testing]
timestamp: 2026-10-15T05:00:00Z
---

# 目标

所有 Adapter 共用 run.failed，卡片统一展示执行失败及 Adapter 返回的具体原因。不为各 Provider 新建一组业务错误码，不用 catalog 摘要覆盖 CanonicalEvent 的 message/error。Codex 和 Claude Code 的原生错误细节均需保留。

# 实现边界

- Host 追加既有 failure 分类，保留已脱敏的原始 payload；执行状态整理不再裁剪失败事件。
- 对 ENOENT/ENOTDIR/EACCES/EPERM 核查实际工作目录，补充存在性、目录类型和进入权限的证据，避免错误指引安装 CLI。
- 卡片原因优先于错误码，诊断信息置于详情；长原因遵循现有卡片预算，文本回复提供更多信息。
- 凭据不进入公开事件或卡片。保留现有 Home、profile、配置和 Runtime 身份，不发送测试聊天消息。
- 不修改 Run、Context、FailureEnvelope 或 HostFrame 的 wire schema 和版本。

# 验收

覆盖 Codex/Claude Code 的真实 spawn 失败、Provider canonical 错误透传、自定义 Adapter、长卡片合同、凭据脱敏及全量回归。线上 im-test 读取真实卡片能力，再用真实 Codex 启动失败构造卡片，不调用模型或发送消息。

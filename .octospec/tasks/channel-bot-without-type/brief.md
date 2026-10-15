---
type: Task
title: 移除渠道 Bot 的重复 type
description: 独立 Extra 包决定平台，Bot 配置不再要求 type。
tags: [extra, channel]
timestamp: 2026-10-15T00:00:00Z
---

移除 Octo、WeCom Bot 合同和校验中的平台 type，平台元数据由包自身确定。同步桌面配置生成与分发、样例和测试，保留 adapter_type 及稳定身份计算。

验收：无 type 的两类配置可加载；桌面按目标 Extra 分发；运行构建、类型检查、相关测试，并通过 CDP 在 im-test 验证认证错误、更新和清理。不得重置既有 Home 或身份。

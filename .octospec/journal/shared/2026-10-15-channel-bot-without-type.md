---
type: Journal
title: 渠道 Bot 移除 type 验证
description: 独立渠道配置与桌面分发的自动化及线上测试环境验证。
tags: [extra, channel, testing]
timestamp: 2026-10-15T00:00:00Z
---

Octo、WeCom Bot 不再声明或依赖渠道 type。平台状态与执行元数据由各包固定输出；adapter_type 继续选择引擎。桌面端根据自身构造的 api_url 字段分发至对应 Extra，身份哈希沿用既有平台、地址和 Bot ID。

验证通过：Runtime workspace build、tsc、eslint；渠道相关 Node 测试 46 项；Work App tsc、build:test 和相关 Vitest 24 项。

重启 Work App 后运行 scripts/verify-extra-plugins-live.mjs，通过 CDP 连接真实 renderer 和 https://im-test.deepminer.com.cn。使用无效测试凭据确认认证错误可见、更新保留 Host 进程、停用和删除成功、既有通道保留，renderer exception 数为 0。未发送真实消息，未验证模型回复。应用其他后台 Agent Access 请求返回 502，不属于本次渠道验证通过范围。

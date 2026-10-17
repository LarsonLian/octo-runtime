---
type: Task
title: CLI Extra 启动诊断
description: 定位 channel-gateway 未上线并补齐前台启动日志和业务状态入口。
tags: [extra, lifecycle, testing]
timestamp: 2026-10-15T04:00:00Z
---

# 目标与范围

确认 extraset 与 daemon run 使用同一配置来源，输出发现和加载结果，允许查询插件业务连接状态。保留现有 Home、身份、profile、配置和进程。Run=7、Context=v3 不变。

# 验收

- 通过完整 CLI 进程验证保存、自动加载、重启、缺包隔离和日志不含凭据。
- build、类型检查、lint 和相关测试通过；全量测试检查跨包影响。
- 连接 im-test 验证真实鉴权失败可查询，不发送消息或调用真实模型。

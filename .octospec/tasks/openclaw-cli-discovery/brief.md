---
type: Task
title: OpenClaw CLI 自动发现与 SDK 显式连接
description: 将发现和首次保存移出执行层，统一连接校验与执行路径。
tags: [openclaw, adapter, lifecycle]
timestamp: 2026-10-15T00:00:00Z
---

# 目标与合同

CLI 启动编排负责读取 OpenClaw 配置、解析 WS URL/token、保存 Runtime 连接及设备身份并执行认证探测。保留 CLI 发现来源，每次 CLI daemon 启动重新读取，重启即可跟随端口和 token 轮换。显式 Gateway 不回退自动发现。SDK 由宿主传入 URL/token 与设备身份，或显式初始化 Runtime 连接；执行层不读取环境变量或 OpenClaw 配置，不首次落盘。

CLI 与 SDK 共用连接格式、URL 校验、认证 probe 和执行路径。Provider 缺失或认证失败不阻止其他 Provider；发现刷新失败时不可继续使用旧快照。不得修改 OpenClaw 原配置。Run=7、Context=v3 不变。不改动工作树已有 Extra 变更。

# 验收

覆盖每次 CLI 初始化刷新、显式来源优先、SDK 无隐式发现、probe/invoke 无写入、设备身份稳定和 CLI/SDK 同连接执行。运行类型、lint、跨包测试及 OKF lint。真实调试使用 im-test，区分服务可达与实际 OpenClaw 认证执行证据，不输出凭据。

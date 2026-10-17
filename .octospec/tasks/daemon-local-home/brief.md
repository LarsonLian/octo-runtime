---
type: Task
title: 移除 CLI 登录前置条件
description: 按设备本地存在的合同移除 login，让 daemon 安装和运行准备缺失默认配置。
tags: [runtime, lifecycle, installation]
timestamp: 2026-10-15T00:00:00Z
---

用户明确要求直接删除 login，不保留兼容入口。登录、登记和共享属于可选 Extra，不决定设备是否存在。

本次删除 CLI login 及其旧更新分支，daemon install/run 共用已有 Home 解析并在 setup lock 内创建缺失配置和 machine identity。已有配置、身份、凭据、profile 和运行状态不删除或重置。显式 OpenClaw 连接同步去除本地登录前置条件；Run 7 与 Context v3 不变。

验收覆盖默认与显式 Home、空目录安装/运行、重复执行保留已有配置和身份、非法配置报错，以及 login 命令已移除。真实服务与前台进程验证使用独立测试目录，不改动既有服务定义。外部接口若调试则使用 im-test；本次修复不需要云端认证。

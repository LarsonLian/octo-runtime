---
type: Task
title: daemon start 自动安装缺失服务
description: extraset 后直接后台启动，保留已安装服务及现有身份配置。
tags: [runtime, lifecycle, installation]
timestamp: 2026-10-15T00:00:00Z
---

# 目标与范围

用户配置 Extra 后直接运行 `octo-runtime daemon start`。CLI 在 Home 安装锁内检查原生用户服务，仅缺失时复用安装流程、启用自启，再启动服务并等待本地 IPC 就绪。已有服务保持原启动行为；安装或 manager 不可用时返回真实错误，不回退前台或 detached 进程。

不变更协议、不安装 Provider，不删除或重置既有 Home、machine identity、profile 与 Extra 配置。手动 `install` 保留定义修复职责。

# 验收

- 缺失服务按 probe、install、enable、start 执行，最终只输出一次 start 结果。
- 已安装服务不调用安装和 enable；禁用状态、探测和安装错误真实上报。
- extraset 内容、已有本地配置与 machine identity 保持原样。
- 构建、类型、lint、相关测试，以及真实原生服务启动和线上测试环境验证分别记录结果。

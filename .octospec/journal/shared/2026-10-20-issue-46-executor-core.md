---
type: Journal
title: Issue 46 ExecutorCore 本机交付
description: 收敛唯一执行实现，保留独立 worker，完成本机与离线产物验证；跨平台和新 Kernel 联验待完成。
tags: [executor, delivery, testing]
timestamp: 2026-10-20T00:00:00Z
---

# Issue 46 ExecutorCore

分支 `refactor/46-executor-core`，基线 `7fb81e9`，代码未提交。
AgentExecutor 与显式输入准备迁入 executor-core，旧 core 包删除；adapter-host 暂留传输与真实 worker，
旧 AdapterHost 是同一类的别名。主发行物公开 `/executor-core`，不独立发布内部包。

首帧前的接纳/取消、shutdown 门禁及可重试的不完整清理均已实施。direct 共享进程故障域，
隔离 worker 保留 NDJSON；没有业务历史补齐、Provider 隐式安装或请求自动重放。

macOS arm64 / Node 24.19.0：构建/类型、lint、命名、格式通过；Node 1264 通过、10 跳过、0 失败，
UI 35 通过。仓库外离线 tgz 类型与 direct 执行/交互/取消/关闭通过；旧 CLI/Extra 与 Home 保留检查通过。
知识校验仍有 14 处既有跨仓库链接问题。

Windows 专项已接入 CI，尚未取得原生证据。新 Kernel、共同 source-lost fixture、实际 SDK/IM 及真实 Provider
联验仍属后续进入条件，不能据此关闭 #46；没有 commit、push、PR 或发布。

完整消费清单、R3 映射与命令结果见 [实施记录](../../tasks/issue-46-executor-core/implementation.md)。

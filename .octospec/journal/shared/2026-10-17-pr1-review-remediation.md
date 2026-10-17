---
type: Journal
title: PR 1 逐项评审整改与本地验证
description: 记录两位 reviewer 的决策实施、同类生命周期修复及 Node 24 完整检查结果。
tags: [review, lifecycle, testing, documentation]
timestamp: 2026-10-17T00:00:00Z
---

# 交付

按用户授权分别修复和本地提交，每项 commit 正文标明 reviewer、编号、决策及验证。yujiawei 的 R01/R02 通过删除无消费者的群资料/上传 API 处理，保留图片解析；R03 以系统账号为本地信任边界，仅补架构与接入说明；R04 以 Node 24 检查证据回应。

Jerry-Xin 的 R05/R06 分别修复 ACP 传输错误逃逸和 leader 退出后的受管组残留。S01–S05 是据此开展的同类检查，并非 reviewer 直接提出的五条意见；已覆盖 Codex 管道错误、Host 启动失败、Host/ZCode 组清理以及 ACP/ZCode 有界接收缓冲。正常退出保留已接纳终态，实际超限才清空积压并失败。

可复用合同已回写[本地执行](../../rules/local-execution.md#本次执行资源的错误隔离与回收)与[有界状态](../../rules/stateless-execution.md#provider-接收缓冲)。具体上限、清理预算、原始缺陷及平台边界见[实施记录](../../tasks/pr1-yujiawei-review/implementation.md)。

## 验证

macOS / Node v24.19.0：全量类型构建通过，Lint、命名、格式检查通过；Node 完整测试 1104 通过、9 跳过、0 失败，既有 UI 测试 35 通过。最终 cause 元数据补充另通过 Host 启动/装配回归。OKF 和补丁格式检查通过。

测试使用假 Provider、真实 OS 管道和隔离的受管进程组，没有调用真实模型或 im-test 业务 API；没有改变既有 Runtime 身份、Home、配置或用户进程。macOS 已确认父进程先退出、后代忽略 TERM、重复关闭、短暂和持续 EPERM 的行为。新提交尚未推送，远端 CI 与 Windows 实机结果不记为已通过；Windows 已有实现，用户计划后续真机测试；后续澄清明确平台必须支持，疑点及 CI 缺口见[Windows 验收](../../tasks/pr1-yujiawei-review/windows-validation.md)，不以缺少验证降低产品要求。

本轮没有待用户选择的产品方案。已本地提交，未推送、未发送 GitHub 评审回复、未合并。

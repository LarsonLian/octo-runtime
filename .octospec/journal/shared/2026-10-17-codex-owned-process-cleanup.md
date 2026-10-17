---
type: Journal
title: Jerry-Xin R06b Codex 独立关闭流程整改
description: 补齐 leader 先退后的工具回收、取消暂停消费与双失败原因，并记录本地回归。
tags: [review, lifecycle, codex, testing]
timestamp: 2026-10-17T00:00:00Z
---

# 问题与修复

Jerry-Xin 在 55e977f 上复现 Codex 取消及正常完成后工具仍持续执行。此前 S01 只修了 Codex 管道错误隔离；Codex 独立 close 的 leader-exit 提前返回遗漏了 R06 受管组回收。详见[第二轮评审](../../tasks/pr1-yujiawei-review/second-review.md)。

本次使用已有 process-cleanup，保留 EOF 机会，但始终确认本次拥有的组已消失；close 和进程回收分别共享同一次 Promise。取消后的消费者即使暂停读取，仍启动有界清理。默认关闭预算为 EOF 250 ms + TERM 400 ms + KILL 确认 200 ms；较短 Host 预算不扩大。只有生产 spawn 显式创建的独立组才能按组回收。

保留 canonical/native 的正常终态和原始错误。执行及清理双失败使用 AggregateError 保存两者，spec.cleanup 在 finally 释放调用方资源。合同已回写[本地执行](../../rules/local-execution.md#本次执行资源的错误隔离与回收)。

# 验证

Node 24 / macOS：修复前新增的 canonical/native 取消和完成 4 项回归全部因后代存活失败；修复后新增 10 项通过，覆盖 EOF、取消暂停消费、双失败原因，相关专项共 50 项通过。fixture 使用生产 defaultSpawn、真实 OS 管道与同组独立 stdio 的后代；无真实模型或业务 API 调用。

完整 pnpm typecheck、lint、lint:names、format:check 通过；完整 Node 测试 1114 通过、9 跳过、0 失败，UI 35 通过。随后仅将清理错误合并整理为独立函数以满足 no-unsafe-finally，重建受影响包并重跑根类型、静态检查与相关专项。OKF 与补丁检查作为提交前门禁。

Windows 已有实现，本次 POSIX 进程组回归不代替 Windows 真机验收；继续按用户计划和 [issue 2](https://github.com/Mininglamp-OSS/octo-runtime/issues/2) 跟踪，不降低平台支持要求。本次按用户授权单独 commit，未推送、未合并；R07 的公司规范回应已经独立发表，不改 workflow。

---
type: Task
title: Issue 57 第二轮整体复审
description: Standards 与 Spec 独立审查的发现、修复和回归范围。
tags: [channel, session, extra, review]
timestamp: 2026-10-20T00:00:00Z
---

# 基线与方法

基线为 `HEAD=6fb8ca5`，审查 `git diff HEAD` 及新增未跟踪文件，不把已提交 diff 为空误认为本次没有改动。依照 code-review 技能，Standards 与 Spec 由独立 Agent 并行只读审查，再按用户授权修复。第二轮用户继续明确禁止提交、推送。

依据：[任务简报](brief.md)、architecture/extras/session-reset/stateless-execution/engineering/channel-integration/local-execution/runtime-lifecycle 规则。重点是宿主存储隔离、所有权、关闭收尾和故障传播；不以已有测试通过代替调用链分析。

# Standards

独立审查发现 4 项 P1，均已修复：

1. **SDK 提前切断 IPC。** LocalExtras 将 owner signal 直接传递给源流，abort 立即销毁 socket，导致 Gateway 收不到尾 binding。现在停止接纳、取消原调用及强制 detach 分开；ACK 即建立取消所有权，严格核对原 run/invocation/session/generation/protocol/stream；真实终态前保持流最多 5 秒。不得用 cancel ACK、消费者提前退出或订阅断开冒充完成。
2. **正常关闭误报未知结果并继续展示。** Runtime 关闭时跳过全部事件，projector 无终态后进入未知结果分支，再次 cancel、update/finish presentation。现在内部记录真实终态，停止展示、交互和 finish，不为正常 draining 重发取消。
3. **挂起初始化没有启动撤权期限。** loader 等 initializer 后才调用 disposer，Manager 未监听 owner abort。现在 owner abort 立即启动 Manager 清理，即使初始化不退出也能在期限撤权，失败保持阻止替换。
4. **draining 存储失败被吞后仍报告卸载成功。** Runtime 的业务诊断捕获 save/remember/patchGap 异常，尾任务却正常 resolve。现在租约记录 draining 失败，仍尝试释放句柄，但 cleanup 持续失败，不允许重载掩盖绑定丢失。

隔离核查：既有 key 包含连接/API/Bot 身份、Adapter、聊天类型及 conversation；工厂使用独立 Bot 配置副本，宿主 scope 保留；直接 sessions 仍借用，不随任一 Bot 关闭。未发现确定的跨 Bot、组织、助理或账号串用缺陷。宿主数据库自身的 scope 实现仍由宿主负责，Runtime 不猜测入站路由来替代授权。

# Spec

独立审查发现 1 项 P1、1 项 P2，均已修复：

1. **P1：关闭后 presentation 及重复取消。** 与 Standards 第 2 项重叠，违反 brief 的停止展示/交互/最终投递要求。新增 presentation 调用次数、取消次数及无未知结果误报断言。
2. **P2：无效 async 工厂拒绝逃逸。** 工厂返回 rejected Promise 时只报告接口无效，没有拒绝处理器，可能使宿主进程退出；resolved Promise 的迟到句柄也未释放。现在仍拒绝 Promise/thenable，不接纳为合法工厂，同时消费拒绝并有界等待迟到句柄回收，失败不伪装释放成功。strict 子进程回归证明错误 Bot 被隔离，其他 Bot 可正常运行。

# 修复中补充核查

- agent_run.get 带 oldest_seq/latest_seq 窗口字段，不能直接对完整对象使用严格 receipt 校验；先提取七字段，再验证并核对原 stream。fake IPC 回归也携带窗口字段，实际 native SDK 取消保持通过。
- 保存停止瞬间的 finished Promise，避免后登记的 Gateway disposer 先耗尽 owned 集合后丢失早前断流失败。
- 只有真实 Host terminal 才证明 drain 完成；owner abort 后消费者提前 break 仍报告失败。
- 取消已由 LocalExtras 管理时，强制 detach 不隐式重发第二次取消；ACK 丢失尚未确认接纳时，仍保留 invokeDaemonRun 原有身份核对后取消路径。
- 不修改公共 InvokeEnvironment、wire schema 或通用 invoke abort 语义；内部源流 lifecycle 钩子仅用于 SDK Extra 收尾。

# 验证与剩余边界

新增真实 Gateway + 工厂 + LocalExtras + JSON-RPC socket 联合回归，证明取消后尾 binding 先写入再关闭句柄；覆盖 ACK 无首帧、ACK 丢失、run/stream 冲突、取消失败、提前停止消费、断流及超时。另覆盖 draining 三类存储失败、初始化挂起撤权和 strict Promise 工厂子进程。最终全仓结果见[交付记录](../../journal/shared/2026-10-20-channel-host-session-store.md)。

Standards：4 项，最高 P1，均修复；Spec：2 项，最高 P1，均修复（1 项与 Standards 重叠）。本轮没有保留未修复的已确认问题；不对本人所写代码出具独立 approve。真实 IM/Provider、Windows 真机和第三方宿主联验仍待进行。

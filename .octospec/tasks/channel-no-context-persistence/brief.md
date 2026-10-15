---
type: Task
title: Channel 不持久化上下文的决策专项
description: 只保留有界在途状态，不引入本地 Context、历史、binding 或投递账本持久化。
tags: [channel, storage, stateless, context, session]
timestamp: 2026-10-15T00:00:00Z
---

# Channel 不持久化上下文的决策专项

## 已确认决策

2026-10-15 用户明确：绝对不持久化上下文；不在 Adapter 存业务状态，只要在途内存有界。撤回本轮助手提出的“为了跨重启续接新增 binding 持久化”和“迁入旧项目执行隔离/投递账本”的建议。需要背景时由 Channel 从 Octo 获取并显式构造 Context，见[新会话历史专项](../channel-new-session-history/brief.md)。

本次延续现有有界内存 Store，仅增加随 binding 生命周期释放的一次初始化标记，没有新增存储实现或数据库，也不授权删除现有用户数据或 Provider 原生历史。代码核对与自动化结果见[交付验收记录](../../journal/shared/2026-10-16-channel-features-delivery.md)。

## 责任与允许范围

- Channel 可以在内存维护业务 session 到 Provider binding 的映射、代次、排队、当前 Context 和短期消息/投递去重；所有容器按数量、字节、TTL 或在途生命周期限制，超限行为必须明确。
- Adapter 可以保留单次执行、连接、交互和资源清理所必需的有界状态；不得建立 IM 历史、Context 或业务 binding 持久库。无状态不等于执行过程中禁止持有状态。
- Host 的有界源流窗口不是数据库。不得以日志、JSON 归档、无限 Map、诊断文件或重试快照代替被禁止的上下文持久化。
- 不新增聊天正文、Context、输入图片、执行快照、Provider binding 或投递账本的本地持久化。配置、受保护凭据、设备/Runtime 身份及既有进程清理文件仍遵循现行合同；不得借本决策重置这些文件。
- Octo 服务端聊天历史及 Provider 自身的原生会话文件继续由各自系统管理。本决策约束 Channel/Runtime 不额外复制持久化，不禁止 Provider 必需的原生存储，也不承诺删除原生历史。

## 决策依据与代价评估

采用此方案可避免维护两套业务历史与恢复账本，并保持 Channel 采集、Host 执行、Provider 管理原生会话的边界。现有[内存 Store](../../../packages/octo-runtime-extra-channel-gateway/src/application/session-store.ts) 已按数量、字节和期限约束，是延续基础，不是必须重建的新抽象。

代价是重启或淘汰后无法保证原 Provider thread 续接，也不提供跨重启的消息恰好一次执行、投递恢复或 reset 边界保存。频道最近 15 条只能恢复可见聊天背景，不能代替隐藏工具轨迹或外部副作用核查。这些是方案的实际边界，不据此重新引入持久库。

## 检查与后续验收

本轮检查既有 Store 容量、过期、关闭与一万个会话调度测试，并将图片限制为每条 2 MiB、历史限制为 1500 字符，沿用每 Bot 64 条在途队列及 occurrence 字节上限。初始化标记复用 binding，不另建无限 Map；图片下载不落本地文件。字节限额不是进程 RSS 承诺。后续仍须关注副本和队列开销；重启、过期和卸载后真实报告新会话。依照[状态合同](../../rules/stateless-execution.md)与[会话合同](../../rules/session-reset.md)验收，不清理用户既有文件。

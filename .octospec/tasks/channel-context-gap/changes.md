---
type: Plan
title: Issue 32 固定API准备改动拆分
description: 从位置输入到模型前API读取、快照交接与验收的逐文件改动。
tags: [channel, context, implementation, planning]
timestamp: 2026-10-19T00:00:00Z
---

# 改动清单

下列源码均位于`packages/octo-runtime-extra-channel-gateway/src/`，不改Host、Adapter、WeCom或公共wire协议。

| 编号 | 文件 | 改动与验收 |
| --- | --- | --- |
| CG-01 | `contracts.ts` | 入站位置、metadata观察和原turn token；Context准备接收计划并回传API结果；所有扩展保持可选 |
| CG-02 | `transport/wukong.ts` | 区分客户端seq和服务端message_seq，传递SENDACK及自身RECV位置；不把自身输出再次执行 |
| CG-03 | `transport/normalize.ts` | 观察scope与执行准入分离，保持Bot/Space/群/完整话题地址校验 |
| CG-04 | `transport/channel.ts` | 连接metadata观察、原发送/卡片token与现有Context构造，不扩大到父群或其他sender执行 |
| CG-05 | `application/session-store.ts` | 有界binding内可选同步原子patch；校验代次，计入字节预算，不续TTL、不分配新条目 |
| CG-06 | `application/im-channel.ts` | 接收冻结U、准备时读L；取消API准备；第一次交接提交材料事实，失败保留待补下界 |
| CG-07 | 同上 | 同代次重试复用occurrence冻结输入/Context；fresh_fallback只重建下一新输入的最多15条窗口 |
| CG-08 | `application/context-gap.ts` | 纯位置计划与API结果状态；共享15条上限，删除CLI argv和advertised/unverified“工具读取债务” |
| CG-09 | `transport/contexts.ts` | 冷/续聊统一一次API读取，10秒、最多15条/1500码点；过滤去重、文本Context、失败和预算降级 |
| CG-10 | `execution/dispatcher.ts` | 执行默认项合并后优先省略自动历史、压缩状态；正文移除必须将materialProvided改false，不重取 |
| CG-11 | `transport/api/conversations.ts` | 保留数组读取合同，内部带more元数据；可选retryOn429供固定准备禁用重试，仍使用真实Bot API鉴权 |
| CG-12 | 测试、规则和指南 | 定向与全仓回归；架构区分固定API准备和模型工具调用，SDK/CLI文档不再要求模型补缺口 |

# 里程碑与门槛

- M0：本地源码和WS fixture可继续实施；部署scope、序号域、端点、more与自身输出语义仍须受控im-test证明。
- M1：位置及有界元数据，不因普通讨论启动任何任务。
- M2：纯策略14/15/16条、最大u32和未知基线边界。
- M3：固定API先于模型，失败、取消、限流和预算回归；不依赖模型工具选择。
- M4：部署API与真实Provider消费已提供Context的验收，不能用fake替代。
- M5：2026-10-19已获交付授权，本轮执行rebase最新main、独立双轴评审及修复、英文Draft PR关联`Closes #32`；等待部署门槛、CI与批准，不自动合并或发版。

---
type: Task
title: 群与话题续聊的上下文缺口感知
description: Issue 32 的模型前固定API历史准备、实现范围与真实验收门槛。
tags: [channel, context, history, session, implementation]
timestamp: 2026-10-19T00:00:00Z
---

# 状态与基线

- Issue：Mininglamp-OSS/octo-runtime#32，`Channel Gateway misses intervening group/thread discussion in resumed sessions`。
- 已fetch的main基线：`65728c17ec33a6a68f255f70678f76b52ad68ac6`；分支`plan/channel-context-gap`，worktree `octo-runtime-plan-channel-context-gap`。
- 2026-10-19用户纠正：模型工具调用使用octo-cli；模型前固定输入准备直接调用现有TypeScript API层。本文及配套Spec替代最初“仅提示模型自行补历史”的方案，旧journal保留为历史记录。
- 本地已实施并完成确定性回归；2026-10-19用户进一步授权刷新OctoSpec、code review并提交英文PR到main，关联Issue #32。不自动合并或发版，不调用真实模型或生产消息；部署合同与真实Provider仍待验，证据见[实施记录](implementation.md)。

# 目标与归属

1. Provider session稳定不能证明模型看过未 @ 的讨论；后续任务应在模型执行前取得允许范围内的近期背景，而不是编造中间结论。
2. ChannelGateway是此业务Event的发起方，负责固定输入准备；直接调用`transport/api/conversations.ts`的消息同步API，不把这个步骤委托给模型、不启动CLI子进程、不做关键词分类。
3. 模型在工具循环中处理额外业务调查、文档读取、跨会话发送及文件交付，仍使用宿主提供的octo-cli。固定Context准备与模型业务执行不是同一职责。
4. 仅扩展Octo群/话题（type 2/5）续聊；DM保留原冷启动策略。Host、Adapter、WeCom、其他Extra和通用invoke不变，不新增聊天数据库或执行协议。
5. 自动动作依据用户明确授权的有界历史策略：小缺口按跨度，大缺口及未知基线最多最近15条，文本最多1500 Unicode码点；不翻页、不追全量。

# 最终体验

| 场景 | 行为 |
| --- | --- |
| 普通未 @ 讨论 | 只观察授权scope内的位置，不调用历史API或模型、不分配session、不回复 |
| 无缺口，或区间只有可确认自身输出 | 不读历史、不重复注入正文 |
| 两条讨论后再次 @ | 模型前固定API读取两条，作为`extra.im/history`随本轮快照提交，不要求模型先调用工具 |
| 缺口很大或基线未知 | 读取冻结触发之前最近最多15条，代码执行范围、去重和条数限制；更早部分明确省略 |
| 当前问题与旧讨论无关 | 仍按位置策略准备输入，不用关键词或模型判断决定固定流程 |
| 冷启动或reset后首轮 | 与缺口共用一次API读取，不先冷取15条再补另一页；仍最多1500码点 |
| API拒绝、超时或协议错误 | 不阻断本轮任务；状态为unavailable，保留待补边界，不换身份、不启动CLI补救 |
| 正文被Context预算移除 | 状态改为omitted，不声称材料已提供，保留待补边界 |
| 同代次卡片重试 | 复用原冻结Context，不重新读历史或宿主动态Context |
| 显式fresh_fallback | 仅下一条新输入重新取最多15条；不在当前Run内补调模型 |

# 方案与验收入口

- [设计](design.md)：消息位置、固定API流程、状态和并发边界。
- [改动拆分](changes.md)：逐文件改动及里程碑。
- [验收矩阵](test-plan.md)：29项合同与自动化/真实证据边界。
- [争议评分](feasibility.md)：固定API方案91/100的有条件可执行性，不是完成度。
- [实施记录](implementation.md)：实际落点及最新验证journal。

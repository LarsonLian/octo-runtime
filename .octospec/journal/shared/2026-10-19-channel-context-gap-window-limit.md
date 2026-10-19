---
type: Journal
title: Issue 32 缺口取材统一最近15条上限
description: 按用户补充收敛游标大缺口的取材总量，保留小窗口精确性及真实验收边界。
tags: [channel, context, history, testing]
timestamp: 2026-10-19T00:00:00Z
---

# 决策与落点

2026-10-19用户要求游标差异过大时，与完全冷启动一样最多通过CLI取最近15条。此决策替代此前未知基线5条、增量单页10条及最多3次sync的方案；上一次实施验证记录保留为历史事实。

- 冷启动与CLI计划共用`IM_HISTORY_MESSAGE_LIMIT=15`。未知基线建议最近15条，已知缺口为`min(15, positionSpan)`；两条缺口仍只建议两条。
- 起点仍为冻结触发序号减一，保留原下界，不包含触发本身或排队期间更晚到达的消息。缺口超过15时标记更早记录省略，不承诺恢复所有讨论。
- 完整与压缩指引均规定本轮最多一次sync、最近15条，禁止自动翻页或多次调用绕过总上限。Gateway控制生成的计划和冷窗口，不拦截Agent的通用工具执行；该工具预算不是Host强制限制。
- 冷启动1500 Unicode码点、一次性资格、原频道/话题权限、按需取材、失败如实说明均不变。方案及逐项验收同步至[任务](../../tasks/channel-context-gap/brief.md)。

# 本轮验证

定向回归命令为`node --test test/im-context-gap*.test.js test/im-new-session-history.test.js`，45项全部通过、0跳过、0失败，其中缺口回归41项、冷启动回归4项。覆盖14/15/16条、极大缺口、最大有效u32位置、未知基线、冻结上下界、完整及压缩指引，以及现有冷启动15条策略。

Gateway package build、全仓`tsc --noEmit`、`pnpm lint`、`pnpm lint:names`、`pnpm format:check`及`git diff --check`均通过。16份新增/修改Markdown的frontmatter、任务YAML及source路径检查通过；全仓文档linter仍有14条既有跨仓链接错误，逐条与HEAD核对无新增错误，未修改无关链接。

本轮不重新执行全仓Node/UI测试，历史全量结果见[上一轮实施验证](2026-10-19-channel-context-gap-implementation.md)，不能视为此补充后的全量复验。部署合同、真实Agent及M0门槛仍待验，不调用真实模型或生产消息，不提交、推送、建PR、合并或发版；91/100可执行性评分不等于完成度。

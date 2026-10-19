---
type: Implementation
title: 群与话题缺口的固定API实施
description: 记录从模型CLI指引纠正为模型前API准备的实际实现与验收边界。
tags: [channel, history, context, implementation, testing]
timestamp: 2026-10-19T00:00:00Z
---

# 当前状态

在`octo-runtime-plan-channel-context-gap` worktree、`plan/channel-context-gap`分支继续实施，已fetch基线`65728c1`。2026-10-19用户纠正最初方案：模型工具调用用octo-cli，模型前固定流程直接用API。本记录为当前方案；此前“CLI指引/工具预算”journal只是历史，不代表现行实现。

此前实施阶段未提交、推送或建PR。2026-10-19用户追加授权刷新OctoSpec、code review并提交英文PR到main，关联Issue #32；本轮按此执行，不自动合并或发版，不调用真实模型或生产群消息。

# 实际代码

源码均在`packages/octo-runtime-extra-channel-gateway/src/`：

- `transport/contexts.ts`统一冷/续聊读取分支，通过`transport/api/conversations.ts`的`getChannelMessagePage`在模型前固定补取。无缺口不查，小缺口按跨度，大缺口/未知基线最多最近15条，不做关键词分类。
- 请求共用当前Bot身份及原始群/完整话题地址，一轮最多一次HTTP，10秒超时、1 MiB响应，禁用429重试。返回按冻结上下界过滤、按seq/ID去重、截至15条，文本1500 Unicode码点；只取文本，不下载媒体。
- 正文放`extra.im/history`；`extra.im/history-gap`只报provided/partial/empty/unavailable/omitted和覆盖范围，无CLI argv、取材指令或凭据。不调用CLI子进程，不让模型决定是否执行固定步骤。
- `application/context-gap.ts`保留纯位置计划和交接判断，删除advertised/unverified工具债务。`pendingAfterSeq`只保留API失败、材料省略或Run失败后的待补边界，不代表模型未读。
- `application/im-channel.ts`在首次实际交接处合并metadata；只有最终快照仍含真实API正文或返回无可用文本时清除待补边界。/stop取消准备并阻止模型调用；fresh_fallback仅使下一新输入重新取有界窗口。
- `execution/dispatcher.ts`在执行默认项合并后省略自动正文时，状态同步改omitted/materialProvided=false，不回退到模型查询。压缩状态不会丢失失败事实，显式业务项不截断。
- 现有位置观察、SENDACK/自身RECV、原turn卡片归属、有界binding原子patch继续使用；同代次retry复用原occurrence快照，不新增API或宿主Context读取。
- 独立Spec审查发现并修复两项P2：新10秒/禁429重试策略仅应用群/话题，DM恢复原策略；Run失败恢复经校验的实际afterSeq（含较早pending及未知null），不因成功补取清除pending而遗失范围。四项新增回归分别覆盖DM、已知/未知旧pending及无新查询的失败路径。

无Host/Adapter/WeCom、wire协议、版本/tag、用户配置或聊天正文持久库变更。额外模型业务工具调用仍使用octo-cli，不受此次固定准备实现取代。

# 验证与剩余门槛

最新API纠正后的定向回归、静态检查及全仓证据见[本轮journal](../../journal/shared/2026-10-19-channel-context-gap-api-preparation.md)。旧实现及15条指引阶段的证据分别保留于[初次实施](../../journal/shared/2026-10-19-channel-context-gap-implementation.md)和[窗口定案](../../journal/shared/2026-10-19-channel-context-gap-window-limit.md)，不混作本轮复验。

[29项验收矩阵](test-plan.md)仍有部署M0、真实Provider及自身卡片联调待验。91/100是有条件可执行性，不是完成度。本地fake证明请求在host.invoke前完成、取消和边界正确，不能证明部署服务序号域或模型确已使用全部材料。

本轮交付执行rebase最新main、独立双轴评审和英文PR关联`Closes #32`。部署门槛仍缺，因此先创建Draft PR，不以本地通过替代真实联验或合并批准；交付记录见[审查与PR journal](../../journal/shared/2026-10-19-channel-context-gap-review-pr.md)。

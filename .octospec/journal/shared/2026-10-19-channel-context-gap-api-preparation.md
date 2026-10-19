---
type: Journal
title: Issue 32 从模型CLI指引纠正为固定API准备
description: 记录用户明确的架构边界、实际修改和本轮验证，保留真实部署待验状态。
tags: [channel, context, architecture, history, testing]
timestamp: 2026-10-19T00:00:00Z
---

# 原方案问题与定案

2026-10-19用户指出：模型工具调用使用octo-cli，但模型前固定流程应基于API代码直接调用。此前把固定缺口补历史写成“模型按需CLI取材”是职责判断错误；仅限制CLI指引最近15条，仍不能保证固定步骤发生。

现改为ChannelGateway作为Event发起方，在模型前直接调用现有`transport/api/conversations.ts`的`getChannelMessagePage`。固定准备不依赖CLI安装、模型选择或关键词；Agent的额外业务工具调用仍走octo-cli。Host/Adapter不新增预取或业务执行器。

# 实施范围

- 沿服务端位置和有界binding确定冻结开区间；冷/续聊合并为本轮一次HTTP、10秒、1 MiB、禁用429重试和分页。
- 代码执行小缺口按跨度、大缺口或未知基线最近最多15条；返回再过滤、去重、截条数及1500 Unicode码点，只提交文本。
- 模型请求已携带`extra.im/history`正文；`history-gap`只报告加载/省略状态，无CLI argv。API失败或预算移除不声称成功，不换身份或CLI补救；取消阻止host.invoke。
- 删除advertised/unverified工具债务；仅保留交接位置与失败/省略后的待补边界。同代次retry复用冻结材料，不重新调用历史API或宿主Context。
- 同步[当前Spec](../../tasks/channel-context-gap/brief.md)、架构/Context/Channel/session/stateless规则及SDK/CLI指南；此前journal保留为历史，不再作为现行实现说明。

# 本轮验证

| 检查 | 实际结果 |
| --- | --- |
| Gateway package build | `pnpm --filter @mininglamp-oss/octo-runtime-extra-channel-gateway build`通过 |
| 定向回归 | `node --test test/im-context-gap*.test.js test/im-new-session-history.test.js`，50通过、0失败、0跳过 |
| 全仓Node | `node --test --test-concurrency=2 test/*.test.js packages/octo-runtime-protocol/test/*.test.js`，1229项、1220通过、9条件跳过、0失败 |
| 类型与静态 | 全仓`tsc --noEmit`、`pnpm lint`、`pnpm lint:names`通过 |
| 格式与空白 | `pnpm format:check`、`git diff --check`通过 |
| 文档 | 19份新增/修改Markdown的frontmatter、任务YAML及source路径检查通过；全仓linter仍报14条既有跨仓链接失效，逐条与HEAD核对无新增错误 |

定向回归覆盖实际API参数与响应、冻结范围、14/15/16条和最大u32、服务端多返仍至多15条、固定调用先于host.invoke、429不重试、失败继续、/stop中止、预算省略及重试不重取。最初旧测试仍期待CLI argv/未确认债务，按本轮明确合同更新；压缩状态的预算fixture改为依据实际合并默认项后的字节数计算，验证保留显式材料而非依赖旧长指引长度。

本轮未重新执行UI测试，UI源码未修改；不将此前UI结果冒充本轮复验。

# 未完成门槛

所有自动化使用fake API、加密WS和fake Provider，不读取生产讨论、不调用真实模型。M0部署可见性、同域序号、端点/more及自身卡片位置仍待授权im-test验收，真实Provider消费Context的体验待验。91/100为条件可执行性，不是完成度，不关闭Issue。

本轮未提交、推送、建PR、合并、发布版本或tag。后续交付按授权rebase最新main、独立评审、CI及英文PR关联`Closes #32`。

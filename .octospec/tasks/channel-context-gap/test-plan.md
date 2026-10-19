---
type: TestPlan
title: Issue 32 固定API历史准备验收
description: 29项合同及确定性测试与真实部署证据的边界。
tags: [channel, history, context, testing]
timestamp: 2026-10-19T00:00:00Z
---

# 证据分类

自动化使用本地fake API、加密WS和fake Provider，不读取生产讨论、不调用真实模型。部署M0与实际Provider体验须单独验收。最新本地运行结果见[实施记录](implementation.md)，不以单测数量等同29项全部上线验收。

# 验收矩阵

| 编号 | 场景 | 通过标准 |
| --- | --- | --- |
| HG-01 | 原案例：同session两条未 @ 讨论后再次提问 | 未 @ 不invoke；同业务/Provider会话继续；模型请求中已含API取得的两条正文，无CLI补历史要求 |
| HG-02 | 区间只有已确认自身回复 | 无历史API、无gap正文；ACK不被当作普通讨论 |
| HG-03 | 一条潜在讨论 | API limit=1，不用>=3阈值漏关键结论 |
| HG-04 | L=101、U=104 | API start103/end101/down/limit2，只保留102、103；真实端点另做M0 |
| HG-05 | 14/15/16条、极大缺口、最大u32位置 | API limit=min(15,跨度)；即使服务端多返也过滤去重后截至最近15条，只一次请求，不追more |
| HG-06 | 删除、非文本、缺失/非法more、越界或重复记录 | span不作文本条数；不下载媒体，不把少返回当完整证明；协议错误如实标unavailable |
| HG-07 | 冷启动成功或截断 | 冷/缺口共用一次读取；最多15条/1500码点，标记截断，不另读更早页 |
| HG-08 | 403、429、网络/协议错误、超时 | 当前任务可继续，unavailable且materialProvided=false；不重试429、不换身份、不用CLI补救 |
| HG-09 | warm未知基线 | 固定API start=U-1/end0/limit15，不宣称窗口覆盖全部历史 |
| HG-10 | U=1、缺失、负数、小数、溢出、回退 | 不生成start=0的伪上界；无安全范围时不读API、不假装精确 |
| HG-11 | 不允许的Space/群/父群 | 既不观察也不执行，不跨scope读取 |
| HG-12 | 允许scope但sender不具执行资格 | 可观察位置，仍不invoke，不将观察权限当执行授权 |
| HG-13 | WS/RECV/SENDACK真实语义 | fixture校验字段；部署证明message_seq与sync同域、未 @ 消息可见性 |
| HG-14 | 自身输出ACK与自身RECV | 归属原turn和地址，只观察；不重复执行，不把客户端seq当服务端位置 |
| HG-15 | 排队消息 | 接收冻结U，开始准备再读L；更晚观察max不移动当前窗口 |
| HG-16 | 后续观察与前轮交接竞态 | 原子合并保留最新观察，不用旧session拷贝覆盖新位置 |
| HG-17 | 准备失败、/stop及API等待 | API未完成前不invoke；/stop取消真实请求且不推进prepared边界 |
| HG-18 | Run失败或取消 | 原prepared=101、pending=98或null时，补取成功后Run失败仍恢复原有效下界；无新查询时失败也不丢已知下界，下一输入仍封顶最近15条 |
| HG-19 | 同代次卡片retry | 冻结Context与原正文完全复用，无新增历史API或宿主Context读取 |
| HG-20 | reset及旧turn/ACK | 旧代次不能更新新binding；下一普通输入按新窗口准备 |
| HG-21 | 重启、TTL与淘汰 | 不继承跨进程游标或恢复旧“已读”假设 |
| HG-22 | 大量普通scope及metadata预算 | 不分配binding、不续TTL、不改淘汰顺序；自身位置最多32，字节超限拒绝metadata patch |
| HG-23 | Context条数/字节预算 | 不截断显式材料；正文移除变omitted/materialProvided=false，待补边界不清除，状态可压缩/省略 |
| HG-24 | API失败边界与新缺口叠加 | 合并下界但只取最新15条；成功交接正文或空API结果后不重复查旧范围 |
| HG-25 | 实际Provider消费Context | 模型直接获得已取材料，按事实回答并说明更早遗漏；不要求模型先CLI查询，真实体验待验 |
| HG-26 | 独立问题及权限失败 | 固定准备不做关键词分类；当前问题正常执行，错误不触发工具代查或额外模型调用 |
| HG-27 | 显式fresh_fallback | 下一新输入仅一次15条bootstrap，其后相邻无缺口不重复；本轮不另起invoke |
| HG-28 | 自定义store无patch | 固定取未知基线窗口，不伪装精确L；核心会话仍按原合同运行 |
| HG-29 | 保留键/配置/公共协议 | 显式Context不被覆盖；DM原30秒与429重试可恢复历史，不受群/话题10秒禁重试策略影响；WeCom、Host/Adapter和版本/tag不变，无凭据进模型 |

# 检查命令

- Gateway package build后执行`node --test test/im-context-gap*.test.js test/im-new-session-history.test.js`。
- 执行全仓类型、lint、命名和格式检查；跨入口Node回归使用低并发，避免已有计时测试干扰。
- 文档验证frontmatter、任务YAML与链接；原有跨仓失效链接单独记录，不修无关问题。

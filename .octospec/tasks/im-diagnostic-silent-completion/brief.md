---
type: Task
title: IM 中途诊断后无有效回复的收尾体验改造
description: 保留执行中诊断，区分 Provider 完成与 IM 回复可交付，避免空成功提示诱发重复执行。
tags: [channel, adapter, protocol, delivery, testing]
timestamp: 2026-10-16T00:00:00Z
---

# IM 中途诊断后无有效回复的收尾体验改造

## 目标与状态

状态：implemented。2026-10-16 已完成合同、Adapter、IM 收尾、自动化和 im-test 受控故障验收。真实 Provider 自然故障的发生频率及其他客户端仍不在已验收范围；详见[实施记录](../../journal/shared/2026-10-16-im-diagnostic-silent-completion-delivery.md)。

用户关心的是任务能否连续执行、故障时提示是否准确，以及是否会诱导重复执行。本任务沿用现有 app-server 接入，只处理“执行中出现诊断，最终没有可交付回复，却向用户报告完成”的体验缺口。

核查记录见[本次检查](../../journal/shared/2026-10-16-im-diagnostic-silent-completion-assessment.md)，已实施的重连与重试能力见[长任务恢复任务](../im-long-running-retry/brief.md)。本任务不重建重试机制。

## 参考 PR 与实现检查

参考 [codex-channel-octo PR #49](https://github.com/Mininglamp-OSS/codex-channel-octo/pull/49)，关联 [Issue #48](https://github.com/Mininglamp-OSS/codex-channel-octo/issues/48)。检查固定到 head `5d664fe64e1ad2bf07a8e6fea94fe48110dabdb8`；2026-10-16 查询时 PR 为 OPEN，五项 CI check 均成功。参考实现的测试结果来自 PR 记录，不是本仓复跑结果。

重点参考[诊断处理与终态检查](https://github.com/Mininglamp-OSS/codex-channel-octo/blob/5d664fe64e1ad2bf07a8e6fea94fe48110dabdb8/src/agent-bridge.ts#L505)、[实际输出选择](https://github.com/Mininglamp-OSS/codex-channel-octo/blob/5d664fe64e1ad2bf07a8e6fea94fe48110dabdb8/src/output-selection.ts)及该 PR 的 notification/reconciliation 回归测试。

| PR 的处理 | 解决的用户问题 | 当前 octo-runtime 核查结果与改造关系 |
| --- | --- | --- |
| 中间 error/告警先保留，继续消费同一次执行 | 短暂重连不把可恢复任务提前杀掉 | 当前已处理；保留，不增加模型尝试 |
| `pendingFailure ??=` 保留首次诊断，后续通知不覆盖 | 后来的重连提示不能掩盖更早的真实问题 | canonical 非重试 error 目前没有向 IM 保留其原因，需要补充事实传递 |
| 完成后按实际投递模式、快照及字符上限选择回复 | 曾出现过文本不等于最终有答案；空白、覆盖和不同 phase 不能误判 | IM 应共用自己的最终文本选择结果；不复制另一产品的 OutputCollector 或配置 |
| 有待处理诊断且选择结果为空时，先报错再结束 attempt | 不把无答案的故障执行当作正常回复完成 | 当前会得到 `run.completed` 并回复“本轮执行完成，未返回文本。”；这是本次主要缺口 |
| 真正终态失败、取消、进程/解析故障继续优先处理；缺失成功终态不能算成功 | 不发布部分答案或把断流说成成功 | 本仓已核查最终失败、进程提前退出及取消；其他边界列入回归，不借 PR 结果宣称已覆盖 |
| 固定日志标记和有界通知数，不改变重放资格 | 可以排障，又不会因诊断触发危险重跑 | 采用有界诊断与无正文日志原则，复用本仓既有执行风险和恢复预算 |

PR 的“抛出 failure”是该业务桥的选择。本仓采用下述 IM 展示判断，不把 Provider 的真实 completed 改成所有调用方都必须接受的 failed，也不增加 SDK/CLI 的“成功必须有文本”要求。

## 当前问题与复现

受控 app-server 事件顺序：

```text
turn/started
error { willRetry: false, error: { message: "Synthetic auth failure", codexErrorInfo: "unauthorized" } }
turn/completed { turn: { status: "completed" } }
```

改造前 canonical 处理不提前终止，但也没有将上述诊断原因传到 IM；最后生成 `run.completed`。IM 在 finalText 为空时使用“本轮执行完成，未返回文本。”。用户无法从该回复判断发生过什么，可能再次提交已经部分执行的任务。改造后保留真实 completed，并在 IM 将这种无回复收尾展示为待核查。

这证明当前消费链路存在可触发的收尾缺口，不证明真实 Codex 必然会产生上述矛盾组合。真实发生频率、线上错误形状和实际 IM 展示仍须在测试环境验收。

源码入口：[Codex 转换与终态](../../../packages/octo-runtime-adapter-codex/src/app-server.ts)、[任务恢复](../../../packages/octo-runtime-extra-channel-gateway/src/execution/task.ts)、[回复投影](../../../packages/octo-runtime-extra-channel-gateway/src/presentation/run-projector.ts)、[IM 最终投递](../../../packages/octo-runtime-extra-channel-gateway/src/application/im-channel.ts)。

## 需求范围与责任检查

1. 业务目标：用户能区分正常答复、没有文本的正常结束、带未消解诊断的无回复结束和执行结果未知，避免因为错误提示而重复副作用。
2. 决定权：Provider 决定原生执行终态；Adapter 负责忠实传递故障事实；Channel Gateway 决定 IM 的交付判断、文案和操作入口。此需求属于本仓 IM Extra，不是全产品的成功定义。
3. 显式输入：继续执行业务方提交的本轮 InvokeInput、Context 和恢复预算。不新增自动追问模型、自动补总结或自动重跑请求。
4. 责任缺口：canonical 转换丢失诊断原因在 Adapter 修复；IM 将 Provider completed 直接当成答复成功在 Channel 修复。不能让 IM 读取 Provider 私有协议、解析任意错误文本猜类别来补救。
5. 其他接入方：native 继续保留原生通知和真实控制终态；SDK/CLI 及其他 Extra 不自动继承 IM 文案、答案选择或空回复判定。
6. 自动动作依据：沿用既有同次执行恢复、任务时限和安全重试合同。本任务新增的“需要核查”只改变 IM 收尾，不能授予新一轮重放资格。

## 体验目标与判定表

“有效回复”指终态时按 IM 实际投递规则选出的、用户可见的最终答复；不以历史 delta、commentary、thinking、工具输出或内部 fallback 文案充当答案。选择结果及空值判断由同一个出口提供给收尾和发送，不能各写一套。

| 执行结果与实际回复 | 目标体验 | 后续执行 |
| --- | --- | --- |
| 重连通知后继续执行 | 同一进度卡显示“正在重试”；保留停止能力及既有恢复预算 | 不因通知新增 invoke |
| completed 且有有效回复 | 正常投递答案；过程诊断保留在脱敏详情中，不继续显示“正在重试” | 不自动补答或重跑 |
| completed，无有效回复，存在过程错误诊断 | 显示“执行已结束，但未收到可确认的回复。请核查任务结果，避免重复执行。”；附可公开的首条原因 | 标记业务交付待核查，禁止自动重放 |
| completed，无有效回复，仅有重连/降级通知 | 不声称任务业务目标已完成；说明未收到回复并保留恢复详情 | 不仅凭重连通知判定业务失败或重新执行 |
| completed，无有效回复，也没有诊断 | 保留无文本结束的合法语义；提示“执行已结束，未返回文本。” | 不统一升级为失败，不自动重跑 |
| failed / cancelled / 缺失终态或联系丢失 | 分别保持实际失败、已中断和结果未知提示；失败原因优先使用终态证据 | 沿用既有安全恢复规则，不把未知结果当作明确失败重放 |

“待核查”属于 IM 的交付状态，不等同于 Host lost。Provider terminal、业务交付判断及 IM 发送结果分别保存和展示；卡片与最终文本必须一致，不能卡片标正常成功却在文本里要求核查。需要核查的收尾不显示“一键重新执行”入口；保留详情和明确停止后的真实状态。

有答案仅证明可以交付一条回复，不保证模型完成全部业务目标。有工具完成事件也不能单独证明整个任务成功。已经正常恢复并给出有效答复时，不因早期诊断强制降级整轮结果。

## 改造计划

| 阶段 | 工作与产物 | 完成条件 |
| --- | --- | --- |
| M1 诊断事实合同 | 盘点 canonical 可用载体；定义可选、脱敏、有界的 Provider 过程诊断及 retry 与 error 的区别，冻结生产/传输/消费合同 | 原生与 canonical 对同次执行保留等价可观察事实；真实终态不变，未知分类不猜测 |
| M2 Adapter 与传输 | Codex 保留首条真实过程错误，重连通知只累计；经 Host/RPC 完整传给 Channel，不提前终止执行 | 诊断到达消费端且不被后续 notice 覆盖；同次恢复只有一个 Provider 执行 |
| M3 IM 收尾与展示 | 在 Channel 内统一最终回复选择与业务交付判断；接入进度卡、最终文本、详情和重试按钮条件 | 判定表逐行实现；无重复答复、无空白成功、无待核查自动重放 |
| M4 回归与线上验收 | 完成下节矩阵、跨包检查及 im-test 受控故障验证，记录版本与限制 | 自动化与线上证据分开，实际客户端可见效果与执行次数符合目标 |

### M1 合同约束

- 已冻结 `run.notice.code=provider_diagnostic`，`severity=warning`；`params` 只能包含必填的 `adapter`、`diagnosticId`、`category`、`message`。Schema 枚举、生成类型与语义校验同步更新。类别仅来自结构化 Provider 证据，不从任意错误正文猜测。
- 该 notice 表示 `willRetry!==true` 的首条真实过程错误；原生重试继续使用既有 `retry_scheduled`。两者均不终结执行，也不改变 Provider 终态。
- 每个 Adapter invoke 最多新增一条过程诊断；首条错误不会被后续错误或重连覆盖。重试计数封顶 65535，原因脱敏后按 Unicode 码点截到最多 2048 UTF-8 字节。IM 按已有尝试边界重新创建 projector。
- 正常路径不新增 notice、不增加网络或模型调用、不解析 Markdown；终态只复用原有 final 文本选择。仅出现上述诊断或重试通知时才解析 Markdown AST，排除空白、不可见字符、注释、定义及无正文结构；实际投递和卡片共用同一个最终选择结果。
- 新枚举不对旧严格校验器承诺兼容。Codex Adapter、Protocol、Host/RPC 与 Gateway 须作为同一发行物更新；独立消费者先升级协议校验，再接入新生产者。本任务链路在 Runtime 内，Worker 未增加 canonical notice 白名单，Run=7、Context=v3 及 Adapter protocol=2 均不变。
- 不记录 prompt、工具输出、凭据或完整原生正文；常规日志使用固定标记及有界计数。沿用现有脱敏和诊断定位机制，不新增业务历史库。
- Run=7、Context=v3 保持。若修改共享协议，按项目要求同步构建 Worker、Harness/Runtime、桌面应用并重启受影响进程，验证注册与执行；不能只更新生成类型。

### M3 回复与状态约束

- 同一消息 ID 的最终快照可以覆盖早期内容；最终为空、空白、不可见格式或被输出上限截空时，不能因先前 delta 非空判为有效回复。Markdown 规则复用实际渲染/投递语义，不引入通用正文猜测器。
- 仅 final 通道参与答复选择，commentary、analysis 和工具事件不能清除待处理诊断。真正终态与最终选择完成后才决定 IM 收尾。
- 业务待核查标记留在当前任务的有界内存状态，不能通过伪造 `run.failed` 进入现有自动重试逻辑。
- 卡片发送失败仍尝试最终文本；消息发送失败属于投递失败，不重新调用模型。跨尝试文本和诊断按已有尝试身份隔离，不把旧尝试的诊断归给新答案。
- 任务结束时释放状态；reset、切 Bot、停止和卸载不泄漏诊断或污染下一轮。下一轮由用户发起，不自动重放上一轮或从历史 Event 补 Context。

## 验收矩阵

| 场景 | 必须核对的结果 |
| --- | --- |
| 重连 / 传输降级通知后成功，含先有部分文本和工具活动 | 同次执行完成并交付答案；不重复工具、不增加 invoke，恢复提示结束 |
| 真实过程错误后成功且有有效答案 | 正常投递，首条过程诊断可查；晚到通知不覆盖原始原因 |
| 错误后 silent completed；无文本/空字符串/空白/不可见格式 | 卡片和文本一致提示待核查，保留首条原因，无自动/按钮重放 |
| 先有文本后空快照、仅 commentary/analysis、混合 phase、输出上限截空 | 由同一实际投递选择器判定，无“之前输出过所以成功”的旁路 |
| 仅重连通知后空结束；无诊断的合法空结束 | 不误认明确失败，不假称业务目标完成，不改变通用 Provider 终态 |
| 真实终态失败、取消、期限耗尽 | 原语义及终态原因优先，过程诊断不覆盖；取消能回收进程 |
| 部分输出后 EOF、非零退出、坏帧、流缺口、清理失败 | 不发布正常成功；明确实际故障或未知状态，不依赖已有文本掩盖故障 |
| 有工具/交互后结果待核查 | 不因空回复重放，不将工具事件当成业务成功证明 |
| 重复/大量诊断、首条错误后再有重连、跨尝试和 reset | 计数/文本有界，首条原因正确，状态隔离且结束释放 |
| 卡片不可用、最终文本投递失败、停止/重试按钮 | 文本仍可独立表达真实结果；投递恢复不重新执行任务 |

## 验证顺序与交付证据

1. 已将临时探针固化为 fake app-server 进程回归，并覆盖 Adapter → Host/RPC → Channel。新诊断测试在旧 dist 上为 17 失败、1 通过，实施后通过。
2. 运行相关 Adapter、协议、投影、任务及 Channel 测试；跨包合同变更执行 `pnpm lint`、`pnpm typecheck`、`pnpm test`。检查 native 原生通知及控制终态没有被 IM 规则改写。
3. 连接 `https://im-test.deepminer.com.cn/`，在受控测试 Bot/会话验证恢复成功、诊断后无答复及明确失败三个场景，核对卡片、最终文本、尝试次数、停止和按钮行为。真实 Provider 自然故障与测试链路注入分别标记；首页 200 或无效 token 401 不能代替该验收。
4. 涉及 Work App 展示或桌面真实接口时，重启对应运行进程并通过 CDP 检查真实 renderer；没有桌面改动也须核查实际 IM 客户端最终可见内容。联调记录不得包含凭据。
5. 在 journal 记录构建版本、每项证据、未验收项和剩余限制；完成后再回写当前规则。规划阶段不把目标提前写成已实现约束。

## 当前里程碑

- M1–M3 已完成：有界诊断、真实终态、同一最终回复出口、待核查卡片/文本和禁止自动重放。
- M4 本次范围已验收：全量 929 通过、8 条件跳过；im-test 五场景真实收发与服务端卡片、桌面真实组件 CDP 验证、真实 Codex 正常路径验证通过。Worker、Runtime、Work App 构建通过，本地受影响 Runtime 已按原有身份重启。
- 未宣称发布生产版或复现真实 Provider 自然故障；手机、其他 IM 客户端与自然长时故障属于后续观察。完整命令、消息 ID、验收边界和评分见[实施记录](../../journal/shared/2026-10-16-im-diagnostic-silent-completion-delivery.md)。

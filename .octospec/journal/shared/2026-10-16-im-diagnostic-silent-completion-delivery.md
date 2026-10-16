---
type: Journal
title: IM 诊断后无回复收尾实施与验收
description: 记录有界诊断、交付待核查状态、正常路径开销及真实测试环境验证。
tags: [channel, adapter, protocol, delivery, testing]
timestamp: 2026-10-16T00:00:00Z
---

# IM 诊断后无回复收尾实施与验收

## 实施结果

用户授权开始实施后，在当前分支完成[任务](../../tasks/im-diagnostic-silent-completion/brief.md)的 M1–M4。本次实现沿用 app-server；参考 PR 的固定版本及问题对照保留在[原核查](2026-10-16-im-diagnostic-silent-completion-assessment.md)。

基线为 `712b80af12bd13daf42489d799340beea05e8cd1` 加当前工作区修改；版本 `1.0.0`，真实 Provider 为 `codex-cli 0.154.0`。工作区有其他任务未提交修改，本次未清理这些修改，也未提交、推送或发布发行物。

1. Codex Adapter 将首条非原生重试的过程错误转换为 `run.notice/provider_diagnostic`。原因先脱敏，再按码点限制到 2048 UTF-8 字节；结构化类别和诊断编号复用 Failure 设施。后续错误不覆盖首条，仍等待真实 `turn/completed`。
2. Protocol 同步 Schema 枚举、生成类型及参数语义校验；Host/RPC 无业务分支，直接保留事实。Run 7、Context v3、Adapter protocol 2 不变。
3. IM 终态统一生成 `finalReply` 与 `replyAssessment`。仅异常/重试轮次检查 Markdown 内容；正常轮次不增加 notice、网络或模型调用。空快照可以清空早期文本，commentary 和工具输出不充当答案。
4. completed 且有诊断但无有效回复时，卡片显示“结果待核查”，最终文本提示核查任务结果、避免重复执行，附首条公开原因和编号。继续保留 Provider completed，不生成 run.failed，不进入自动重试；卡片使用 stopped 结果视图，重试控制也拒绝重新执行。
5. 有有效答案时正常交付，过程诊断在详情保留；真正 failed/cancelled/未知结果继续按实际终态处理。无诊断的合法空完成显示“执行已结束，未返回文本。”。

## 自动化与构建

| 检查 | 本次结果 |
| --- | --- |
| 新诊断测试对旧 dist 的负对照 | 17 失败、1 通过，证明能暴露原缺口 |
| 最终 `pnpm test`，包含重建全部 Runtime 包 | 937 项：929 通过、8 条件跳过、0 失败 |
| 最终相关定向测试 | 95 通过，含新增 Markdown 边界、Host/RPC/IM、进程退出、取消和 native 既有回归 |
| `pnpm exec tsc -p tsconfig.json --noEmit` | 通过 |
| Runtime `pnpm lint` | 构建结束后顺序运行通过 |
| Worker `make build` | server 与 migrate 均构建成功；未修改 Worker 源码或数据库 |
| Work App `pnpm build` | Electron main/preload/renderer 与 tsc 成功 |
| `git diff --check` | 通过 |

关键回归位于 [诊断投影](../../../test/im-diagnostic-completion.test.js)、[Host/RPC 到 IM](../../../test/im-task-channel.test.js)及 [app-server 子进程](../../../test/codex-app-server.test.js)。覆盖首条诊断、2048 字节与脱敏、正常无 notice、空白/不可见字符/Markdown 空结构、最终快照覆盖、正文/代码/图片恢复、重试后空结束、工具后空结束、失败/取消优先、跨尝试隔离及无按钮重放。

过程中曾把 lint 与会清空 dist 的完整构建并行，触发类型解析级联报错；构建结束后单独重跑 lint 通过。一个新增坏帧测试起初只写无效 stdout 而不结束进程，因此按测试 AbortSignal 得到 cancelled；已改为“坏帧后 EOF”，验证缺失成功终态不能算成功，不宣称 Adapter 会将所有不可解析 stdout 立即转为失败。

## im-test 真实收发

复用受控 QA 群 `0166f275fcb443cd830f1695788c0fdc`，名称 `Channel_QA_1792087413796`。使用本机受保护账号文件提供的两个 User Bot，脚本先核对 Bot 身份、测试服务器和 QA 群成员。未向群外账号发送消息，未将临时接待配置写入长期 Runtime。

Provider 是受控 app-server 子进程，Host/RPC、IM WS、卡片发送/编辑、最终消息和服务端历史查询均为真实链路。这是故障注入验收，不能据此声称自然 Codex 已出现相同故障组合。

最终完整重跑结果如下，每行均为 **1 次 invoke、1 张卡片、1 条最终文本**；没有投递诊断错误：

| 场景 | Provider terminal / IM 判断 | 卡片消息 ID | 最终文本消息 ID |
| --- | --- | --- | --- |
| normal | completed / ready | 2110831784642908160 | 2110831784840040448 |
| recovered：错误后有答案 | completed / ready | 2110831788115791872 | 2110831788296146944 |
| silent：错误后无答案 | completed / needs_verification | 2110831790594625536 | 2110831790779174912 |
| tool：工具结束但无答案 | completed / needs_verification | 2110831792930852864 | 2110831793165733888 |
| failed：真实失败终态 | failed | 2110831795443240960 | 2110831795606818816 |

同步回来的消息为服务端展开后的 Adaptive Card，而非原始 state/data；验收检查展开后的“结果待核查”文本和不存在 `reasoning_retry` 动作，并与本轮真实 terminal/assessment 核对。最初两次尝试因测试替身漏答 config/read 超时，第三次又因脚本误将展开卡片当作原始 state/data 断言失败；修正测试脚本后两轮完整通过，没有修改生产 API 合同来迁就测试。

复验入口：[verify-im-diagnostic-live.mjs](../../../scripts/verify-im-diagnostic-live.mjs)。显式提供 `OCTO_CHANNEL_QA_ACCOUNTS` 和 `OCTO_CHANNEL_QA_GROUP`；不在命令行或日志中输出凭据。

## 真实 Provider 与客户端

- 真实 Codex 正常执行返回 `DIAGNOSTIC_NORMAL_OK`，terminal 为 run.completed，notice 为 0，工具调用为 0。
- 桌面当前连接正式环境，未切换其账号或服务器。通过 CDP，将 im-test 实际返回的待核查卡片交给桌面原有 `ImKitProvider` / `AdaptiveCardMessage` 渲染；验证真实卡片 DOM、可见警告、无重试按钮、0 Runtime exception。测试挂载点在 finally 卸载，保留用户页面和配置。不是完整登录 im-test 的会话列表端到端验收。
- 桌面验证使用第一轮已成功的 silent 卡片 `2110829129254211584`；截图在 `/tmp/octo-diagnostic-renderer.png`，本次人工查看确认文字清晰且不重叠。复验入口：[verify-im-diagnostic-renderer.mjs](../../../scripts/verify-im-diagnostic-renderer.mjs)，另需 `OCTO_DIAGNOSTIC_CARD_ID`；截图路径通过 `OCTO_DIAGNOSTIC_SCREENSHOT` 可选提供。
- 本地内置 Runtime 确认 activeRuns=0、admittingRuns=0 后，停止 daemon PID 1254；通过宿主的 ensureRunning 重启为 PID 14279，Host ready，保留原 Home、身份和配置。重启后的真实 daemon → Host → Codex 执行返回 `DIAGNOSTIC_RESTART_OK`，terminal 为 run.completed，notice=0，工具=0。Worker 没有受影响的运行代码，构建后未重启或部署云端 Worker。

## 发布与剩余边界

新 notice code 不承诺兼容旧的严格枚举校验器。Adapter、Protocol、Host/RPC、Gateway 按同一 Runtime 发行物升级；独立消费者先更新协议校验，再启用新生产者。当前为本地源码与测试环境验证，未发布生产版本。

自然 Provider 故障发生频率、手机和其他 IM 客户端、整夜断线/合盖后的自然故障尚未新增实测。无文本正常完成仍然合法，有可交付回复也不等于模型已完成全部业务目标。发送失败与业务待核查均不授予重放资格；本任务不增加跨进程持久化或重启后恰好一次投递承诺。

## 可执行完整性评分

本次实施验收 **96/100**：合同与责任 25/25、实现闭环 25/25、自动化 20/20、真实环境证据 18/20、发布和复验 8/10。扣分来自自然长时 Provider 故障尚未实测，以及完整登录测试环境的多客户端端到端/发行物升级尚未验收；不是已知主流程功能缺陷。建议下一步按同一发行物升级消费端后灰度，观察异常轮次的诊断编号与实际交付，保持正常路径不新增诊断通知。

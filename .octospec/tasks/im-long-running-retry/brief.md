---
type: Task
title: IM 长任务时限与 Codex 故障重试改造
description: 以长任务为主要场景，由 Channel Gateway Extra 管理故障恢复预算，保留 Host 单次执行边界。
tags: [channel, extra, adapter, invoke, stream, testing]
timestamp: 2026-10-15T00:00:00Z
---

# IM 长任务时限与 Codex 故障重试改造

## 需求与状态

用户明确：IM 大部分 Bot 承担长时间任务，约一分钟的短任务很少。120 秒默认总时限无法满足需求，不能把截断正常长任务作为防止无限重试的方案。Codex 号池不稳定时，需要业务可控的恢复；不同 Extra 可以有不同策略，首期允许针对 Codex 特化。

已按用户要求在当前分支实施首期：Channel Gateway 默认一天、Bot 校验上限一天、Extra 独立任务与恢复预算、Codex 结构化故障归一化及尝试展示。重试归属为 Extra 决策、Adapter 提供证据、Host 单次执行。该实现覆盖本轮工具或交互出现前的暂态失败重试，不表示工具执行后的安全恢复已完成，也不表示已部署。用户记忆中的历史一天配置来源尚未核实。

## 改造前基线与问题

| 位置 | 改造前源码行为 | 问题或含义 |
| --- | --- | --- |
| Channel Gateway execution/dispatcher | 未配置时写入 run_timeout_ms=120000 | 长任务被过早截断 |
| Channel Gateway lifecycle/configuration | Bot run_timeout_ms 最大 600000 | Bot 普通配置无法表达一天任务 |
| 通用 Context 与 RuntimeLimits 校验 | run 时限上限 86400000 | 协议支持一天，不表示默认一天 |
| Host watchdog | 缺省 runTimeoutMs=10800000，即三小时 | 通常会被调用方实际提供的值覆盖 |
| Codex Adapter | 原生 error.params.willRetry=true 转成 run.notice/retry_scheduled | 只报告 Codex 自身重试，不触发 Extra 重跑 |
| IM projector | notice 映射为“正在重试” | 更新进度卡，不执行重试 |
| IM 执行循环 | run.failed 后结束本轮；流异常按结果未知处理 | 尚无业务自动重试编排 |

源码依据：[IM 请求构造](../../../packages/octo-runtime-extra-channel-gateway/src/execution/dispatcher.ts)、[Bot 校验](../../../packages/octo-runtime-extra-channel-gateway/src/lifecycle/configuration.ts)、[协议时限](../../../packages/octo-runtime-protocol/src/context.ts)、[Host watchdog](../../../packages/octo-runtime-executor-core/src/watchdog.ts)、[Codex 转换](../../../packages/octo-runtime-adapter-codex/src/app-server.ts)、[IM 执行](../../../packages/octo-runtime-extra-channel-gateway/src/application/im-channel.ts)。运行版本、Bot 配置和本轮 Context 决定实际值，源码默认值不能代替线上生效证据。

## 时限模型

1. 任务总期限：IM 默认一天（86400000 ms），从本轮首次 invoke 发起计时；包括全部尝试、退避、Provider 内部重试和交互等待。排队与输入准备在期限之外。短任务可以显式设置较短期限。沿用 run_timeout_ms 配置入口，校验范围为 100..86400000，与协议一致。
2. 每次尝试：Host 收到本轮剩余时长作为执行上限，Extra 重试不得重新获得完整一天。总期限始终由 Extra 独立计时，Provider 持续输出通知也不能延长它。
3. 连续故障恢复预算：Extra 分别限制重试次数、从故障被识别到恢复有效进度的累计时间。达到任一上限即停止恢复，不允许消耗整天任务时长反复连接失败。
4. 全任务累计重试上限：独立于连续故障预算，防止少量输出反复清零计数而绕过限制。只有可验证的有效执行进度才能结束连续故障段；重试通知、心跳、usage、连接成功和 session.update 不算恢复。
5. 模型空闲、工具空闲、工具执行时长与任务总期限分开配置。IM 工具无输出时限默认一天，Context limits 可以收紧；Host 首帧和模型空闲默认值保留，显式工具 wall 时限仍生效。快速时钟已覆盖 15 分钟静默工具，不使用 enforcement=observe 绕过保护。

首期工程默认值：连续重试 5 次、本轮累计 20 次、连续恢复 120 秒、指数退避起点 2 秒且最大 30 秒，并增加不超过 20% 抖动；遵守 failure.retryAfterMs，目录默认提示可能使实际等待为 30 秒。每 Bot 可通过 codex_retry 调整或关闭，完整范围见 [配置说明](../../../packages/octo-runtime-extra-channel-gateway/README.md)。非空 message.delta 或工具完成重置连续故障段，累计计数不重置。一天总时限不表示跨进程重启可恢复。

## 责任边界

| 层 | 改造责任 |
| --- | --- |
| Channel Gateway Extra | 拥有 IM 任务期限、重试策略、失败筛选、退避与预算、尝试关联、交互和卡片、最终回复 |
| Codex Adapter | 解析原生错误及恢复状态，向 canonical 输出足以判定的脱敏结构化事实；不决定 IM 重跑策略 |
| AdapterHost / daemon / RPC | 保持单次 invoke 的真实事件、终态、取消和资源释放；不隐式重新 invoke，不管理业务历史 |
| 号池服务 | 管理账号轮换、摘除、冷却及可恢复状态；再次 invoke 不保证一定获得另一账号 |
| 其他 Extra | 自行选择是否采用恢复策略；不得因本次改造默认自动重跑 |

首期策略放在 Channel Gateway 内部的 Codex 专用模块，不先引入通用 Provider 重试框架。WeCom、CLI、桌面普通执行的默认时限与重试策略不随此方案自动修改。

## Canonical 输入与断流分类

IM 当前消费 CanonicalEvent，策略不得直接读取原生 params.willRetry。Codex Adapter 把 willRetry=true 转为 run.notice(code=retry_scheduled)，params.attempt 当前只是 Adapter 累计通知数，不是 Extra invoke 次数。

- Provider 自身重试：模型上游连接失败但 app-server NDJSON 仍在，Extra 继续消费同一次执行；notice 只更新状态，不触发第二次 invoke。连续恢复预算必须覆盖这种等待，不能只限制 Extra 的重跑次数。达到预算后取消当前尝试，不能让卡片无限“正在重试”。
- 明确失败终态：收到 run.failed 后，Extra 按错误白名单、执行阶段、重放条件和剩余预算决定是否新建尝试。工具失败、过程 error 或 notice 本身不是重跑触发器。
- Provider NDJSON 断开：Adapter 尽力生成真实失败及进程退出、清理证据；仅“收到失败”不证明外部副作用未发生，也不自动证明旧执行已退出。
- Extra 与 Host 之间断流：优先按同一 stream 游标续流并确认终态；当前 IM 路径尚未完成该恢复编排。无法确定执行状态时报告结果未知，禁止盲目重新 invoke。cancel 接纳回执不等于执行已退出。

现有 failure.retryable 是诊断分类提示，不是自动重放授权。优先消费结构化错误码、HTTP 状态、故障阶段、retryAfterMs 与 Provider 恢复证据；必要的可选字段由 Adapter 补充，经统一协议传递。字段设计在实现前核对已有 FailureEnvelope，保留原始脱敏 message/error，不让 Extra 解析任意错误字符串或完整原生协议。

## 筛选策略与中途恢复

| 故障 | 候选处理 |
| --- | --- |
| 明确的临时不可用、502/503/504、连接重置 | 满足恢复条件及预算时自动尝试 |
| 短时限流 | 遵守 retryAfterMs；等待超过剩余预算则停止 |
| 暂无可用账号 | 仅号池明确标记暂态且再次请求有恢复路径时尝试 |
| 401/403、额度不足 | 默认终止；只有明确的号池轮换恢复证据才考虑专用例外 |
| 配置、输入、权限错误，未知失败，结果未知 | 不默认自动重跑 |
| 取消、卸载、期限耗尽 | 停止当前执行与退避，不再发起尝试 |

长任务经常在执行工具后断线，不能把“首次工具之后永不恢复”写成已满足长任务需求的完整方案；也不能直接重放整个原始任务。必须区分：尚未产生副作用的重试、确认终态后的会话续接、状态未知时的核查。

首期已覆盖明确暂态失败且尚未出现任何 tool_call.* 或 interaction.requested 的请求。失败必须具有 Codex 来源、retryable=true 及 OH-PRV-4005/4006 之一，不能只凭 message 猜测。工具执行后的自动恢复仍需可核查的执行状态、幂等或去重依据；同一 Codex thread 本身不保证副作用恰好一次。读操作也不能仅凭工具名称推断安全。该部分仍待实施，不能把保守首期描述为长任务中途恢复已完成。

## 尝试、会话与展示

- 一条 IM 业务请求关联多次尝试，沿用原触发身份，每次 invoke 分配新的 runId/invocationId；区分 Provider 内部重试计数与 Extra 尝试计数，不混用诊断字段。
- 本轮输入及业务 Context 由 Extra 固定快照。再次调用是否需要新增恢复指令或背景由 Extra 明确构造；Host 不从旧 Event 补材料。空模型 Context、显式重复项和执行配置保持既有合同。
- 使用真实返回的 Provider binding，明确处理 resumed/fresh_fallback。恢复失败后不能静默新建会话并声称恢复任务；需要背景时由 Extra 决定提供，不能自动重放已完成步骤。
- 同一业务请求维持统一进度展示，中间失败保留尝试身份，恢复期间不发送最终失败文本；成功或停止恢复后只产生一个逻辑最终结果，投递重试不重新执行模型。不同尝试的文本不能直接拼成一个答案。
- 停止按钮指向当前活动尝试，并能取消退避等待；旧交互失效，不能把上一尝试的审批自动交给下一尝试。卸载停止全部任务和定时器。
- 保持既有 reset 不等于取消的合同：旧任务保留冻结身份，迟到更新不得写回新 binding；reset 已实现停止旧任务后续自动尝试，不取消正在执行的尝试，Provider 内部恢复仍受预算约束。
- 长任务存活期间维护有界在途记录，不能让现有 120 秒 occurrence 窗口过期后重复接纳同一活动任务。终态后保留期限、卡片重试和资源释放须一并验收，不引入 Host 持久业务库。

## 实施顺序与验收

1. 对照实际启动版本、Bot 配置和每轮有效限制确认线上时限，修正 Channel Gateway 默认值和 Bot 校验；检查 Host 输入准备未覆盖一天设置。同步配置说明与示例，保留显式短期限。
2. 从 im-test 收集不含凭据的 Codex 失败样本，确定统一失败证据、筛选白名单及预算参数。必要的可选协议扩展同步 schema、生成类型及消费者，不机械升级 Run 7 / Context v3。
3. Extra 增加任务级尝试编排、独立总期限、连续恢复预算和累计次数上限；覆盖 Provider 自身重试与 Extra 重跑两条路径。完成中途恢复边界后再开放相应场景。
4. 自动化使用 fake Provider 与可控时钟：超过 120 秒和 10 分钟仍能有效执行；一天边界取消；显式短时限生效；反复 retry notice 无有效进度时受恢复预算限制；反复少量进度不能绕过全任务上限；重试不重置总期限。
5. 覆盖工具副作用、NDJSON 退出、Host 流断、续流、结果未知、Provider resume 失败、号池错误、限流、取消退避、reset、卸载、多 Bot 隔离、旧卡片和在途消息去重。验证旧执行尚未退出时不产生重叠执行。
6. 按改动范围运行 build/typecheck/lint/测试，并在 https://im-test.deepminer.com.cn/ 验证真实 IM 收发、长任务与故障恢复；修改桌面接口/UI 时以 CDP 验证真实 renderer。修改协议时同步构建 Worker、Runtime、桌面应用并重启受影响进程。快速时钟测试不能替代真实持续运行证据，也不能写成已跑满一天。

## 待决项

- Codex 号池实际错误形状、原生重试上限，以及账号切换对 thread resume 的影响。
- 工具执行后的安全恢复范围与证据；Host 流断后的同 stream 续流编排。
- 实际部署版本和原“一天”配置来源；真实长任务验收持续时长。

## 首期实施与验证状态

实现位于 execution/task.ts；application 负责单张卡片、当前尝试取消与 reset，transport 延长活动卡片绑定，session-store 保留有界尝试身份。Codex Adapter 根据本机 app-server 生成协议核对 codexErrorInfo，沿用已有 FailureEnvelope 字段，保留原始 error。未升级 Run 7 / Context v3，未新增 Host 业务重试。

真实 Codex 经独立 Host 完成受控 503 → Extra 新调用 → 标记回复成功，故障端实际收到一次请求。im-test 首页 200、无效 Bot 认证 401 已实测；没有可用测试 Bot 凭据，未完成真实 IM 收发或一天持续执行。自动化结果、依赖移除及上线边界见 [验证记录](../../journal/shared/2026-10-15-im-long-running-retry.md)。

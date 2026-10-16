---
type: Journal
title: Gateway 逐项修正与验证记录
description: 按 F 编号独立实施提交，记录真实检查、线上证据与最后集中决策的问题。
tags: [channel, implementation, verification, architecture]
timestamp: 2026-10-16T00:00:00Z
---

# 本次实施授权

用户已明确要求逐项修正、验证、独立 commit，持续推进，需决策的问题留到最后集中提出。最新授权取代本任务此前“仅讨论”的阶段限制；不改变已确认的职责边界，不重建身份、Home 或 Provider 数据，不迁入已排除的旧设计，不创建 MR。

业务目标由 IM Channel 拥有；Channel 只构造真实输入与 Context、执行接线和统一事件投影。Host/Adapter 不增加业务预取或特殊执行流程。F32 按[交付约束](assessment.md#f32-是交付约束如何判定完成)执行。

已读取：基础架构、Context 输入、协议总体设计、Channel、Extra、工程与提交规则；后续按每项实际模块补充专项规则。执行基线 Run=7、Context=v3。

| 项目                  | 实施状态     | 检查与证据                                                                                    |
| --------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| F01 文本引用          | 已实施       | 7 项针对性测试通过；im-test 隔离群实发并读取，确认服务端保留 reply 且投影成功；不解引用       |
| F02 复杂正文          | 留待最终决策 | 原评审未明确批准纳入，不因其他项实施扩大范围                                                  |
| F04 资源 Context      | 接线已实施   | 附件、文档分享及正文文档/网盘地址；28 项回归及 im-test 真实附件回读投影通过，完整取材矩阵未验 |
| F05 已读回执          | 待实施       | 已接纳并开始处理的普通消息，失败隔离                                                          |
| F09 统一交互卡片      | 待实施       | CanonicalEvent 投影及原 invocation 响应                                                       |
| F18 删除规则开关      | 待实施       | 同步两渠道类型、schema、示例及回归                                                            |
| F21 生命周期实机证据  | 待核实       | 只在复现真实违约后修改责任模块                                                                |
| F24 OpenClaw 身份筛选 | 待实施       | 最后一个合法启用的 OpenClaw item                                                              |
| F26 并发与排队        | 待实施       | Bot 工作 64，每 session 另排队 4，两种繁忙公开码                                              |
| F27 ACK 与投递        | 已实施       | 四次 WS 预算、迟到 ACK、独立未知通知；im-test 验证通过，服务端实际显示四份原消息              |
| F28 DSH               | 延期         | 保留稳定后 P1 整体评估                                                                        |
| F31 统一日志          | 核心已实施   | SDK/CLI 可选目录、Extra 日志和内核生命周期；28 项检查及 im-test 真实 Codex 通过，文件策略待决 |
| F32 工程交付          | 随各项验证   | 必要回归、真实验证和文档，最终汇总                                                            |

其他已覆盖/已排除项按[评审表](assessment.md)保持现状；发现真实违约时明确归属并独立记录，不为凑提交制造改动。

## 集中决策记录

F04 已接线，不将 Context 投影成功宣称为所有文档/网盘的模型读取保证；真实文档、网盘取材与权限/过期/工具缺失矩阵尚未完整验收。

- F02 是否纳入富文本/合并转发文本支持，保留原待决状态。
- F31 固定文件名、保留 3 个文件或 3 个小时桶等细节，按原文保留待决，先核实共享写入边界。

## 验证状态

### F31 核心改造已实施

SDK logging.directory、Runtime CLI daemon run/install --logs-dir 显式启用；默认不创建日志目录、文件、计时器或 Worker。ExtraContext 始终注入 log(level,event,data)，加载器绑定真实 extra_type，双渠道函数式和对象式入口均已接入。内核记录 invoke 接收/拒绝/接纳/开始/终态、稳定错误码、取消与 RPC 流结束；接纳、执行终态、流结束分别表达，不把流结束认定为模型成功。

共同格式 time/level/source/event/extra_type?/data。允许字段明确限于 run_id、invocation_id、session_id、adapter_type、model、status、code、endpoint_id、state、protocol_mode，以及 duration_ms、input_count、text_input_count、image_input_count、context_count、attempt、frame_count、conversion_count、working_tasks、queued_tasks。字符串为有界标识，数量只统计当轮结构项数；未知字段与任意对象不读取、不序列化。正文、原始错误、完整配置、环境值、地址、预览、截断及内容哈希均不记录。

专用 Worker 复用既有 HourlyLogWriter，每进程最多 128 条在途、128 个文件序列；写入失败、锁竞争、满额可丢诊断，不影响执行，关闭最多等 1 秒。它不是审计/投递账本。停止 SDK embedded-runtime、CLI service-out/err 的任意原始输出重复落盘与 Host debug/逐帧 trace；必要 stderr 继续由宿主终端或系统服务接收。旧文件和用户 Home 保留，不自动清除。

**文件策略仍待最后决定**：暂沿用 UTC 小时桶 kernel-YYYYMMDDTHH.log 与 extras/<extra_type>-YYYYMMDDTHH.log，当前及前两小时、单文件 100 MiB，原有锁和容量检查保持。未擅自切换固定活动文件名或“当前+最近两个文件”的语义。

日志与生命周期专项 28 项通过，覆盖默认关闭、显式目录、字段/正文隔离、实际 Worker 写入/关闭、队列上限、失败隔离、小时轮转/100 MiB/进程互斥、真实 launcher、SDK 两次账号启停及双渠道卸载。im-test 隔离群授权消息经真实 Extra 加载器和共享 AdapterHost 调用本机 Codex，观察 completed、内核与 Extra 对应日志且不含输入/输出正文。未宣称已验收所有 Provider 或各平台原生服务安装。

### F27 已实施

WS 逻辑回复首次加三次额外发送，每次 ACK 最多等 15 秒，额外等待 1/5/10 秒；正文、地址、clientMsgNo 不变，协议序号独立。明确拒绝停止并记 failed；已有未知事实不能被后来拒绝改成确定失败。迟到成功 ACK 可终止下一次发送，最终 unknown 后另保留 30 秒关联窗口；活动发送最多 64，保留窗口最多 64，不增加持久账本或重连循环。断线结束本连接的投递，沿原连接恢复机制处理，不让旧 Run 的回复迁到新账号。

共享错误码 OH-RUN-2005、阶段 channel_delivery；独立 CanonicalEvent message.create 投影 REST 展示卡，不向已完成的执行流追加 run.failed。REST 保持最多三次原预算，通知使用独立稳定 effectKey，失败只诊断、不递归；主动取消的执行不发送未知通知，卸载关闭所有发送等待。新状态机与投递测试 6 项、连接/容量/真实本地 WS 等相关回归合计 32 项通过；构建通过。

im-test 真实 WS：将成功 ACK 延迟到 15.5 秒，确认只发送一次、下一次重试被取消；另一条回复持续屏蔽 ACK，76 秒共四次发送，未知通知经 REST 发出并回读含 OH-RUN-2005。**服务端实际出现四条相同原回复，不具备本场景的 clientMsgNo 去重保证。** 这符合已确认的有界重发选择，但不能宣传为恰好一次。测试只在既有 Channel_QA_ 隔离群，不重跑模型或工具。

### F26 已实施

Gateway 每个 Bot 最多 64 条工作任务（含准备、工具/交互等待及清理）；每个 session 1 条工作，另排队 4 条。同群不同人共享队列；Bot 满时不再接纳新任务，两项都满优先报告 session 排队满。工作槽位完成清理后原子交给本 session 下一条，或释放给新 session；不存在将所有排队再加到 64 的旧规则。

两类拒收由本地准入 CanonicalEvent 投影独立错误卡片，普通文字并行投递，失败互不阻塞；工作并发满 OH-RUN-2003，会话队列满新增共享目录 OH-RUN-2004。每会话通知冷却 1 秒、最多 64 条在途通知，缓存有界；消息仍幂等拒收，不自动重提。共享目录、调度及 20,000 个双渠道历史 session 回归合计 25 项通过。WeCom 的容量合同本次未扩大修改，仍按其原有专项维护。

im-test 真实 WS 接收隔离群 6 条授权 @ 消息：仅 1 条调用、4 条排队，第 6 条拒收并回读确认繁忙卡片与文字均送达。使用受控执行端持有任务，不启动 64 个真实模型或伪称压力测试。

### F24 已实施

CLI 的 OpenClaw dotenv 同步只选择启用、合法、显式 adapter_type=openclaw 的 Bot，保持配置顺序最后一项优先；后面的 Codex/默认类型不再覆盖，无候选不写文件。不改变普通逐 Run 的独立身份传递。daemon-app 构建及工具环境 4 项回归通过，包含真实 Host 子进程环境隔离、混合配置顺序与无候选检查。仅使用临时 OpenClaw 配置目录，未修改或重启用户的真实实例，不声称运行中 Gateway 已加载新 dotenv。

### F21 生命周期复核

本轮重新执行 IM/SDK 清理专项 16 项，全部通过：双渠道初始化中卸载、活动调用取消并等待、重复清理、真实本地握手、SDK 退出/账号切换及失败传播。未复现需要修改的新缺陷，保持现有整体卸载和共享 AdapterHost 边界。有效 Octo Bot 长工具期间卸载重挂及 WeCom 线上鉴权/中断证据仍未补齐，保持 F21-V01/V02 未验收，不以本地回归抹平实机缺口。

### F18 已实施

删除 Gateway 的 group_rules 类型、校验、schema、默认示例与线上脚本配置；topic_rules 原本无此字段。WeCom 源码/schema 均未发现这些开关，无需制造对应改动。群固定读取群规则，话题固定读取群与话题规则；404 与权限/网络错误保持真实区别。Gateway 构建及引用/资源/历史/协议 28 项回归通过，im-test 隔离群无开关读取并生成规则 Context 通过。

### F09 首版已实施

CanonicalEvent 驱动独立交互卡；支持多问题、选项、自定义输入、审批与 JSON elicitation，回答回原 invocation。真实身份/地址/消息、有效期、reset 后会话身份及重复响应校验均在现有边界；终态/交互 resolved 收敛按钮。文字入口可提交结构化问题答案，不再把多问题强转字符串。

Gateway 构建、交互与本地真实 WS 回归通过。im-test 创建/编辑收敛通过；曾发现 Action.Submit 缺 id，已按服务端合同修复。真人回调未验：已运行 Work App 当前为非 im-test，脚本以 TEST_ONLY 拒绝，未切换用户环境。含 isSecret 的问题拒绝在普通聊天卡片收集；需安全输入产品路径才能覆盖，不把普通文本框宣称为秘密输入。

### F05 已实施

普通任务开始处理时异步回执，不阻塞 Context 和执行；排队尚未开始、被过滤、重复和容量拒绝均不调用。Gateway 构建通过，已读/任务/真实本地 WS 回归 13 项通过；im-test 隔离群指定消息的 readReceipt API 接受成功（`--read`）。API 接受不等于真人已读或客户端已展示。

F01：Gateway 构建通过；引用与初轮历史 7 项测试通过。`scripts/verify-im-context-live.mjs` 在 im-test 已有隔离测试群发送测试引用、以接收 Bot 身份回读并生成 Context，断言通过。测试 Bot 间 DM 因非好友被服务端拒绝，未改变授权；群验证通过不代表 DM 已实机验证。未运行模型，不将 Context 接线成功写成模型理解保证。

# 工程知识变更记录

## 2026-10-19

- [历史 Gitleaks 告警处置（Issue #22）](tasks/gitleaks-history-triage/brief.md)：45 条误报已核验并添加精确历史例外，19 条新增 canary 被拦截；完整历史与 PR 模式验证通过，见[验证记录](journal/shared/2026-10-19-gitleaks-history-triage.md)。


## 2026-10-18

- 用户确认推荐参数后实施 Provider 输出容量修复：中央默认策略为原始消息 16 MiB、HostFrame 20 MiB、Adapter/RPC 队列 32 MiB / 4096、单 Run 重放 32 MiB / 4096、全局重放 128 MiB，硬上限为默认值 2 倍；覆盖仅来自受信 Adapter execution 配置。容量失败改为精确、不可重试的公开分类；Channel 256 KiB 经核对只统计公开消息文本，本次不改。专项 62 项通过 61、条件跳过 1；全量 WebUI 35/35、Node 1149 通过/9 跳过，构建、lint、命名、格式和 diff 检查通过。真实 Provider、并发内存和三平台 CI 尚未验收，详见[本地交付记录](journal/shared/2026-10-18-provider-stream-limits.md)；实现已形成 topic branch 提交。

- 合并前双轴审查修复四项阻断：HostFrame 超限保留精确控制原因，Gateway 主错误区与两个 Channel 最终文本直接显示公共码/诊断编号，低全局覆盖不再淘汰兄弟 Run，并同步纯执行与输出协议权威规则的新容量合同。新增对应回归；跨仓 Worker/Harness/桌面及 im-test 真实 Provider 仍列为未执行的发布验收。

- 从 `main` commit `4fa5a8a` 建立独立 worktree，新增[Provider 输出流容量与错误分类专项规划](tasks/provider-stream-limits/brief.md)。确认 412,123 bytes 合法消息仍触发 `STREAM_EVENT_TOO_LARGE`，并误分类为可重试的 `OH-PRV-4099`；清点 Provider 原始行、Adapter 队列、HostFrame、RPC 队列、重放窗口和 Channel 展示边界，排除输入请求、图片和配置大小等同值但不同合同。规划给出 M0-M7 分步评分、自动化/真实验收矩阵及 D1-D6 用户决策；当前总体可执行性 86/100。仅写规划，未修改产品代码、配置或运行环境。

## 2026-10-17

- 实施[群准入合同修复](journal/shared/2026-10-17-channel-group-admission-delivery.md)：groups_enabled 独立启停，group_ids 省略/null/[] 不限制范围，非空限制父群；不保留旧空名单语义。Schema、整体设计及 CLI/SDK 指南同步，owner/Space/真实 @ 等授权保留。11 项定向及全量 Node 1074 通过、9 跳过，UI 35 通过；im-test 的 CLI/SDK 群和话题真实收发通过，12 条输入、7 次测试 Adapter 执行，模型调用为 0。dc73c28 已推送、发行隔离验收和本地全局安装通过；原前台进程待重启，第三方宿主升级与实际模型尚未验收。

- 调查阶段建立[群聊明确点名无响应事故分析与处理计划](tasks/channel-group-admission/brief.md)：CLI/SDK 共用 Gateway 在 group_ids 省略时拒绝所有群/话题，默认 CLI 示例与 Schema 因而失效；问题早于本轮 SDK 改造。新增 3 项准入/transport 回归按预期失败，im-test 既有真实历史 payload 的只读重放复现，未发送消息或调用模型。记录 owner 默认说明错误、临时显式群范围止损、逐阶段修复与真实入口验收、宿主升级/回退和事故关闭条件。当时不改业务代码、用户配置或安装，后续实施见上条记录。

- 完成[宿主函数装配的本地 SDK](journal/shared/2026-10-17-sdk-host-extra-contexts.md)：三参数 loadExtra 接收模块、JSON 与业务函数，SDK 管理内部 loader、独立执行端口、状态、控制归属及完整生命周期；原 JSON descriptor 路径保留。整体架构与接入指南解释两阶段返回函数的目的、初始化与逐轮读取的区别，以及同步/异步 SQLite 的阻塞和取消边界。新增 13 项 SDK 和 3 项取消测试；构建/类型/lint 通过，全量 1069 通过、9 跳过、WebUI 35 通过。第三方 App/demo 按用户要求暂不修改，未新增真实 IM/Provider 或 SDK 长期内存验收。

- 按用户要求将[SDK 动态 Context 计划](tasks/sdk-host-extra-contexts/brief.md)收敛为宿主完整接入流程：Buddy / 自研 CLI 经统一 SDK 启动、传函数、更新数据、查询、重载和退出，自带 CLI 保持 JSON。SDK 内部装配和竞态检查移入附录，移除额外 npm 分发前置条件；撤回内部加权 40 分作为整体 SDK 完成度，按 H01–H06 记录已有和待接能力。接入指南移除让宿主自建 loader 的示例，目标入口仍未实施，必要性与可执行性均 100。本轮仅文档，不修改 Runtime 或 demo 代码。

- 按用户强调补充[Channel 逐轮加载宿主 Context 专题](guides/channel-dynamic-contexts.md)及[SDK 指南第 7 节](../SDK_CHANNEL_GATEWAY_GUIDE.md#7-逐轮加载-agent-系统提示词与业务-context)：函数引用初始化一次，宿主业务数据每轮读取，数据更新无需重载；同 key 动态整项覆盖静态项，固定人设需显式保留。同步架构/Extra 规则、原计划、README 和中文核心注释，区分当前 loader 与延期 SDK 接线，以及系统指令的 Provider 会话边界。构建、类型、lint、严格 TS 示例、相关回归及一万次强制 GC 加载通过，详见[验证记录](journal/shared/2026-10-17-channel-dynamic-context-docs.md)。

- 按用户纠正统一 WebUI 包与目录为 `octo-runtime-extra-webui`，同步 workspace、锁文件、Schema、构建/打包引用、测试和当前指南；Extra 名称与配置目录仍为 webui，不保留旧包别名、不改写用户数据。按用户补充要求，为两阶段入口、动态 Context 覆盖、实际在途额度、取消和清理失败边界补充中文注释。历史命令保留原始名称，现行链接指向新目录，验证见[记录](journal/shared/2026-10-17-extra-webui-rename.md)。

- [Extra 两阶段入口实施交付](journal/shared/2026-10-17-extra-initializer-delivery.md)：共享 loader、Gateway/WeCom/WebUI 三个 CLI Extra、动态同步异步 Context 及 text-only 指令已落地，配置 Schema 和完整使用示例显式携带固定人设。双渠道移除重复执行解析，超时回调未结束继续占额，取消及卸载有界；强制 GC、一万次加载、双渠道各一万会话、发行包离线加载及 im-test 真实 Codex 通过。用户最新指定 SDK 接入先不改，HostApp 函数装配延期；不自动重写既有配置或身份。完整检查和未验范围以交付记录为准。

- 用户澄清第 3 项能力区别已确认，第 4 项生命周期只是初步想法、需工程评估。补充[生命周期分工评估](tasks/extra-initializer-context-dependencies/design.md#生命周期分工的工程评估)，建议保留宿主通知、SDK 协调、Extra 内部清理，规定单个卸载仅取消自身任务、初始化前置 abort、整体有界清理后继续关闭所拥有的 daemon，失败如实汇总。更正前条将初步想法写成已确认细节的表述；5 秒宽限为待验证的设计初值，未实现或实测，仅文档。

- [Extra 评审确认](tasks/extra-initializer-context-dependencies/brief.md#2026-10-17-评审确认)：用户同意 SDK 同进程装配和两阶段初始化，明确宿主通知单个 Extra load/unload 或整体停止、SDK 协调、插件内部清理。区分新增业务 loadContexts 与既有模型执行端口，后者由 SDK 接线，不要求业务实现。确认不保存历史动态结果、有界在途及内存增长验收目标；保留 86 分历史评估，尚未实现或实测。仅文档。

## 2026-10-16

- 按 technical-writing-zh 新建[Extra 两阶段初始化与动态 Context 详细计划](tasks/extra-initializer-context-dependencies/brief.md)，附接口装配选型、内存合同及逐模块评分。采用纯 JSON config 与独立函数依赖，动态回调可同步或异步，明确整项替换、无历史缓存、真实未结束调用限额和卸载失败边界。用户本次明确支持破坏性更新，不考虑旧接口兼容；默认正文修订为“我是明略科技的Octo助理”。准备度 86，SDK 同进程装配须先验证；仅文档，未改产品代码或运行配置，未做新增内存或线上功能测试。

- 新建[IM Agent 默认人设与 Context v3 简化计划](tasks/im-agent-persona-and-context-audit/brief.md)及[逐项评估](tasks/im-agent-persona-and-context-audit/assessment.md)：默认 IM 配置与完整 CLI/Extra/SDK 示例逐 Bot 显式写入“我是Octo助理”；保留 text 列表、完整移除 instructions.source，关联已有统一准备修复。区分无兼容解析、活动配置升级与历史快照保留；审查 MCP 引用、旧同步类型、catalog、路由常量、业务合并与旧限额开关。仅计划与源码评估，未改产品代码或配置，未线上调试。

- 补充[准备失败及相邻 catch 的隔离排查](journal/shared/2026-10-16-im-invoke-preparation-lessons.md#同类错误的补充排查)：Octo 七种准备故障均只回通用文案、未 invoke 且未创建展示；instructions 之外还复现 Runtime selection 被 Extra resolver 拒绝。核对规则 403/404、非法 MCP，并复现双渠道会话读取失败无回复、展示初始化异常、明确 Host 拒绝被误报结果未知及 WeCom 任务诊断污染连接 error。更新计划与验收；无线上请求、Provider 调用或产品代码改动。

- 按用户要求沉淀[IM 预置指令故障与架构经验](journal/shared/2026-10-16-im-invoke-preparation-lessons.md)，刷新 IM Agent 指南的责任矩阵与调用图，并补充架构、Context 和 Channel 规则。区分读取 adapter 与解析执行计划、普通 Context 与会话初始化指令、连接绿点与执行状态；明确局部复现证据、CLI 差异未完整重放及待实施范围。仅更新 Octospec，不将计划标成代码已完成。

- 新建[统一执行准备与简化指令协议计划](tasks/unify-execution-and-simplify-instructions/brief.md)：核对 Extra 重复解析与 Host 已有共享准备路径，局部复现 `LOCAL_CONTEXT_TYPE_UNSUPPORTED: octo.control/instructions`。按用户决策规划 Extra 直接 invoke、entries 只留 text 且单换行拼接、删除 source 不兼容；列出全 Adapter 会话语义、错误展示和消费者升级验收。仅规划，未改产品代码或运行配置，未进行 Provider / IM 功能联调。

- 澄清 [F32 的约束性质与完成口径](tasks/gateway-august-feature-assessment/assessment.md#f32-是交付约束如何判定完成)：建议作为各改造共同引用的交付验收约束，不新增独立产品功能或默认改 CI。逐项确认场景、完成必要检查/真实验证并更新变化的说明与版本证据；必要未验项继续待验收。可执行性已为 100，目标 100% 不等于当前通过率，必要性 65 不需要追成 100；仍待用户评审，仅文档。

- F31 改造方向按用户要求收束为已确认纳入计划、待实施，具体接口名/文件名/保留口径仍待细化；开始最后一项 [F32 工程验证与操作说明](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf32-工程验证与操作说明)。核对旧漏 build 修复与当前测试前构建、CI、SDK/双渠道生命周期回归及操作文档；建议复用现有工程体系，验收随各改造完成，不迁入旧 Worker/known-bot 模型。必要性 65、可执行性 100、目标建议 100%；撤销原无具体障碍依据的 95 分。F32 待评审、本项后剩 0 项，仅文档，未运行功能测试或线上调试。

- 补充 [F31 日志内容边界](tasks/gateway-august-feature-assessment/assessment.md#日志内容边界用户已明确待实施)：用户明确 Adapter Context 最多打印安全白名单摘要，核心 input 和其他 Context 仅记录本轮结构项数；内核与 Extra 均不转储正文、完整配置或原始错误对象，不以预览/截断/内容哈希替代。记录减少数据量、序列化开销及正文结构耦合的收益；仅文档，未实施，其他接口与轮转建议仍待评审。

- 按 technical-writing-zh 重评 [F31 改造的架构价值](tasks/gateway-august-feature-assessment/assessment.md#当前改造评估)：用户提出内核执行/Extra 业务两类结构化日志、ExtraContext 注入 log、CLI/SDK 默认关闭且启用须指定目录。记录统一责任、关联身份、插件封装和轮转复用的收益，必要性 80、技术可执行性 100；候选接口、basename、3 个文件保留口径待定，未实施。澄清现有小时桶已轮转、playboard 不等价于历史日志、SDK/CLI 外层捕获角色相近但启动链不同；不能因合并而吞启动/崩溃诊断。此前 console-only 建议保留为历史调查，仅文档。

- 补充 F31 六类具体诊断输出缺口：入站容量、Context/本轮处理、交互/reset/取消、投递/卡片、未知结果/停止、会话状态/清理。最小建议为现有 onDiagnostic 接结构化 console/stderr，由宿主既有机制收集，不新增文件、logger 公共接口或存储层。方案可执行性改为 100，纠正以尚未选定输出方式扣至 90 的评价；未实施、不标完成，仍待用户确认。仅文档。

- 开始 [F31 日志评审](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf31-日志归属与-bot-诊断输出)：旧 slice.log 对应每 Bot 独立进程，建议不复制；日志存储与平台归宿主。核对现有小时容量和 Bot/Run 诊断字段，同时发现默认 Extra、对象模块未接可选 onDiagnostic，不以字段存在冒充实际输出。建议评估默认入口的最小脱敏诊断接线，必要性 40、可执行性 90；方案待确认、不改接口或代码，仅文档。本项后剩 F32 一项。

- 用户补充 [octo-cli 的定位和价值](rules/architecture.md#octo-cli-的业务定位与产品价值)：业务团队共同维护的 Go 二进制程序，提供 Octo 各业务子系统 API 调用能力。记录宿主预置后在 ChannelGateway IM 中通过 Agent 工具循环完成取材、业务操作和交付的产品价值；用户评价为体验上的质的提升，不写成实测结果。工具归业务团队，装配归 HostApp，通用执行归 Runtime；保留显式安装和 Context/凭据边界。同步渠道、决策与评估入口，仅文档。

- 消除“官方 CLI”歧义：限定为 Runtime CLI（`octo-runtime` 可执行程序，通过 `npm install -g @mininglamp-oss/octo-runtime` 安装），与业务工具 octo-cli 分开；包名根据本仓 package.json 核对。同步架构、Extra 规则、F30 及配置责任记录，仅文档，未安装任何包。

- 用户进一步明确接入定位：SDK 是主要方式，Buddy 等宿主由其他团队维护；官方 CLI 只是 Runtime 团队基于 SDK 维护的开箱即用特殊宿主。纠正将 CLI 与桌面视为封闭两类或以 CLI 为架构中心的表述；CLI 的配置、目录和运维约定不成为其他宿主的依赖。同步架构、Extra 规则与 F30 决策，职责覆盖与评分不变，仅文档。

- F30 用户明确[两类宿主与凭据保护责任](journal/shared/2026-10-16-host-config-source-boundary.md#f30-补充两类宿主与凭据保护归属仅文档)：默认 CLI 是 SDK 的 headless 宿主，管理自己的 JSON；Desktop HostApp 管理 Token 获取、授权流程、认证状态、存储保护和更新，再构造 Extra config。SDK/Extra 校验消费值并完成接入认证，不接管宿主凭据存储，框架内部安全合同仍有效。职责目标/当前 100%、标删除线，必要性 0、可执行性 100；纠正将宿主安全证据不足算作 Runtime 缺口的前次评价。同步架构责任表、Extra 规则及评估记录，仅文档；下一项 F31，剩 2 项。

- 开始 [F30 本地文件保护评审](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf30-本地文件保护与旧-gateway-目录体系)：拆分必要的文件保护与旧目录/claim 机制。核对 CLI、SDK secret 和 OpenClaw .env 写入，建议保留现状，不迁入旧目录体系；必要性 0、可执行性 90，说明路径威胁边界及 Windows ACL 证据限制，撤销原混合 70% 口径。不把未核对项认定为代码缺陷；待用户确认，不标删除线。本轮仅文档，本项后剩 F31/F32 两项。

- 按用户要求补充 [F29 架构收益与旧设计教训](journal/shared/2026-10-16-kernel-extra-tool-boundary.md)：确认设备执行内核 + Extra + 外部工具满足本项目标；记录权限含义、内核复用、分别演进、减少重复状态及故障归责的收益。说明旧准入、Provider 权限映射与业务 broker 耦合的问题，禁止借功能对齐恢复混合控制和业务代执行；同步基础架构、渠道规则及任务入口。保留 F24 缺陷与原生权限证据限制，只更新 Octospec，未实施代码。

- F29 用户确认当前权限职责划分清晰，旧方案杂糅不同责任，不新增混合权限层。明确 Extra 准入、ChannelGateway 的 Bot 工具身份、AgentRun 统一 approval_policy 三类边界，工程评估同意；full_access 不扩大 bf_token 资源权限，独立 MCP 配置/OpenClaw 启动环境按既有合同。三类职责目标/当前覆盖 100%、标删除线，必要性 0、可执行性 95；旧 tier/broker 排除，F24 既有缺陷继续待改。同步规则和评估，仅文档；下一项 F30，剩 3 项。

- 开始 [F29 权限分档与工具网关评审](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf29-权限分档与工具网关)：旧 tier 是实际策略/原生参数映射，broker 另有业务代理职责，不能与功能标签删除混同。建议不迁入，保留 Channel 准入、统一审批、Provider 权限、Agent 工具及服务端 ACL；标准 MCP 不在排除范围，Context 不替代授权。本轮不改 IM 默认 full_access。必要性 0，推荐方案可执行性 95；原 0 分只表示旧体系不合架构，不是技术不可实现。待用户 review，不先标确认或删除线，仅文档；本项后剩 F30–F32 共 3 项。

- F28 用户对旧 DSH 接入提出异议，明确登记为[独立 DSH Adapter 整体评估](tasks/dsh-adapter-assessment/brief.md) P1 遗留 TODO，当前不实施；P0 为整体架构与内核稳定性，稳定后再安排专项。只确定独立 Adapter 架构方向，原生入口、版本、具体方案及功能范围待整体评估。旧 50 分保留为历史初评、须重评，当前实施必要性/覆盖均为 0，不以此表示未来排除。只新增和更新 Octospec，未启动原型、安装、测试或运行修改；后续 F29–F32 共 4 项。

- F27 用户确认重试口径：WS 首次之外最多额外 3 次，等待 1/5/10 秒，单次 ACK 15 秒，全超时发送阶段约 76 秒。最终未知时 REST 独立错误卡片及专用公开码；相同消息标识、迟到成功 ACK 停止后续尝试、取消及期限、未知不被后次失败反证、错误卡片不递归均记入计划。执行与投递终态分开，沿通用事件投影，不重跑 Agent/工具；去重与 ACK 原因须核实。必要性 80、可执行性 90、目标 100%，方案已确认但未实施，无删除线。本轮仅文档，后续 F28–F32 共 5 项。

- 继续 [F27 分层重试评审](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf27-入站频率429-与分层重试)：普通回复 WS、卡片 REST、业务工具各守责任边界。核对 WS ACK 拒绝以普通 Error 抛出，投递层按非 HTTP 错误归 unknown 并重试，撤销此前当前覆盖 100% 的建议；提出结构化发送结果的局部修正，必要性 80、可执行性 90、目标 100%，待用户评审。旧 QPS 桶必要性仍为 0；不重跑 Agent 或工具，不编造 ACK 原因语义。仅更新文档，未实施或调试；本项后剩 5 项 F28–F32。

- 按 technical-writing-zh 补齐 [F26 定义与具体例子](tasks/gateway-august-feature-assessment/assessment.md#f26-定义与具体例子)：固定 Bot/逻辑 session/任务、工作与排队计数及生命周期，用 E01–E13 展示单群、跨群、两类繁忙、双重满、释放、工具等待、拒收后不重提及不同 Bot。明确“20 个 session 各 1 工作+4 排队”的并发为 20，非混合总量 64；示例作为后续验收依据，不声称已实现或已测试。本轮仅文档。

- F26 按最新命名拆分目标：“Bot 最大工作并发数 64”只统计工作中任务，“单 session 最大排队任务数 4”不含正在处理的 0/1 条。A 工作、B/C/D/E 排队、F 拒收，替代此前总量 4 的歧义例子。现有 Bot 混合 pending<=64 仅为源码现状，必须调整；两类繁忙卡片＋文本同文案、不同共享公开码，会话排队新码待目录分配。必要性 85、可执行性 90，记录调度及验收建议，未改代码。

- 开始 [F27 分层重试评审](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf27-入站频率429-与分层重试)：保留已有 REST 429、消息投递及既定 Codex 安全恢复建议，不新增令牌桶。纠正旧入站限速实际按 Bot/accountId 的源码口径；不混淆 F26 容量保护及各层尝试次数。必要性 0、可执行性 90、既定范围建议覆盖 100%，待用户确认；真实 IM 限流注入及工具后恢复边界保留。本轮仅文档。

- F26 用户确认补满载拒收的独立错误卡片＋普通文案“当前智能体繁忙，请稍后再试”，卡片明确未受理，复用统一容量错误码 OH-RUN-2003 及诊断编号。记录共享分类映射、本地准入失败 CanonicalEvent 投影、两路独立投递和验收要求，不创建模型任务或自动重提；标已确认改动、待实施，不加删除线。本轮仅 Octospec，下一项 F27，剩 6 项。

- 开始 [F26 队列与过载反馈评审](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf26-有界队列执行期限与过载反馈)：确认每 Bot 64 条包含运行中与排队；一天执行期限从首次 invoke 起，不含排队/准备。源码满载拒收仅诊断，建议补有界、限频的独立用户提示；必要性 65、可执行性 95、目标 100%，待用户确认。未改代码或做线上满载调试。

- F25 用户确认尊重明确授权，不额外拒绝已授权 Bot；目标/当前覆盖 100%、标删除线。澄清当前名单同时用于私聊与群/话题、回复按原频道权限可见；双方持续互相 @ 的循环归协作模型边界，不新增 Channel 防环流程。同步渠道规则和评审状态；下一项 F26，剩 7 项。本轮仅文档。

- 重写 [统一设备讲解](../ARCHITECTURE.md)：以三图说明旧 IM 内连 OpenClaw Channel、通用设备底座及本地 IPC / 异地云端寻址目标。指出旧链路执行位置隐含于 Bot / Channel；旧 Loop daemon 另作业务耦合反例。明确设备为特定 Home 承载的实例，区分 machineId 与虚拟 runtimeId；统一远程寻址和共享访问 Extra 仍待实现。本次仅文档，见[任务](tasks/unified-device-explanation/brief.md)。

- F24 用户确认需要修正 OpenClaw 实例身份候选：只取同实例最后一个合法、启用的 adapter_type=openclaw 配置，用户可调整顺序选择；其他 Adapter 各用自身配置覆盖进程默认身份。现有同步循环缺少 Adapter 筛选，标必须修改、不加删除线；仅记录计划，未实施。开始 [F25 授权与 Bot 防环评审](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf25-已知-bot-过滤与防互触发)，建议不额外否定已授权 Bot，待用户确认。

- F23 用户确认现有 Provider 环境合同覆盖 100%，标删除线；OpenClaw 使用实例固定 .env，不修改上游或新增特殊 session.create 注入。开始 [F24 CLI 身份评审](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf24-cli-身份与-shell-rc)：建议保留现有路径，不迁入旧 shell 管控；补列已有真实 Codex/CLI 证据与完整入站、真实 OpenClaw 加载待验范围，等待用户确认。本轮仅文档。

- 补充 [F22 在线状态归属](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf22-就绪状态连接状态与单实例锁)：客户端维持 WS、协议心跳与本连接恢复，云端维护在线状态并刷新 Redis；拒绝客户端在线账本、全局控制及新增 REST 心跳。同步渠道规则及评审元数据；服务端职责按用户确认记录，本轮仅文档，未重新验收 Redis 实现。

- 重写 [SDK 操作指南](journal/shared/2026-10-16-sdk-action-guides.md)：新增完整原生与 Channel Gateway 两篇，先给 submodule、Codex/OpenClaw 依赖与可编译主进程示例，Gateway 提供配置文件及串行保存/重载；旧入口仅作导航。

- 按用户最新要求[清理旧凭据配置残留](journal/shared/2026-10-16-host-config-source-boundary.md#后续清理不考虑旧配置兼容)：删除两个 file-config 模块、旧文件权限错误分支，不保留路径转发、兼容解析、迁移或回退。重跑构建、Node 1018 通过/8 跳过、UI 35 通过、类型、lint、发行包残留检查与 im-test 只读认证通过。

- 固化[配置来源归宿主的架构边界](journal/shared/2026-10-16-host-config-source-boundary.md)：宿主负责 JSON/SQLite/Nacos 等来源并传入实际值，SDK/Extra 只校验和消费。移除两个 Channel 的 bf_token_file / app_secret_file、类型、schema 与凭据文件读取，后续不为配置来源扩展业务字段。构建、类型、lint、Node 1018 通过/8 跳过、UI 35 通过、六份发行 schema 及 im-test 两账号只读认证通过。

- 拆分 [CLI 使用与 SDK 原生接入指南](journal/shared/2026-10-16-cli-sdk-guides-split.md)：CLI 面向云端设备定制接入与运维，默认包含全部 Adapter、Extra 及系统管理、自启服务；Electron/Tauri 2 桌面程序必须 SDK 接入。原 INTEGRATION 仅作导航，迁移现有示例和当前文档链接，本轮不修改运行代码。

- 完成[三个 Extra 原始配置 Schema](journal/shared/2026-10-16-extra-config-schemas.md)：覆盖固定 module、enabled、完整 config 及嵌套用途和条件，说明 Provider Agent ID 与平台身份区别；业务方自行选择校验工具，不改变 JsonObject 加载。公开与内置文件随单包交付；构建、类型、lint、Node 1017 通过/8 跳过、UI 35 通过及仓库外离线安装验证通过。未改执行逻辑或进行线上联调。

- 完成[executionFeatures 全量清理与自动验收](tasks/remove-execution-features/delivery.md)：三个仓库逐 Feature 提交推送，移除自建字段、常量、默认数组、发现/加载及标签准入，修复watchdog、Codex MCP窄覆盖和错误分类。新发现的桌面基线问题先独立评估再修复；正式im文档与配置已同步。Runtime1001通过/8跳过、WebUI35通过、桌面/kit2555通过/2跳过，Worker测试构建和离线发行验证通过。真实Codex文本/图片/审批/取消/MCP及重启后renderer通过；远端部署、未启用Provider和OpenAPI基线漂移分别记录，不宣称已验收。

- 确定[资源地址 Context 与按需取材架构](journal/shared/2026-10-16-resource-context-access-decision.md)：文档、网盘和内部附件提供地址及真实获取指引，由 Harness 内的 Agent 根据任务调用工具，Host/Adapter 不预取或管理业务资源。与首轮原生图片输入分开；修正 F04 评估为资源 Context 目标，必要性/可执行性各 90、目标覆盖 100%。同步架构、Context 与 Channel 规则；本轮仅文档，未改代码或进行线上验收。

- 建立[全自动清理与关联缺陷修复计划](tasks/remove-execution-features/autonomous-plan.md)，纳入 MCP 配置回灌、错误误分类和 watchdog 进度/暂停计时问题；独立首评三项 94 未通过，补齐提交快照、前置依赖和远端部署边界后[复评](tasks/remove-execution-features/feasibility-review.md)均分 97.125、最低 96，达到用户要求的实施门槛。

- 完成[F4 computer-use 标签专用探测删除](journal/shared/2026-10-16-remove-computer-use-probe.md)：删除 Codex 配置扫描、同步异步 helper 和专用依赖，补齐创建不读配置的回归；构建、类型与 lint 通过，全量 930 通过、8 跳过，真实 Codex 原生命令请求 im-test 并返回校验值。仅 F4 完成，真实 Home 的动态 MCP 配置类型错误仍待单独处理。

- 实施[本地 WebUI Extra](tasks/runtime-webui-extra/brief.md)：删除旧 SSE demo，新增 `octo-runtime-webui-extra`，端口 `13888`；从 Work App 移植交互源码、样式、图标和 35 个行为断言，完整 canonical SSE 在前端投影，复用共享 Host。项目使用 sessionStorage，WebUI 独立 JSON 最多保留 100 个会话和完整 Provider binding，支持淘汰、刷新、单条/全部清理。真实 Codex 文本/续聊/审批工具/取消、桌面/手机页面与仓库外安装通过；线上测试域名返回 HTML，既有线上连接共存未验，见[记录](journal/shared/2026-10-16-runtime-webui-extra-delivery.md)。

- 建立[executionFeatures 清理开发计划](tasks/remove-execution-features/brief.md)：依据实际消费拆为七项，列出修改位置、依赖、失败行为、验收及 100 分制开发准备度；明确桌面标签筛选、Worker 必填字段和 watchdog 活动判定均为真实依赖，先调整消费者再移除生产字段。本轮仅计划，不宣称实现或线上验收完成。

- 固化[宿主管理 Adapter 支持范围的决定](journal/shared/2026-10-16-adapter-forwarding-ownership.md)：`executionFeatures` 确定为待删除的过度设计，不新增标签或替代能力表；Adapter 负责明确输入的原生适配转发，运行状态及必要协议校验按实际执行边界处理。同步架构、Adapter 规则和开发指南；本轮仅更新 OKF，源码清理与线上验收未实施。

- 新建[旧 Gateway 八月特性评估计划](tasks/gateway-august-feature-assessment/brief.md)：固定旧仓 HEAD，保存 170 条非合并提交台账，对照当前 Runtime 工作树列出 33 项特性、同步必要性、执行/模型材料的传递边界与候选验收。未定位历史使用方锁定 SHA，未将旧 HEAD 当作部署版本；本轮只保留 OKF 文档和入口，不保留代码改动、不执行线上联调。
- F09 已确认纳入后续改动计划、目标 100%：CanonicalEvent 投影支持选项及自定义输入的交互卡片，respondInteraction 回原模型继续执行，不设临时代码或 TODO。用户明确当前仅记录 Octospec；误启动的源码、测试和新增构建产物均已撤回，现有包产物重新构建以恢复。见[F09 评审](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf09-统一用户交互的-im-呈现与响应)。
- 用户确认 F10 按既定入站 UID/ais 与出站真人点名范围保留现状、不扩大出站 Bot/广播。[F11 跨会话主动发送](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf11-跨会话主动发送) 经用户确认现有 CLI 实际可发送消息，Agent tool call 方案按当前目标已完成、覆盖 100%，标删除线，新增必要性 0、可执行性 98，无需 Channel 硬编码 API。纠正先前把“本轮未独立复测”当作“未实现”的判断；本轮只更新文档，不宣称已完成独立线上验收。
- [F12 文件交付](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf12-本地文件artifact多附件) 已由用户确认目标 100% 已覆盖，标删除线。固化[定制业务流程责任决定](journal/shared/2026-10-16-agent-toolcall-channel-boundary.md)：所有类似的非必要流程通过业务 Context v3 instructions 约束 Agent 工具调用，严禁 Channel/Host/Adapter 硬编码步骤、分支或业务收尾。旧 artifact 自动收集上传属于历史遗留、明确不迁入；工具调用不稳定通过 Context/提示词/技能/工具说明对齐，实际工具合同缺陷修复其责任模块。本轮仅更新规则与记录，不改代码、实际提示词或线上状态。
- 进入[F13 长尾工具评审](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf13-长尾业务工具)：旧 resolve/voice-context/thread 删除同样使用 CLI api，当前通用工具入口与本地服务端路由已存在，按既定范围覆盖 100%、新增必要性 0、可执行性 95，无需 Channel 封装。包含当前项还剩 19 项逐条评审，本项后剩 18 项，跳过 F19/F33；不是待开发项数。本轮只更新文档及本机帮助/源码核对，未调用线上接口。
- 进入[F14 历史与 reset 评审](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf14-群话题历史与-reset-边界)：依据既有用户决定和当前实现，将按旧实现全集估算的 30% 修正为既定业务目标覆盖 100%，标删除线；新增必要性 0、可执行性 95。新会话一次最多 15 条/1500 Unicode 码点，reset 后允许旧聊天，不迁入 SWR/负缓存/watermark。包含当前剩 18 项评审，本项后剩 17 项，跳过 F19/F33；本轮仅更新文档和静态复核，未重跑线上验收。
- 用户确认 F14 保留现状，补充用户意见与工程评估：避免 Channel 自建 SQLite 或其他业务持久库，reset 后保留有限近期频道背景；在当前 IM 目标下减少状态副本及一致性责任，不承诺完整工具或在途任务恢复。进入[F15 持久化评审](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf15-provider-binding-与-transcript-持久化)：新增必要性 0、推荐的有界内存方案可执行性 95，旧业务持久化目标 0% 为排除项。旧参考的 binding/Hermes exchange 主要是文件/JSON，不一概称为 SQLite。包含当前剩 17 项，本项后剩 16 项；仅文档及静态核对。
- 进入[F16 工作目录评审](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf16-逐会话工作目录)：延续固定 IM Agent workdir 的既有决定，不采用逐会话目录；新增必要性 0、推荐方案可执行性 98，既定固定目录目标已实现 100%。reset 不切目录或删除产物，任务不能覆盖 Agent 目录；共享文件及并发冲突边界不冒充安全隔离，也不扩大到所有 Host 调用。包含当前剩 16 项，本项后剩 15 项；仅文档与静态核对，未运行线上调试。
- 补充 F16 用户意见与工程判断：旧逐会话目录方案混合 ChannelGateway 与 AgentRun 的责任，新架构必须区分渠道会话与执行工作区生命周期。同步[渠道规则](rules/channel-integration.md)、[责任边界指南](guides/im-agent-invocation-boundary.md)及固定目录决策；业务/宿主确定配置，Channel 组织输入并关联会话，执行层执行既定合同，不从 session/reset 推导目录管理。本轮仅更新文档，不新增 AgentRun 组件、协议或开发任务。
- 进入[F17 人格与技能指引评审](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf17-人格技能说明与自动指引)：按统一 Context 口径，将业务显式选择的人格文本与技能指引传递修正为覆盖 100%、标删除线；新增必要性 0、可执行性 95。不复制旧 catalog、技能扫描、强制注入和 CLI 启动导出；传递说明不等于技能已安装、资源可读或权限已授予。包含当前剩 15 项，本项后剩 14 项；仅文档及静态核对，未更改配置、安装技能或线上验收。
- 用户确认[人格/SOUL 注入架构约定](rules/architecture.md#人格与-soul-的注入归业务方)：人格属于提示词指令，完全由业务方或 ChannelGateway 构造 Context v3，决定内容、顺序与发送时机；底层不读取人格文件、合并默认人格、补历史或按 session 去重。同步 Context、渠道规则与 F17 记录；普通 extra 不自动升为可信控制指令。仅文档，不改变或删除 Provider 原生文件，不宣称本轮已核验全部 Provider 的原生加载行为。
- [F18 群背景评审结论更正](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf18-群规则成员和群信息背景)：用户明确群/话题规则固定加载，不存在开关；必须删除额外参数及相关代码、schema/示例，核对 ChannelGateway/WeCom，不考虑旧开关兼容。撤销原完成与删除线，标记方案已确认、待实施；必要性 90、可执行性 98、目标 100%。当前仅讨论并更新 Octospec，误启动的 10 个源码、配置、测试及脚本文件改动已撤回，错误的实施授权专项已移除；未运行测试或线上验证。讨论和方案确认均不构成本轮实施授权。
- 用户随后要求恢复一项一项评审，并确认 [F19 多 Bot 与环境隔离](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf19-单进程多-bot-与环境隔离)：保留现有架构，不迁入每 Bot Worker/完整 Gateway 执行链。Codex 按 AgentRun 自动注入 bf_token；OpenClaw 同一实例启动时固定一个 Bot 身份为明确接受的例外，不要求逐 Run 切换，不作为欠项。必要性修正为 0、可执行性 95、既定目标覆盖 100%，保留删除线；F24 按各 Provider 的实际身份合同核对 CLI。下一项 F20，剩 13 项；仅更新文档，不新增配置拒绝或启动改动，未重跑线上验证。
- [F20 配置重载评审](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf20-配置监测与局部热重载)已由用户确认：既定目标覆盖 100%、标删除线，必要性 0、可执行性 95；不引入逐 Bot 热更。形成 [Extra 整体生命周期决策](journal/shared/2026-10-16-extra-whole-plugin-boundary.md)，同步架构、Extra、Channel 规则和原责任边界任务。主要单机单 Bot 不存在其他 Bot 连带断线，纠正此前将少数部署代价普遍化的表述；少数多 Bot 重连已接受。用户进一步估计仅约 1% 的用户或设备可能同机多 Bot，比例按业务估计记录；明确函数式加载入口封装内部状态和流程，宿主 App/CLI 只消费完整配置及核心生命周期接口，不接管内部 Bot、连接和 manager，也不另建公开插件对象。SDK 单插件重载与 CLI daemon 重启的范围分别说明；本轮仅文档，不实施或执行线上重载。
- [F21 初始化／停止竞态评审](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf21-初始化停止竞态与资源清理)：核对 loader、manager、runtime、双渠道和 SDK 回归及既有 dispose 修复记录，合同内目标已覆盖 100%、标删除线；能力重要性 100、新增必要性 0、可执行性 95、实机证据充分性评估 85。按用户澄清，补齐上述维度对应的后续改造/验收表 F21-V01/V02/C01，含责任、完成标准、状态和复现缺陷后才修改的条件；正常 Extra 重挂保留共享 AdapterHost，未实际执行验收或修复。用户要求记录后进入下一项，不再等待本项重复讨论。
- [F22 状态与单实例评审](tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf22-就绪状态连接状态与单实例锁)方向已明确：既定目标覆盖 100%、标删除线，新增必要性 0、可执行性 95。用户拒绝为少数场景扩大跨 Bot 全局状态控制；核对旧代码为进程内 Worker 协调和只读状态汇总，不能笼统称为分布式状态中心。保留每个连接本启动周期首次成功后才恢复的合同、真实状态及本地实例保护；不新增全组回滚、全局健康联动或恢复管理器。只读聚合用于展示，局部 socket/signal/错误/退避状态仍必需；普通断网并非只在人为操作时发生。此处“无状态”不授权删除既有身份、Home、配置或 Provider 数据。本项后剩 10 项，下一项 F23；仅静态核对和文档，既有未验范围保留。

- 实施[诊断后无回复收尾](tasks/im-diagnostic-silent-completion/brief.md)：canonical 通过 `run.notice/provider_diagnostic` 保留首条原因，IM 统一选择最终回复；无有效答案且有诊断时卡片/文本均提示待核查，不触发重放。正常执行不增加诊断、模型或网络请求。全量 929 通过、8 跳过，im-test 五场景、真实 Codex 正常执行和桌面 CDP 通过，详见[交付记录](journal/shared/2026-10-16-im-diagnostic-silent-completion-delivery.md)。

- 建立[IM 诊断后无有效回复收尾任务](tasks/im-diagnostic-silent-completion/brief.md)：固定参考 PR #49 的 `5d664fe` 实现与检查结果，明确“Provider 完成”和“IM 可交付回复”的区别；规划有界诊断、统一回复判定、待核查提示与禁止自动重放。保留无文本成功及其他接入产品语义；103 项现有测试与受控探针的证据边界见[核查记录](journal/shared/2026-10-16-im-diagnostic-silent-completion-assessment.md)。本次只落 OKF，未修改功能或执行线上故障验收。

- 将“Runtime 不代替产品决策”提升为[强制架构定位](rules/architecture.md)及[需求范围检查](rules/engineering.md)：SDK/CLI 接入产品拥有模式、思考强度、会话策略与选项展示，Runtime 只执行合同内校验/转发/原生映射。撤回 actmode 计划中的每轮强制恢复 default、会话生命周期选择及跨产品统一体验策略；IM Channel Gateway 不接入 Plan。记录与 mention 越界兜底的共同教训，见[产品意图归属记录](journal/shared/2026-10-16-product-intent-ownership.md)。本次只修正文档，未修改运行行为。

- 按用户后续决定更新[Channel 配置容量计划](tasks/channel-config-admission-bounds/brief.md)：单个 channel-gateway Extra 实例最多 64 个 Bot；撤回 16 个操作/1 MiB 的偏紧建议，改为建议最多 64 个在途管理操作、单份 256 KiB，取消独立累计字节准入。明确 Bot 数量、配置操作数与设备范围各自含义；本次仅文档更新，代码仍为原有 16 Bot 上限。

- 实施 [Channel Gateway Bot 连接状态机](tasks/channel-connection-state-machine/brief.md)：首次失败停止，曾上线后按 5/10/20/30 秒恢复，成功清错误及计数；终端踢线停止反抢，业务诊断不污染连接状态。Work App 后台轮询及 failed 显示同步；im-test 真实收发、重复连接踢旧、双 Bot 隔离与 CDP 通过，合盖待验，见[交付记录](journal/shared/2026-10-16-channel-connection-state-machine-delivery.md)。

- 建立[现有 Adapter 的 Plan 与交互探索计划](tasks/adapter-plan-interaction-exploration/brief.md)：固定默认 Default、Plan 显式选择、Work App 仅测试宿主、不纳入 MiMo/新增 Adapter。记录 Codex 临时配置真机问答及后续撤回应用层私有开关的决定；最终统一启用和模式接入仍待探索，未将实验写成最终实现。

- 按完整 Runtime review 建立[四项整改计划](guides/runtime-long-running-review-plan.md)后，依用户授权在当前 main 分批实施：64 Bot/64 管理操作/256 KiB、OpenClaw 前置过滤与 4096 条/4 MiB、经用户更新的整请求 32 MiB 与独立 Host 图片链、小时日志 3 桶/每文件 100 MiB。已进行定向回归、GC、真实 Gateway 和 im-test 验证；完整检查、平台缺项及 commit/push 结果见[收尾记录](journal/shared/2026-10-16-hourly-log-delivery.md)。

- 在当前 main 分批交付 Channel 决策：真实 UID/ais 准入、Codex 独立图片、新会话一次历史、fixed workdir 校验及 final 真人 Mention。保留有界内存与既有重试，回写架构责任边界；840 项自动化通过，im-test 群/话题、真实 Codex 图片和客户端高亮已验收，详见[交付记录](journal/shared/2026-10-16-channel-features-delivery.md)。

- 将“谁的模块有问题就修谁”写入[基础架构](rules/architecture.md)：从业务意图与协议责任定位根因，生产、传输和消费各负其责，拒绝下游通过猜测正文或放宽准入掩盖上游缺陷。同步 Channel 规则与 Mention 计划，记录[决策依据和评审思路](journal/shared/2026-10-16-contract-responsibility-decision.md)。本次只更新架构文档，不修改功能代码。

- 按用户新决定支持入站 `@所有AI`，新增[真实 Mention 入站方案与计划](tasks/channel-mention-context/inbound-trigger.md)：复用旧 OpenClaw 插件的直接 UID 或纯 ais 判断，all/humans 抑制 ais 路径，拒绝正文名称/标记猜测、免 @ 及代理身份。同步渠道规则、图片专项、Mention 协议和总览，替代此前“仅 UID、广播不触发”的中间结论；模型出站广播仍未开放。本次只更新计划，未修改功能代码或发送线上消息。

- 按用户决定，将群/话题免 @ 明确记为[已拒绝的架构需求](rules/channel-integration.md)：不提供账号、群或会话级开关，不读取外部免 @ 偏好绕过准入，不作为延期项。同步图片及 Mention 专项，避免将旧插件能力误作对齐目标。本次仅更新文档。

- 核对旧 OpenClaw 插件的 mention 门槛及免 @ 例外，按用户要求明确[图片专项](tasks/channel-image-input/brief.md)和渠道规则：群/话题须由本条消息显式 mention 当前 Bot UID，活跃 session、相邻 @ 文本、正文名称及广播标记不放宽准入；先准入再下载图片。当前文本实现已有该门槛，图片尚待实施。本次仅更新文档。

- 按用户澄清，撤回[历史专项](tasks/channel-new-session-history/brief.md)中旧 history_limit 的兼容与迁移要求：项目全新且尚无人使用，直接采用一次补取及 15 条/1500 字符策略，同步配置和测试，不保留旧模式。仅更新计划文档。

- 收敛[新会话历史计划](tasks/channel-new-session-history/brief.md)：IM reset 后仍可补旧聊天，每新 session 只自动尝试一次；失败也消耗资格，空历史继续任务，正常续聊不重拉。最多 15 条纯文本、总计 1500 字符，从最新向更早选取，边界消息保留部分并标记截断。由 Channel 处理并发资格与重试快照，通用 Host 不缓存去重。同步会话规则、相关专项及总览，本次仅文档更新，见[记录](journal/shared/2026-10-16-new-session-history-once.md)。

- 明确 IM 固定目录归属后台配置对应的 Agent，任务 workdir/workspace 不得切换目录；修正渠道规则中“Context 可覆盖默认目录”的历史表述，同步架构、责任矩阵、固定目录记录及总览。区分架构约束与当前 resolver 合并实现，不声称覆盖限制已强制实施。本次只改文档，见[责任边界记录](journal/shared/2026-10-16-im-agent-invoke-boundary.md)。

- 纠正 IM Agent 与通用 `AdapterHost.invoke` 的职责混用，新增[责任矩阵与评审要求](guides/im-agent-invocation-boundary.md)，同步架构、渠道、输入、工作目录及会话规则。将[固定 workdir/reset](tasks/channel-fixed-workdir-decision/brief.md)归类为已接受的 IM 架构决策，不作为功能计划评分；通用目录配置能力不构成 IM 每会话目录需求，IM 固定目录也不限制其他合法调用方。本次仅改文档，见[记录](journal/shared/2026-10-16-im-agent-invoke-boundary.md)。

- 按用户决策收敛 [Mention 计划](tasks/channel-mention-context/brief.md)：模型找不到合适目标时自行降级普通 @名字 或纯文本，不强制追问、不展示点名失败；仅处理 final 文本，代码内容保持原样。发送前点名校验失败不阻断正文，复用最终回复链，不新增模型重跑或补发流程。同步首次 guidance、JSON 样例、协议及验收条件，见[决策记录](journal/shared/2026-10-16-mention-best-effort-decision.md)。本次仅更新文档。

## 2026-10-15

- 更新 [mention 专项](tasks/channel-mention-context/brief.md)：核对人类客户端与旧渠道源码，选择模型查 UID、最终回答输出 `@[uid:displayName]`、Channel 转换为原生消息体并统一发送；补齐[协议依据](tasks/channel-mention-context/protocol.md)、[首次 Context 指引](tasks/channel-mention-context/context-guidance.md)和 JSON 样例，修正强制 CLI 发总结及仅靠服务端解析标记的假设。Bot/广播继续待决；本次只改文档，验证范围见[记录](journal/shared/2026-10-15-mention-protocol-context-decision.md)。

- 创建[第三方 Adapter/Extra 飞书开发指南](https://my.feishu.cn/docx/IW30d2KL6o137ExHKHRc2yrJngh)，补齐公开类型、完整示例、Agent Run 和兼容边界。按用户要求从普通 --help 隐藏高级 --manifest，解析继续支持；19 项针对性回归及隔离示例执行结果见[记录](journal/shared/2026-10-15-third-party-plugin-guide.md)。

- 用户确认 [mention 第一项决策](tasks/channel-mention-context/brief.md)：DM/群/话题普通回复不自动 @ 真人或 Bot 发起者；记录通知噪声、Bot 互相触发及去重/限流无法阻止循环的依据。保留底层 API，原生 reply 通知行为待核对，主动 @ 其他成员的必要性继续待决。本次只更新文档。

- 用户进一步收敛[图片专项](tasks/channel-image-input/brief.md)：仅 Codex、仅独立图片消息，每条消息提交一张图片，不要求附带文本；OpenClaw/cc、富文本及转发内图片均不纳入。同步范围、验收与目录，替代初稿的 Codex/OpenClaw 范围；本次只更新文档。

- 按用户对齐拆分 Channel 六个初版专项：[图片](tasks/channel-image-input/brief.md)、[新会话此前 15 条历史](tasks/channel-new-session-history/brief.md)、[不持久化](tasks/channel-no-context-persistence/brief.md)、[限流重试协作](tasks/channel-rate-limit-retry/brief.md)、[固定 workdir 决策评估](tasks/channel-fixed-workdir-decision/brief.md)、[mention 身份来源](tasks/channel-mention-context/brief.md)。确认 Codex/OpenClaw 图片范围、有界内存与固定 Agent 工作区，撤回新增持久绑定及每会话目录建议；reset 历史边界和 mention 接线仍待决。本次只更新 OKF，未修改业务代码或执行线上调试；检查结果见[文档验证记录](journal/shared/2026-10-15-channel-six-topic-alignment.md)。

- 实施 [IM 长任务与 Codex 重试改造](tasks/im-long-running-retry/brief.md)：默认一天、工具无输出时限一天，Extra 管理连续恢复与累计重试上限；工具/交互前的 Codex 暂态失败可新建尝试，原生提示仅计入恢复预算，Host 保持单次执行。真实 Codex 受控 503 后恢复成功；真实 IM 收发及一天持续运行未验收。按用户要求移除 Runtime 与 Work App 的 adapter-icons 依赖，详见[验证记录](journal/shared/2026-10-15-im-long-running-retry.md)。

- 按用户最新要求迁移 CLI 默认清单到 apps/cli/src/default_adapters.json；SDK 在独立 Host 入口直接 import 并注册，不再复制 CLI JSON。同步调用端、带中文注释的接入示例与架构规则，记录[实现验证及图标包缺失造成的检查阻塞](journal/shared/2026-10-15-cli-default-adapters-sdk-imports.md)。

- 开放单一 npm 发行包的 `/extra` 与 `/protocol`，提供完整 Extra 和执行协议类型及校验工具；隔离安装的外部 TS 插件编译、加载及真实 Codex Agent Run 通过。另记录 CLI TS 内置集合加 `extra_adapters.json` 的第三方 Adapter 追加目标，加载改造与 `/adapter` 尚未实施。范围和回归环境缺失见[记录](journal/shared/2026-10-15-public-plugin-contracts.md)。

- 确认 [Adapter 装配归属](tasks/adapter-composition-ownership/brief.md)：CLI 与 SDK 嵌入代码各自选择，Host 按选择加载；配置载体由各自决定。依赖、裁剪和包体由宿主 App 自行管理，不作为 Runtime 的包体承诺。记录启动传递、缺包、空集合及已有 daemon 冲突的影响；对接文档、可运行示例和加载关键代码的详细中文注释为必须交付项。本次仅更新文档，未改代码或安装包。

- 按[任务](tasks/remove-adapter-host-app/brief.md)移除 Host app 启动壳，CLI daemon 与 SDK 统一启动 package runner；保留独立进程和全部 CLI 功能，更新发行物及测试。808 项回归通过、7 项跳过，离线安装、12 个 Adapter 加载及真实 Codex/OpenClaw 调用通过，范围见[记录](journal/shared/2026-10-15-remove-adapter-host-app.md)。

- 落实 [CLI 设备级 extras 配置目录](tasks/device-extra-directory/brief.md)：唯一读取 `<home>/extras`，Extra 命令拒绝 profile，不增加旧布局探测或迁移；58 项相关回归与限定范围实机验证通过，见 [记录](journal/shared/2026-10-15-cli-extras-directory.md)。

- 按[任务](tasks/unify-invoke-transport/brief.md)统一 Host、RPC、daemon 与 CLI 的输入及 signal 环境参数；执行准备只在 Host，删除旧三参数 HostInvoke/createHostInvoke 及无消费者的 wire-options，源帧与视图共用同一输入。[验收记录](journal/shared/2026-10-15-unify-invoke-transport.md)包含可重复 CLI 命令、真实 Playboard 和 Work App 结果及未覆盖范围。

- 按[任务](tasks/remove-context-snapshot/brief.md)删除通用执行协议的 contextSnapshot 和 ChannelContextSnapshotRef，同步 schema、生成类型、校验、Core 转发及测试；记录 Host/RPC 输入统一和 Host 单一执行链的目标，当前内部链路尚未改造。验证结果见[记录](journal/shared/2026-10-15-remove-context-snapshot.md)。

- 修复 Extra dispose：IM 停止信号贯通建联与执行，关闭等待真实资源释放并汇总失败；SDK 加载期间可取消，旧账号停止不作用于新进程。全量回归及限定范围 im-test/CDP 通过，见[修复记录](journal/shared/2026-10-15-extra-dispose-repair.md)。

- 按[任务](tasks/remove-business-scenarios/brief.md)删除通用协议的 ScenarioRequest、场景常量、builder 白名单和校验导出；业务自行构造 Context，Channel Gateway Extra 仍为业务接入层，Work App 测试程序不构成兼容约束。验证结果见[记录](journal/shared/2026-10-15-remove-business-scenarios.md)。

- 按[任务](tasks/remove-unused-plan-fields/brief.md)删除未消费的 required_execution_features 和 provider_compatibility；同步 schema、生成类型、校验及样例。补充场景白名单、渠道快照和内部派生参数的[调用链澄清](journal/shared/2026-10-15-protocol-simplification-review.md)，验证及未完成范围见[记录](journal/shared/2026-10-15-remove-unused-plan-fields.md)。

- 补充 [Runtime 总体协议与调用设计](rules/protocol-design.md)：串联公共输入、两层 RPC、Host 输出、Provider 调用、审批／追问往返及取消续流；登记规则索引并接回专项文档。仅整理当前合同，验收见 [记录](journal/shared/2026-10-15-protocol-design-overview.md)。

- 按[任务简报](tasks/remove-business-capability-contract/brief.md)删除自有 Adapter capabilities、执行计划 required_capabilities 和 ExecutionTarget 预留设计；业务标签归业务方，真实执行与 Provider 原生握手协议独立保留。现行规则改为 [Adapter 执行元数据](rules/adapter-metadata.md)，验证范围见[实施记录](journal/shared/2026-10-15-remove-business-capability-contract.md)。

- 实施 [Playboard 统一 daemon 执行](tasks/playboard-daemon-execution/brief.md)：移除 CLI 的 Provider 特殊装配，复用 daemon 启动与本地 RPC，隔离 PID/socket/账本，保留既有配置和常驻实例。构建、类型、lint、全量回归和真实 Codex/OpenClaw 执行通过，线上环境与未验收边界见[验证记录](journal/shared/2026-10-15-playboard-daemon-execution.md)。

- 按用户架构图记录 [实体设备、虚拟 Runtime 与 Extra 归属澄清](tasks/device-virtual-runtime-boundary/brief.md)：Extra 属于设备 Host，Runtime 为虚拟身份，个人／组织归属由业务插件管理；列出旧定义问题、profile 收敛与保留迁移要求。撤回 S1 的 P1 发布阻断定性，字段校验和文件保护问题仍未修复。本次仅更新文档。
- 记录 [Playboard 统一 daemon 执行决策](tasks/playboard-daemon-execution/brief.md)：复盘直接启动 Host、重复 Provider 装配及 RPC 层次混淆，明确临时 daemon、状态隔离与验收要求；本次仅写入 OKF，代码和线上验收待实施。

- 按后续授权实施 Extra 责任收敛：删除 onConfigure 和业务 RPC，宿主以完整配置卸载重载；增加默认同步状态，插件内部配置错误跳过并报告。SDK、CLI、三个插件与 Work App 已同步，自动检查和限定范围 im-test/CDP 验证通过；未验收边界见[实施记录](journal/shared/2026-10-15-extra-responsibility-implementation.md)。

- 修复 Alpha review F2：Octo/WeCom 回收闲置会话调度条目，移除累计 128 个会话门槛，旧卡片重试进入当前队列。双渠道分别验证模拟每日一万个会话，追加 [评审修正状态](journal/shared/2026-10-15-alpha-code-review.md)及[验证记录](journal/shared/2026-10-15-im-session-scheduling-release.md)；完整 AdapterHost 无缓存目标、S1/F1 保持待实施。

- 按用户决策收敛 Extra 责任边界：宿主管理卸载、配置修改和重载；沿用 onDispose，增加必备且默认返回空对象的同步状态能力。记录[原设计问题、责任分配和后续验收](tasks/extra-responsibility-boundary/brief.md)，同步架构、Extra 规则及指南状态说明。本次仅写入 OKF，未实施或验收代码调整。

- 在当前分支实施渠道 octo-cli 环境覆盖与 CLI OpenClaw dotenv 同步；更新环境/本地执行合同、Schema、调用链及回归测试。构建、全量检查、im-test 只读请求与内置 Runtime 工具执行通过，未验收边界见[实施记录](journal/shared/2026-10-15-channel-octo-cli-design.md)。

- 补充渠道 octo-cli 的 OpenClaw 例外：CLI 向实际加载的全局 `.env` 写两项变量，同一文件后写覆盖前写，人工重启；保留每轮 envs 不支持的真实边界，见[方案](tasks/channel-octo-cli-environment/brief.md)。

- 记录 channel-gateway 使用 octo-cli 的渠道执行环境约束与[改造方案](tasks/channel-octo-cli-environment/brief.md)：使用连接凭据覆盖两个 OCTO 变量，不写入 Context，不改变桌面身份选择；实现与线上验收尚未执行。

- 将 OpenClaw 自动发现和刷新移到 CLI 启动编排，SDK 显式配置，Adapter 只读连接；见 [合同](rules/openclaw.md)与[验证记录](journal/shared/2026-10-15-openclaw-cli-discovery.md)。

- 交付 Context v3 显式 actmode 的 Codex、CC、OpenCode ACP 首批映射及真实执行事实，完成 Work App / im-test 三家执行和 Codex 结构化问答；OpenCode 重复续聊超时等限制见[交付记录](journal/shared/2026-10-16-actmode-first-three-delivery.md)。省略不补模式、会话策略归产品。

- 接入 octo-spec / OKF，补充中文 Agent 入口、规则索引与工作流。
- 将架构正文迁入 `rules/architecture.md`，根目录仅保留导航。
- 验证记录见 [接入与架构迁移](journal/shared/2026-10-15-okf-onboarding.md)。
- 按当前源码与 Git 演进审查全部 31 份旧材料，整理为规则、指南和历史摘要，移除根与协议包的 docs 目录。
- 修正过时接口与未实现拓扑，补充规则索引和本仓知识/链接校验；结果见 [全量整理验收](journal/shared/2026-10-15-knowledge-consolidation.md)。

# 工程知识变更记录

## 2026-10-16

- 建立[executionFeatures 清理开发计划](tasks/remove-execution-features/brief.md)：依据实际消费拆为七项，列出修改位置、依赖、失败行为、验收及 100 分制开发准备度；明确桌面标签筛选、Worker 必填字段和 watchdog 活动判定均为真实依赖，先调整消费者再移除生产字段。本轮仅计划，不宣称实现或线上验收完成。

- 固化[宿主管理 Adapter 支持范围的决定](journal/shared/2026-10-16-adapter-forwarding-ownership.md)：`executionFeatures` 确定为待删除的过度设计，不新增标签或替代能力表；Adapter 负责明确输入的原生适配转发，运行状态及必要协议校验按实际执行边界处理。同步架构、Adapter 规则和开发指南；本轮仅更新 OKF，源码清理与线上验收未实施。

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

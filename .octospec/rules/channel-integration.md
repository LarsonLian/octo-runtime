---
type: Rule
title: 渠道接入与业务投递
description: Channel 显式调用本地 Host，自己管理上下文、会话与投递。
tags: ["channel","delivery","session"]
timestamp: 2026-10-19T00:00:00Z
implementation_baseline: df63c8f
id: runtime-channel
tier: repo
priority: 90
load_bearing: true
inject_when:
  paths: ["packages/octo-runtime-extra-channel-*/**","test/im-*","test/channel-*"]
  touches: ["channel","delivery","session"]
source: self
supersedes: []
---

# 渠道接入与业务投递

## IM Agent 业务边界

Channel Gateway 是长期 IM Agent 的业务入口，管理固定 Agent workdir、频道与 session/binding 映射、reset、本轮历史与 mention 指引以及结果投递。固定目录和 reset 的关系是架构决策，不是通用 Host 的功能计划。sessionId 改变不产生新目录；Host 已有其他目录准备能力也不构成 IM 的每会话目录需求。

通用 `AdapterHost.invoke` 处理已给定的一次执行，不管理上述 IM 策略。修改请求、会话或目录行为时必须先区分业务与执行责任，见[架构边界与评审要求](../guides/im-agent-invocation-boundary.md)。

2026-10-16 F16 评审再次明确：不得混合 ChannelGateway 的渠道接入责任与 AgentRun 的执行责任。业务方/宿主确定长期 Agent 配置，Channel 使用该配置完成消息准入、本轮输入、会话关联与结果投递；执行层按已确定的合同处理目录准备、Provider 调用、权限/审批及执行生命周期。渠道 session/reset 不得隐式派生、切换、迁移或清理工作目录；通用执行层有目录能力不构成渠道新增目录管理的需求。AgentRun 在此表示执行职责，不新增组件或协议。详见[F16 责任边界评审](../tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf16-逐会话工作目录)。

人格、persona、SOUL 的提示词注入完全归业务方；IM 场景由 ChannelGateway 选择和构造本轮 Context v3，决定内容、顺序与发送时机。Channel 不新增人格专用协议、Provider 旁路拼装或通用技能扫描体系；下层 Host/Adapter 不自行读人格文件、补默认人格或从历史恢复人格内容。普通指引使用 extra.im，可信控制仍遵循独立来源校验合同。该约定不授权更改现有 Provider 文件；详见[人格注入架构约束](architecture.md#人格与-soul-的注入归业务方)。

2026-10-16 F29 明确三类权限责任：Extra/Channel 决定真实消息是否准入；ChannelGateway 为 CLI 及使用相应执行环境的 MCP 提供本 Bot 的工具身份，工具与服务端校验 token 和资源 ACL；AgentRun 的本地执行权限使用统一 approval_policy（含 full_access），由 Adapter 按原生合同处理。不得以旧 minimal/host 分档将三者再次杂糅到 Channel 权限中心或专用业务 broker。获准触发不代表以发送者身份访问资源，full_access 不放大 bf_token 的业务权限；独立 MCP 凭据和 OpenClaw 实例环境沿既有合同，不虚称任意 MCP 自动继承或逐 Run 注入。见[F29 已确认评审](../tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf29-权限分档与工具网关)。

当前设备执行内核 + Extra + 外部工具的分工已满足 F29 目标。其收益与旧设计教训必须作为后续评审依据，防止以补齐旧功能为由恢复重复权限中心或业务代理；见[架构决策](../journal/shared/2026-10-16-kernel-extra-tool-boundary.md)及[现行规则](architecture.md#设备执行内核extra-与外部工具的职责权限边界)。

## 长任务与故障恢复改造状态

2026-10-15 用户明确：Octo IM 的主要场景是长任务，约一分钟的短任务很少。Channel Gateway 已把默认总时限从 120 秒改为一天，Bot 配置范围与协议一致为 100..86400000 ms。任务总期限与连续故障恢复预算分开，业务重试由 Extra 决策，Adapter 提供结构化证据，Host 保持单次执行合同。首期针对 Codex，不自动扩展到其他 Extra。

具体改造见 [IM 长任务与 Codex 重试方案](../tasks/im-long-running-retry/brief.md)。已实现工具或交互出现前、明确 Codex 暂态失败的有界重试；原生提示仍不触发第二次 invoke，但纳入 Extra 恢复预算。工具执行后的安全恢复与 Host 断流续流仍待实施，结果未知不盲目重跑。源码默认值不能作为已部署或真实持续一天运行的证据；验证范围见任务记录。

Octo 与 WeCom 使用各自的可选 Extra 包，通过注入的共享 Host 执行。代码分别有默认函数式 Extra 入口和对象式 daemon module 工厂；两者参数不同，不能混用。宿主显式携带和启用包，不要求 Worker 注册。

ChannelGateway 与 WeCom 各自以整个 Extra 为加载、卸载和配置重载单位。宿主可编辑公开 Bot 配置，但不调用插件内部 manager、逐 Bot 运行控制或 WS 管理方法；逐 Bot 编辑界面转换为完整配置及对应 Extra 重载。主要单机单 Bot 场景不存在其他 Bot 的连带断线，不为少数多 Bot 在配置更新时短暂重连新增局部热更合同。原因与约束见 [Extra 整体生命周期规则](extras.md#整体生命周期与最小公开接口)。

## 本轮输入

2026-10-17 群准入合同：启停与范围分开表达。Octo Bot 的 groups_enabled 省略或 true 开启群/话题入口，false 关闭全部群/话题；group_ids 省略、null 或 [] 不增加群范围限制，非空数组按父群 ID 限定群及话题。两个字段均不影响私聊。groups_enabled 的 null/非布尔值及 group_ids 的错误类型/空 ID 必须拒绝。无旧空名单禁用群的兼容分支，需要禁用时明确写 groups_enabled: false。

这里的“不限制”只针对群范围，不代表放开授权：allowed_sender_ids 省略仍仅允许认证所得 owner，显式名单替代默认 owner，[] 拒绝所有发送者，null 非法；自身、错 Space、非法消息和无真实 @ 的群消息继续拒绝。名单外群不会因直接点名而放行；话题按父群检查，但执行和回复留在原话题地址。配置解释和准入属于 Channel，不由宿主、Context renderer 或 AdapterHost 补救。事故证据、配置例子和验收见[群准入专项](../tasks/channel-group-admission/plan.md)。

2026-10-16 F25 用户确认：尊重真实发送者的明确授权，不因发送者是其他已知 Bot 而额外拒绝。当前 allowed_sender_ids 同时用于私聊和群/话题，显式名单替代默认 owner；群/话题仍须满足允许群及真实 mention 条件，回复留在原频道或话题、按其权限可见。自身消息继续拒绝，不通过正文或名称猜测 Bot 身份，也不新增私聊/群聊拆分授权开关。

已授权 A/B 在群中持续互相 @ 的循环属于协作模型边界，不要求 Channel 承担通用多 Agent 协作治理。需要受控协作时另行设计协作模型；不得借此在 Channel 新增已知 Bot 黑名单、内容循环识别、跨 Bot 全局状态或自动协作编排，不将这些列为延期待办。现有准入、容量及执行期限继续有效，不承诺授权双方永不循环。详见 [F25 评审](../tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf25-已知-bot-过滤与防互触发)。

Octo 群/话题消息必须通过真实发送者、Space 与群范围准入，且本条入站消息满足以下真实 mention 条件之一，才有资格进入既有命令处理或任务调度：`payload.mention.uids` 包含当前 Bot ID；或 `payload.mention.ais` 为数字 1/布尔 true，且 all/humans 均未置位。all/humans 同样只把数字 1/布尔 true 视为置位，存在这些标记时抑制单独的 ais 路径，但不覆盖有效的当前 Bot UID 点名。具体矩阵及实施计划见[Mention 入站方案](../tasks/channel-mention-context/inbound-trigger.md)。

`@所有AI` 是用户显式选择的 mention，已实现；它不属于免 @。无真实 mention 元数据时不触发。已有 session、前一条消息的 @、正文名称及历史 mention 均不放宽门槛。接收端不得扫描正文中的 `@名字`、`@[uid:name]` 或 Markdown 代码/报告来补造 mention；发送前标记由发送端按其协议转换为元数据。独立图片遵循同一规则，先准入再下载。2026-10-16 已实现 UID/ais 共用准入及 Codex 独立图片接线，实际验收见[交付记录](../journal/shared/2026-10-16-channel-features-delivery.md)。

发送端漏填 mention、传输层丢字段或接收端错误解析，分别在对应责任模块修复。Gateway 不为前两类缺陷新增正文猜测、别名匹配或免 @ 回退；按[基础架构的责任归属原则](architecture.md)检查完整链路。无元数据的普通文本继续作为未触发消息处理，不为提示发送端缺陷而在群中额外回复。

2026-10-16 架构决策：明确拒绝群/话题免 @ 需求，不提供账号级、群级或会话级关闭 mention 门槛的配置，也不读取外部免 @ 偏好来绕过准入。这不是延期需求或预留扩展。群聊中的普通交流不应启动 Agent；增加可关闭的触发门槛会放大误触发、执行成本及 Bot 相互触发风险。旧插件的相关能力仅作为历史调查依据，不构成功能对齐目标。

Octo 与 WeCom 的 Bot 配置不包含渠道 `type`；平台由加载的 Extra 包确定。`adapter.adapter_type` 继续用于选择执行引擎，状态和执行元数据中的平台由插件自身输出。

Octo 插件配置只校验已识别字段，未知扩展字段保留并忽略，不使用字段白名单拒绝整个配置。可选 `bot_name` 为本地展示名称，省略时使用 `bot_id`，不参与身份或授权。CLI/daemon 统一经 Extra 声明装配，不提供渠道专用命令或文件读取。`extraset` 原样保存并替换整份插件声明，多机器人由插件自己的 `config.bots` 数组表达；Bot 校验、默认值与连接管理属于插件。

业务渠道决定 Actor、Trigger、Target、Input 和本轮 Context，并在调用前处理业务 defaults/mandatory。Octo 群固定加载 GROUP.md，话题固定加载群和本话题规则，不设置 group_rules/topic_rules 开关；404 明确记录不存在，权限或网络失败不伪装成空规则。规则、历史读取和消息 selection 均属于渠道业务选择，不是 Host 的自动采集能力。F18 的开关清理已实施，验证见[实施记录](../tasks/gateway-august-feature-assessment/implementation.md)。

文档、网盘文件及内部附件采用[资源地址 Context 决策](../journal/shared/2026-10-16-resource-context-access-decision.md)：Channel 从本条真实报文组织资源类型、来源、标识/地址及获取指引，放入 extra.im。在线文档、网盘文件和内部 file 的读取方法分别由实际 octo-cli/工具提供，Provider/Harness 内的 Agent 按需调用；Channel 不要求 Adapter 预下载或转换原生附件，Host 不按资源类型预取。业务指引与执行凭据分开，读取沿当前 Bot 的权限和工具环境进行，不在提示词暴露 Token。F04 资源 Context 接线已实施并通过 im-test 附件投影；完整文档/网盘取材矩阵未验，不扩大 Codex 独立图片范围或更改真实 mention 准入。

渠道使用公共 InvokeInput 并显式选择 canonical，保存 Provider binding，处理交互与 reset。源事件及 payload 必须完整交给消费应用；UI 展示过滤不应裁剪原始历史数据。

读取 adapter 选择以执行渠道业务策略，不等于解析执行计划。Extra 组装公开 InvokeInput 后直接调用 Host，`resolveLocalContext()` 仅在 Host 的共享准备路径使用。2026-10-17 已删除双渠道 dispatcher 的重复执行解析，text-only instructions 可通过该边界，见[交付记录](../journal/shared/2026-10-17-extra-initializer-delivery.md)；故障链见[排查经验](../journal/shared/2026-10-16-im-invoke-preparation-lessons.md)。准备失败必须单独报告尚未发起执行，沿既有标准失败投影展示安全原因；Octo 独立错误卡片和普通文本分别投递。连接在线不代表本轮执行成功，任务错误不得污染连接状态。全面准备失败展示及全 Provider 验收仍待实施，不能由本次核心修复推定完成。

所有执行卡片（状态、工具进度及用户交互）必须由 CanonicalEvent 投影；不得解析助手正文、Provider 原始消息或自定义工具字段来替代统一事件与交互合同。AskUser 的既定接入路径是 interaction.requested → Channel 卡片 → 用户回答 → respondInteraction → 原模型继续执行，interaction.resolved 收敛卡片状态。交互卡片首版支持选项与自定义输入，核心注释引用 [F09 方案](../tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf09-统一用户交互的-im-呈现与响应)；特殊解析必须标注非标准，不作为默认替代。首版已接通，im-test 创建/收敛通过，真人回调未验；isSecret 不进入普通卡片或聊天回答回退，仅提示不支持安全输入并请求停止，宿主安全产品路径待决。

IM 后台配置对应的 Agent 使用固定目录，不按任务选择或改变 workdir。Octo Channel Gateway 的本地引擎省略 Agent 配置中的 `adapter.workdir` 时，由渠道入口使用并创建 `~/octo-runtime/channels/{bot_id}`，不随配置 Home、任务或会话变化。显式 Agent 目录必须是绝对路径；任务级 workdir 或 workspace Context 不得覆盖该 Agent 的目录。OpenClaw 保留 Provider Agent 自有固定工作区。显式更新 Agent 配置与提交任务是不同操作。

以上为 IM 架构约束，替代此前“Context workspace 可覆盖 IM 默认目录”的规则表述；通用 Host 的配置解析能力不因此改变。IM 请求入口已在 resolver 前校验任务 workspace，指定不同目录时返回 IM_AGENT_WORKDIR_FIXED，不把固定目录作为可被任务替换的 defaults。

新逻辑会话在首条普通输入准备时只自动尝试一次最近历史：最多 15 条、总计 1500 Unicode 码点，取当前触发之前同一 DM/群/话题的纯文本。先占用有界会话标记再异步读取，失败、空结果和准备失败均不恢复资格；正常续聊不重拉。reset 后允许补旧聊天，重试使用冻结输入，不新增本地历史持久库。

群/话题续聊不把Provider session稳定视为历史完整。Channel在现有有界binding中记录位置及待补边界，未 @ 消息只观察，不创建session、不执行任务；位置观察不延长binding TTL。模型前固定输入准备直接使用现有TypeScript API层，不委托Agent调用octo-cli，不做关键词判断。准备时按冻结触发序号及当前已交接边界调用消息sync API：已知缺口limit=min(15,跨度)，未知基线最近最多15条，无缺口不查；冷启动和缺口共用本轮一次读取。10秒超时、1 MiB响应上限、禁用429自动重试，不翻页；代码过滤上下界、去重并再次截至15条，文本沿用1500 Unicode码点。正文作为`extra.im/history`在host.invoke前冻结，`history-gap`仅报告provided/partial/empty/unavailable/omitted，不再携带CLI命令。失败或预算省略不阻断当前任务，但保留待补边界；最终快照确有正文或API返回无可用文本时才清除该边界。交接不代表模型已阅读完整讨论，不拦截通用工具输出造已读水位。额外业务调查仍由Agent按用户任务使用octo-cli，不能与固定准备流程混同。

该本地实现覆盖原准入、排队/取消、reset代次、重试与预算边界，不改变WeCom、Host或协议。默认store将元数据计入原1024/4MiB/24h边界，自定义store缺少可选原子patch能力时明确unknown。成功ACK及能关联原发送/卡片的自身RECV才可按原turn排除自身位置；未关联/已淘汰位置保守处理。真实服务端可见性、序号同域与Agent取材仍须按[实施记录](../tasks/channel-context-gap/implementation.md)验收，不能由fake测试推断已部署。

出站普通回复不自动 @ 发起者。显式真人通知由模型理解需求、按需查询身份，在成功 final 普通正文中输出 `@[uid:displayName]`。Channel 用结构化 Markdown 解析排除代码和引用，再校验当前成员并转换为人类协议 `content + mention.uids/entities`，经原连接统一发送。失败目标退为普通 @名字，不阻断正文、不另发失败提示或补发。模型出站 Bot 与广播仍不开放；进度、工具、thinking 和失败终态不转换。Channel 对新 session 或无 Provider binding 的调用显式提交 mention 指引；历史的一次资格不受指引重提影响。

## 业务工具与产物交付边界

octo-cli 是业务团队共同维护的 Go 二进制程序，提供 Octo 各业务子系统的 API 调用能力。对 IM Channel 而言，宿主预置并配置该工具具有重要产品价值：Agent 可在对话中按需读取文档、发送业务消息和交付文件，完成实际业务任务，而不仅给出文字回复。是否预置及版本由 HostApp 明确决定，不能变成 Channel 隐式安装或硬编码业务 API 的理由；维护归属与预置价值见[架构说明](architecture.md#octo-cli-的业务定位与产品价值)。

类似的定制业务执行流程统一遵循：非必要流程通过 octo.context-envelope/v3 注入本轮约束，由 Agent 工具循环完成，严禁在 Channel 编码步骤编排、条件分支或收尾代执行。此原则不限于消息、文件和 artifact；Channel 必需的传输、准入、生命周期和 CanonicalEvent 呈现按现有合同执行，不能扩大解释为业务自动化入口。

2026-10-16 已确定：发送业务消息、上传文件、交付附件或多个产物由 Agent tool call 调用 octo-cli 等实际工具完成。需要自动交付时，业务方在本轮 Context instructions 中表达交付要求，Agent 在同一次任务内执行；不是让 Channel 在执行结束后执行收集/上传/发送。Channel 严禁硬编码这类中间业务流程，不解析 artifact、助手正文、工具输出或路径标记来补做副作用，不设置“工具未调用则渠道代发”的兜底分支。旧 Gateway 的相关实现属于历史遗留，明确不迁入。

工具调用不稳定时，在业务方拥有的 Context、提示词、技能与工具说明处对齐；工具或身份合同实际有缺陷时修复其责任模块，不能在 Channel 特殊处理来代执行。Context 的生成和发送仍由业务发起方决定，不要求框架自动注入或每轮重复。Channel 继续按标准合同负责 IM 准入、输入/Context 接线、CanonicalEvent 展示、交互回传和当前会话最终回复。已存在的 CLI/tool call 能力计入目标覆盖，不因 Channel 未重复实现 API 而扣分；本轮未独立复测与功能未实现分别记录。见[架构决定](../journal/shared/2026-10-16-agent-toolcall-channel-boundary.md)。

## Octo CLI 的渠道执行环境

本节仅约束 `channel-gateway` 发起的执行如何使用 `octo-cli`。已实现独立执行覆盖及 CLI OpenClaw dotenv 同步；改造内容与验收范围见 [任务方案](../tasks/channel-octo-cli-environment/brief.md)，真实验证边界见 [记录](../journal/shared/2026-10-15-channel-octo-cli-design.md)。

- gateway 使用 `OCTO_BOT_TOKEN` 和 `OCTO_API_BASE_URL` 为 octo-cli 提供身份与地址。普通子进程 Adapter 每轮使用接收消息的连接已解析并通过身份校验的 Bot 凭据；OpenClaw 使用下述 CLI 预配置例外。API 地址取对应渠道配置的 `api_url` 并移除末尾 `/api` 和尾部斜杠。不得从 WS 消息、正文或请求 `envs` 获取这两个强制值。
- 这两个值属于 gateway 为工具调用提供的执行环境，不追加到发起方 Context、控制指令、模型输入、业务快照或运行元数据。Context 的 `envs` 保持额外执行配置的既有语义；gateway 的两个强制值覆盖其中及设备环境中的同名值，其他变量保持原有规则。
- 普通子进程 Adapter 的覆盖必须按调用隔离并实际到达 Provider 及其启动的 `octo-cli`，不得修改全局 `process.env` 或把某个 Bot 的凭据设置到共享 AdapterHost 进程环境。无法按轮应用时，必须在工具执行前明确失败，不得声称覆盖成功。
- 普通子进程 Adapter 的 Token、API 地址及连接代次必须绑定同一连接。重连或配置替换后，新执行使用新连接配置；旧连接排队消息不得改用新 Bot 凭据。凭据不写入日志、状态、错误详情或提交。
- OpenClaw 例外：由 CLI 编排层按当前渠道配置，把这两个变量写入目标 OpenClaw 实际读取的全局 `.env`（通常为 `~/.openclaw/.env` 或 `$OPENCLAW_STATE_DIR/.env`）。复用 CLI 发现来源，必要时调用只读 `openclaw config file --json` 确认实例；不得在 Adapter/probe/invoke 中扫描或写文件。不同目标目录分别写入；同一文件按配置处理顺序后写覆盖前写，不拒绝多个 Bot 使用同一目标。只更新这两个变量，保留其他内容。Gateway 重启由人工处理，写入完成不表示正在运行的 Gateway 已生效。此路径使用实例共享身份，不承诺逐轮或逐 Agent 隔离；不向 OpenClaw 的每轮调用传入那两个内部覆盖项。
- Host/Adapter 只承载按调用传递的执行值，不读取 gateway 配置、不理解 OCTO 变量的业务来源。实现所需的内部传递扩展不得改变 Context v3、Run 7 或桌面调用方自行选择身份并使用 `envs` 的合同。
- F23 已确认：OpenClaw Gateway 按独立 Agent 实例使用固定环境，符合当前需求；CLI daemon 启动编排配置其实例 `.env`，不修改上游 OpenClaw 设计或源码，不增加特殊 `session.create` 注入。Codex/Claude Code 等通用执行路径按原生能力逐轮传递。不得将 OpenClaw 无逐轮环境载体重新列为待补功能；原生加载优先级、人工重启及真实生效验证边界继续保留。
- F24 用户确认的身份选择：普通调用以当前 Extra Bot 的合法身份及 API 配置为权威，覆盖进程级同名默认值，不能串用其他 Bot。OpenClaw 同一实例只从启用、合法且 `adapter_type=openclaw` 的配置中按顺序取最后一项，用户可通过调整 items 顺序主动选择实例工具身份；其他 Adapter 项不得成为候选，没有 OpenClaw 候选时不借用其他 Bot。此为实例级开放配置能力，不新增身份开关或逐轮注入。候选筛选修正已实施并通过临时目录回归；配置错误明确报告，排序不绕过原生环境优先级或人工重启要求，不声称用户当前运行实例已加载。
- 两种注入原理分别保持：普通 Adapter 每次调用使用自己所属 Bot 的配置；OpenClaw 启动准备读取配置、写实例共享 `.env`，再由 Gateway 原生加载。只有后者采用同实例最后一个合法 OpenClaw 配置的选择规则，不让其他 Adapter 共用最后一项的身份或统一写共享 `.env`。
- `octo-cli` 是否安装及版本由 HostApp 决定。gateway 不因收到消息而隐式下载或安装工具。本节不保证 Provider 专用配置或工具显式重新设置环境后仍使用相同身份，也不把 workdir 当作凭据隔离沙箱。

## 回执与恢复

F26 已实施，必须使用两个独立名称及计数，不统称“64 条限额”：

- **Bot 最大工作并发数：64**。单个 Bot 的全部 session 中，已开始处理且未结束的任务数总和不得超过 64；排队任务不计入。同一 session 最多同时处理 1 条。该数值不限制 session 总数，也不是宿主所有 Bot 的共享并发上限。
- **单 session 最大排队任务数：4**。每个逻辑 session 独立统计已受理但尚未开始处理的任务，最多 4 条，不含正在处理的 0 或 1 条。A 处理时 B/C/D/E 可以排队，F 因队列满被拒收。此前“1 条工作+3 条排队即满”不再作为目标。

工作任务等待模型、工具、用户交互或本轮内部重试时仍占同一工作槽位，执行及必要清理结束才释放；有排队时槽位原子交给本 session 下一条，队列清空才释放给其他 session。Bot 工作数不混加排队数。调度及拒收顺序见 [F26 评审](../tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf26-有界队列执行期限与过载反馈)，不新增每秒消息数门槛或跨 Bot 调度体系。

术语含义、计数增减、同群多用户、跨群独立、Bot 并发满与队列满的区别，以及名额释放后的行为，统一以 [F26 定义与具体例子](../tasks/gateway-august-feature-assessment/assessment.md#f26-定义与具体例子)的 E01–E13 为交接与验收依据。例如 20 个 session 各 1 条工作+4 条排队时，工作并发只有 20，不能继续用旧总量 64 拒收；两个数字也不限制累计 session 总数。示例是目标说明，不表示实现或实测完成。

两类真实容量拒收均尝试独立错误卡片＋普通文本“当前智能体繁忙，请稍后再试”，卡片明确“本条消息未受理，尚未开始执行”。**文案相同、公开错误码不同**：Bot 工作并发满 OH-RUN-2003；单 session 排队满 OH-RUN-2004，均来自共享目录。详情展示繁忙类型、公开码及 diagnosticId，保留真实 Channel 准入阶段，不建第二份错误码表。卡片来自 Channel 本地准入失败 CanonicalEvent run.failed 的标准投影，不发 Host.invoke、不创建真实 AgentRun、不伪造启动，不复用在途任务卡片或终态。卡片/文本独立投递，失败互不阻塞；通知按消息幂等、限频且内存有界，不自动重提。关闭、重复或未授权消息不误报繁忙。Gateway 已实施并通过 im-test 卡片/文本回读；WeCom 容量合同不在本项修改范围。

2026-10-16 已确认：新 octo-server 自动根据 IM 长连接上下线事件维护在线状态并推送给客户端，Runtime 的在线展示沿用这条链路及现有 WS 协议心跳。独立 REST `/v1/bot/heartbeat` 属于历史兼容设计，不再是当前在线展示要求，Channel 不新增 REST 心跳循环，也不因该 REST 请求失败触发 WS 重连。此决定不要求删除已有 helper，不把 IM 在线等同于 Provider 可用或任务执行成功。源码核对、用户本地观察与验证边界见 [F06 评审](../tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf06-在线展示与旧-rest-心跳)。

F22 补充在线状态归属：客户端维持 WS 长连接、参与既有协议心跳并管理本连接的恢复；云端依据连接及心跳维护在线状态并刷新 Redis，向 Web 等消费方提供在线信息。Channel 不直接操作云端 Redis、不另建在线账本，也不把宿主的本地状态汇总当作云端在线权威或跨 Bot 控制依据。该服务端职责由用户确认；本轮不宣称重新验收其具体 Redis key、TTL 或刷新实现，不因此恢复旧 REST 心跳要求。

2026-10-16 Octo Channel Gateway 已在源码中拆分首次启动与断线恢复：首次任何连接失败进入 failed，保留 error，不自动重试；本次启动曾完整上线后才允许暂态断线恢复，等待 5/10/20/30/30 秒。恢复过程保持 retrying/connected=false，完整成功才变回 online、清连接错误并归零计数。只有 online 为健康，Extra loaded 不表示 Bot 在线；主动停止为 stopped 且取消在途连接与重试。未知协议或明确终端拒绝进入 failed。配置错误仍为 config_error，不与连接失败混用。

连接状态由 Extra 持有，Host/daemon 不解释字段或提供第二套重连。任务、Provider、卡片及投递诊断不污染连接 state/error；恢复不重新 invoke、不保证旧消息已送达。首次失败后的重试由宿主显式重新启动触发；不再后台轮询缺失凭据。详细状态图、并发与服务端错误证据要求见[状态机任务](../tasks/channel-connection-state-machine/brief.md)。源码实现不代替部署或实际合盖验收，结果按任务记录说明。

2026-10-16 F22 进一步明确：恢复资格属于各连接本次启动周期，不引入跨 Bot 全局健康联动、全组启动回滚、全局恢复管理器或逐 Bot 持久协调锁。宿主可以汇总公开状态用于展示，但不得按汇总健康重启失败 Bot、整个 Extra 或 AdapterHost；显式整体配置重载继续按生命周期合同执行。首次失败就报告失败，只有本周期曾完整上线的连接才可自动恢复；终端拒绝和主动停止后不得自动争抢连接。

这里的轻量/无状态要求是不依赖跨 Bot 全局业务状态或持久协调账本，并非删除连接必需的局部内存状态。socket、取消信号、当前错误、单连接恢复计数与计时器仍由插件封装。少数同机多 Bot 的特殊操作不构成扩大接口的理由；普通网络中断也会发生，不能因此删除既有逐连接恢复。此约束不授权清除身份、Home、用户配置或 Provider 原生状态。用户意见、旧方案事实与工程判断见 [F22 评审](../tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf22-就绪状态连接状态与单实例锁)。

invoke/cancel/respond 保留命令回执，源流不增加逐事件 durable ACK。断流从同一 stream 的连续游标修复，不重新执行。Host 重启或窗口过期后如实报告失败，由业务方决定下一步。

Run 完成不等于 IM 发送成功。需要可靠投递的应用自行定义发送意图、目标消息 ID、重试与持久化，不要求 Host 增加传输数据库。当前内存会话及消息去重仅在容量和 TTL 窗口内生效，不承诺重启后恰好一次投递。

## 当前能力与验证边界

Codex 执行中首条非原生重试错误使用 `run.notice/provider_diagnostic` 传递脱敏、有界事实，继续等待真实终态。IM 只在终态选择一次实际 final 回复；带过程诊断或重试通知却没有可交付正文时，保留 completed，同时展示“结果待核查”和避免重复执行提示，不显示重新执行按钮、不授予自动重试资格。恢复并给出有效回复时正常交付，过程原因留在详情；失败、取消及结果未知保留各自语义。正常路径不新增诊断事件、网络或模型调用。实施及验收边界见[任务](../tasks/im-diagnostic-silent-completion/brief.md)。

执行失败统一使用 CanonicalEvent run.failed。Host 的分类补充 failure，但保留 Adapter 返回的 message/error 等错误信息；执行状态整理不得只留下 failure 而裁剪原始错误。卡片统一显示“执行失败”，优先展示脱敏后的实际原因，错误码与诊断编号置于详情；没有实际原因时才使用目录摘要。不同 Adapter 不分别建立展示错误码表。

Node 的 spawn ENOENT 不能单独证明命令缺失；工作目录不存在也产生同一 errno。Host 遇到此类失败时核查 cwd，分别补充工作目录不存在、不是文件夹或没有进入权限的原因，不自动创建显式配置的目录。卡片长度和字节预算继续生效，较长错误由文本回复补充，不将凭据或完整配置作为诊断正文。

FDE 接入的客户程序不保证支持卡片展示，最终文本默认始终投递，不因卡片成功送达而省略。卡片展示是补充，不能替代通用文本输出。

Octo 实现私聊、显式群/话题触发、可选规则与历史读取、typing、进度卡及最终文本；WeCom 使用自身 stream 回复协议。代码存在不表示这些场景均已完成线上闭环验收。

私聊、群聊、话题、卡片按钮、取消、真实审批和多端同步分别验收；fixture 或普通模型执行不能代替 IM 真实收发。Work App 的数据库格式、批写策略与唯一 preload 桥由宿主项目维护，不写成 Runtime 的存储实现。

## 核对入口

[Octo Extra](../../packages/octo-runtime-extra-channel-gateway/src/extra.ts)、[WeCom Extra](../../packages/octo-runtime-extra-channel-wecom/src/extra.ts)、[Octo 会话](../../packages/octo-runtime-extra-channel-gateway/src/application/im-channel.ts)、[im-runtime.test.js](../../test/im-runtime.test.js)、[im-wecom.test.js](../../test/im-wecom.test.js)、[channel-packages.test.js](../../test/channel-packages.test.js)。

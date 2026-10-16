---
type: Rule
title: 渠道接入与业务投递
description: Channel 显式调用本地 Host，自己管理上下文、会话与投递。
tags: ["channel","delivery","session"]
timestamp: 2026-10-15T00:00:00Z
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

## 长任务与故障恢复改造状态

2026-10-15 用户明确：Octo IM 的主要场景是长任务，约一分钟的短任务很少。Channel Gateway 已把默认总时限从 120 秒改为一天，Bot 配置范围与协议一致为 100..86400000 ms。任务总期限与连续故障恢复预算分开，业务重试由 Extra 决策，Adapter 提供结构化证据，Host 保持单次执行合同。首期针对 Codex，不自动扩展到其他 Extra。

具体改造见 [IM 长任务与 Codex 重试方案](../tasks/im-long-running-retry/brief.md)。已实现工具或交互出现前、明确 Codex 暂态失败的有界重试；原生提示仍不触发第二次 invoke，但纳入 Extra 恢复预算。工具执行后的安全恢复与 Host 断流续流仍待实施，结果未知不盲目重跑。源码默认值不能作为已部署或真实持续一天运行的证据；验证范围见任务记录。

Octo 与 WeCom 使用各自的可选 Extra 包，通过注入的共享 Host 执行。代码分别有默认函数式 Extra 入口和对象式 daemon module 工厂；两者参数不同，不能混用。宿主显式携带和启用包，不要求 Worker 注册。

## 本轮输入

Octo 群/话题消息必须通过真实发送者、Space 与群范围准入，且本条入站消息满足以下真实 mention 条件之一，才有资格进入既有命令处理或任务调度：`payload.mention.uids` 包含当前 Bot ID；或 `payload.mention.ais` 为数字 1/布尔 true，且 all/humans 均未置位。all/humans 同样只把数字 1/布尔 true 视为置位，存在这些标记时抑制单独的 ais 路径，但不覆盖有效的当前 Bot UID 点名。具体矩阵及实施计划见[Mention 入站方案](../tasks/channel-mention-context/inbound-trigger.md)。

`@所有AI` 是用户显式选择的 mention，已实现；它不属于免 @。无真实 mention 元数据时不触发。已有 session、前一条消息的 @、正文名称及历史 mention 均不放宽门槛。接收端不得扫描正文中的 `@名字`、`@[uid:name]` 或 Markdown 代码/报告来补造 mention；发送前标记由发送端按其协议转换为元数据。独立图片遵循同一规则，先准入再下载。2026-10-16 已实现 UID/ais 共用准入及 Codex 独立图片接线，实际验收见[交付记录](../journal/shared/2026-10-16-channel-features-delivery.md)。

发送端漏填 mention、传输层丢字段或接收端错误解析，分别在对应责任模块修复。Gateway 不为前两类缺陷新增正文猜测、别名匹配或免 @ 回退；按[基础架构的责任归属原则](architecture.md)检查完整链路。无元数据的普通文本继续作为未触发消息处理，不为提示发送端缺陷而在群中额外回复。

2026-10-16 架构决策：明确拒绝群/话题免 @ 需求，不提供账号级、群级或会话级关闭 mention 门槛的配置，也不读取外部免 @ 偏好来绕过准入。这不是延期需求或预留扩展。群聊中的普通交流不应启动 Agent；增加可关闭的触发门槛会放大误触发、执行成本及 Bot 相互触发风险。旧插件的相关能力仅作为历史调查依据，不构成功能对齐目标。

Octo 与 WeCom 的 Bot 配置不包含渠道 `type`；平台由加载的 Extra 包确定。`adapter.adapter_type` 继续用于选择执行引擎，状态和执行元数据中的平台由插件自身输出。

Octo 插件配置只校验已识别字段，未知扩展字段保留并忽略，不使用字段白名单拒绝整个配置。可选 `bot_name` 为本地展示名称，省略时使用 `bot_id`，不参与身份或授权。CLI/daemon 统一经 Extra 声明装配，不提供渠道专用命令或文件读取。`extraset` 原样保存并替换整份插件声明，多机器人由插件自己的 `config.bots` 数组表达；Bot 校验、默认值与连接管理属于插件。

业务渠道决定 Actor、Trigger、Target、Input 和本轮 Context，并在调用前处理业务 defaults/mandatory。Octo 的可选 GROUP.md、历史读取和消息 selection 属于渠道业务选择，不是 Host 的自动采集能力。

渠道使用公共 InvokeInput 并显式选择 canonical，保存 Provider binding，处理交互与 reset。源事件及 payload 必须完整交给消费应用；UI 展示过滤不应裁剪原始历史数据。

IM 后台配置对应的 Agent 使用固定目录，不按任务选择或改变 workdir。Octo Channel Gateway 的本地引擎省略 Agent 配置中的 `adapter.workdir` 时，由渠道入口使用并创建 `~/octo-runtime/channels/{bot_id}`，不随配置 Home、任务或会话变化。显式 Agent 目录必须是绝对路径；任务级 workdir 或 workspace Context 不得覆盖该 Agent 的目录。OpenClaw 保留 Provider Agent 自有固定工作区。显式更新 Agent 配置与提交任务是不同操作。

以上为 IM 架构约束，替代此前“Context workspace 可覆盖 IM 默认目录”的规则表述；通用 Host 的配置解析能力不因此改变。IM 请求入口已在 resolver 前校验任务 workspace，指定不同目录时返回 IM_AGENT_WORKDIR_FIXED，不把固定目录作为可被任务替换的 defaults。

新逻辑会话在首条普通输入准备时只自动尝试一次最近历史：最多 15 条、总计 1500 Unicode 码点，取当前触发之前同一 DM/群/话题的纯文本。先占用有界会话标记再异步读取，失败、空结果和准备失败均不恢复资格；正常续聊不重拉。reset 后允许补旧聊天，重试使用冻结输入，不新增本地历史持久库。

出站普通回复不自动 @ 发起者。显式真人通知由模型理解需求、按需查询身份，在成功 final 普通正文中输出 `@[uid:displayName]`。Channel 用结构化 Markdown 解析排除代码和引用，再校验当前成员并转换为人类协议 `content + mention.uids/entities`，经原连接统一发送。失败目标退为普通 @名字，不阻断正文、不另发失败提示或补发。模型出站 Bot 与广播仍不开放；进度、工具、thinking 和失败终态不转换。Channel 对新 session 或无 Provider binding 的调用显式提交 mention 指引；历史的一次资格不受指引重提影响。

## Octo CLI 的渠道执行环境

本节仅约束 `channel-gateway` 发起的执行如何使用 `octo-cli`。已实现独立执行覆盖及 CLI OpenClaw dotenv 同步；改造内容与验收范围见 [任务方案](../tasks/channel-octo-cli-environment/brief.md)，真实验证边界见 [记录](../journal/shared/2026-10-15-channel-octo-cli-design.md)。

- gateway 使用 `OCTO_BOT_TOKEN` 和 `OCTO_API_BASE_URL` 为 octo-cli 提供身份与地址。普通子进程 Adapter 每轮使用接收消息的连接已解析并通过身份校验的 Bot 凭据；OpenClaw 使用下述 CLI 预配置例外。API 地址取对应渠道配置的 `api_url` 并移除末尾 `/api` 和尾部斜杠。不得从 WS 消息、正文或请求 `envs` 获取这两个强制值。
- 这两个值属于 gateway 为工具调用提供的执行环境，不追加到发起方 Context、控制指令、模型输入、业务快照或运行元数据。Context 的 `envs` 保持额外执行配置的既有语义；gateway 的两个强制值覆盖其中及设备环境中的同名值，其他变量保持原有规则。
- 普通子进程 Adapter 的覆盖必须按调用隔离并实际到达 Provider 及其启动的 `octo-cli`，不得修改全局 `process.env` 或把某个 Bot 的凭据设置到共享 AdapterHost 进程环境。无法按轮应用时，必须在工具执行前明确失败，不得声称覆盖成功。
- 普通子进程 Adapter 的 Token、API 地址及连接代次必须绑定同一连接。重连或配置替换后，新执行使用新连接配置；旧连接排队消息不得改用新 Bot 凭据。凭据不写入日志、状态、错误详情或提交。
- OpenClaw 例外：由 CLI 编排层按当前渠道配置，把这两个变量写入目标 OpenClaw 实际读取的全局 `.env`（通常为 `~/.openclaw/.env` 或 `$OPENCLAW_STATE_DIR/.env`）。复用 CLI 发现来源，必要时调用只读 `openclaw config file --json` 确认实例；不得在 Adapter/probe/invoke 中扫描或写文件。不同目标目录分别写入；同一文件按配置处理顺序后写覆盖前写，不拒绝多个 Bot 使用同一目标。只更新这两个变量，保留其他内容。Gateway 重启由人工处理，写入完成不表示正在运行的 Gateway 已生效。此路径使用实例共享身份，不承诺逐轮或逐 Agent 隔离；不向 OpenClaw 的每轮调用传入那两个内部覆盖项。
- Host/Adapter 只承载按调用传递的执行值，不读取 gateway 配置、不理解 OCTO 变量的业务来源。实现所需的内部传递扩展不得改变 Context v3、Run 7 或桌面调用方自行选择身份并使用 `envs` 的合同。
- `octo-cli` 是否安装及版本由 HostApp 决定。gateway 不因收到消息而隐式下载或安装工具。本节不保证 Provider 专用配置或工具显式重新设置环境后仍使用相同身份，也不把 workdir 当作凭据隔离沙箱。

## 回执与恢复

2026-10-16 Octo Channel Gateway 已在源码中拆分首次启动与断线恢复：首次任何连接失败进入 failed，保留 error，不自动重试；本次启动曾完整上线后才允许暂态断线恢复，等待 5/10/20/30/30 秒。恢复过程保持 retrying/connected=false，完整成功才变回 online、清连接错误并归零计数。只有 online 为健康，Extra loaded 不表示 Bot 在线；主动停止为 stopped 且取消在途连接与重试。未知协议或明确终端拒绝进入 failed。配置错误仍为 config_error，不与连接失败混用。

连接状态由 Extra 持有，Host/daemon 不解释字段或提供第二套重连。任务、Provider、卡片及投递诊断不污染连接 state/error；恢复不重新 invoke、不保证旧消息已送达。首次失败后的重试由宿主显式重新启动触发；不再后台轮询缺失凭据。详细状态图、并发与服务端错误证据要求见[状态机任务](../tasks/channel-connection-state-machine/brief.md)。源码实现不代替部署或实际合盖验收，结果按任务记录说明。

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

---
type: Task
title: Mention 身份来源与出站能力专项
description: 入站识别真实 UID 点名和所有 AI 广播；出站真人点名复用人类协议，普通回复不自动 mention。
tags: [channel, context, delivery, identity]
timestamp: 2026-10-16T00:00:00Z
---

# Mention 身份来源与出站能力专项

## 目标与状态

2026-10-15 按用户逐项讨论与源码核查，确定同一频道内显式点名真人的路径：Channel 提交使用指引，模型理解用户要求并按需查询 UID，在最终回答中输出 `@[uid:displayName]`；Channel 转换为人类客户端相同的 `content + payload.mention`，随最终回答统一发送。

2026-10-16 已实施入站 UID/纯 ais 门槛、首次指引、final 标记转换及原 WS 回复接线。结构化 Markdown 解析使用 mdast；发送前核验真人，失败降级普通文本，不新增持久存储。自动化覆盖原生加密 WS 帧及 UTF-16 entities；真实客户端通知效果仍须单独验收。具体依据见[人类 Mention 协议](protocol.md)，首次输入见[Context 指引](context-guidance.md)及[完整 JSON 样例](first-context.example.json)。

2026-10-16 新增已确认的入站范围：支持真实 `@所有AI`（纯 `payload.mention.ais`）与直接 Bot UID 点名，拒绝正文名称或标记匹配、免 @、代理身份触发。具体协议矩阵、源码依据、开发步骤和线上验收见[入站方案与计划](inbound-trigger.md)。本次入站范围不自动授权模型在最终回复中主动广播。

2026-10-16 用户确认最终原则：能点名就随最终回答点名；模型找不到合适目标时自行使用普通 `@名字` 或纯文本。mention 是附加能力，查找或校验失败不阻断最终正文，不追加“未完成点名通知”等提示，不为通知另建反馈、模型重跑或补发流程。

## 已确认决策：普通回复不自动 mention

2026-10-15 用户确认：普通最终回复不自动附加 mention，不区分发起者是真人还是 Bot；DM、群和话题均遵循此规则。Channel 不因已知 fromUid、收到过 @ 或模型输出 @昵称，就自动生成 mention.uids/entities/all。

决策依据：私聊回复已有会话归属，群和话题的普通回复也不必额外制造 @ 通知。Bot A @ Bot B 后，若 B 的回复自动 @ A，双方可能反复触发；每轮都是新消息，messageId 去重无法阻止，限流最多延缓循环。因此，不把“回复默认 @ 发起者”作为能力缺口或新增需求。

需要关联原问题时优先考虑原生 reply 关系，而不是自动 mention。原生回复自身的实际通知及 Bot 触发行为仍须核对，不能承诺一定不会触发对端；本次不要求所有回复立即增加 reply 字段。

保留现有底层 mention API 能力。用户明确提出“完成后请 @张三”等要求时，采用下述显式真人点名路径；这与自动附加发起者不同。模型出站 Bot 目标和广播继续单独待决；入站 AI 广播已纳入本计划。不自动 mention 只关闭普通回复的一条循环路径，不宣称解决全部 Bot 互相触发场景。

## 已有能力与实际缺口

- [入站准入](../../../packages/octo-runtime-extra-channel-gateway/src/transport/normalize.ts) 已统一文本与独立图片的 UID/纯 ais 判断，不从正文匹配名称或标记。
- [sendMessage](../../../packages/octo-runtime-extra-channel-gateway/src/transport/api/messages.ts) 已接受 mentionUids、mentionEntities、mentionAll，并生成 payload.mention.uids/entities/all。媒体及富文本发送也已有相应参数；协议能力不是从零开发。
- 普通模型最终回复沿 [Channel reply](../../../packages/octo-runtime-extra-channel-gateway/src/transport/channel.ts) 调用 [WS sendText](../../../packages/octo-runtime-extra-channel-gateway/src/transport/wukong.ts)，成功 final 的显式标记经 [mentions.ts](../../../packages/octo-runtime-extra-channel-gateway/src/transport/mentions.ts) 转换，并与正文统一发送。无标记不查询成员、不附加 mention；转换结果在同一投递重试中复用。
- 入站真实 fromUid 可用于回应当前发送者；历史 API 的 from_uid 可标识历史发言者；[getGroupMembers、fetchUserInfo、searchSpaceMembers](../../../packages/octo-runtime-extra-channel-gateway/src/transport/api/conversations.ts) 提供成员与身份查询封装。
- 当前[历史 Context](../../../packages/octo-runtime-extra-channel-gateway/src/transport/contexts.ts) 在启用历史读取时可以把 from_uid 交给模型；当前[runMetadata.actorId](../../../packages/octo-runtime-extra-channel-gateway/src/execution/dispatcher.ts) 属于诊断/业务元数据，不自动注入模型。没有证据表明当前每轮已注入完整的 UID/昵称映射。
- Gateway 已为 Agent 工具执行提供 octo-cli 身份环境，见[渠道 CLI 环境任务](../channel-octo-cli-environment/brief.md)。本机只读 schema/help 已核实 `octo-cli group members <group-no>`，可返回 uid/name/robot；工具调用只需承担身份查询，不重复发送最终总结。凭据不进入模型 Context。
- 人类 Web 客户端和旧 codex-channel-octo 已有发送前标记转换，详见[源码依据](protocol.md)。尚未查到 IM Server 对应实现，也未完成线上通知验证，不能依赖仅发原始标记正文即可触发服务端通知。

## 需要区分的两条路径

| 路径 | UID 从哪里来 | Context 是否必要 |
| --- | --- | --- |
| Channel 普通回复 | 入站传输层已知 fromUid，但不自动附加 mention | 不需要为默认 @ 注入身份或成员表；该默认行为已决定不做 |
| Agent 主动 @ 其他人 | 当前 Context 中明确的身份、历史 from_uid，或经 octo-cli/API 查询确认的成员 UID | 模型需要可用身份信息；业务方可按需提交 extra Context，也可让工具查询，不强制每轮全量注入 |

来源身份不授予权限。候选 UID 必须在当前 Bot、Space 和频道作用域内使用；不能跨租户沿用昵称映射。同名、缺 UID 或无法确认成员时不得猜测目标，也不能退化为 @所有人。昵称文本与协议 mention 通知应分别验收。

## 已选执行路径

1. Channel 在新 Provider 会话首次输入时显式提交 `extra.im/mention-instructions`，通过已有 `guidance` 字段说明格式、查询入口和边界。Context v3、Run=7 保持不变，不新增顶层 instructions。后续提交时机由 Channel 决定，Host/Adapter 不缓存或补齐指引。
2. 模型理解当前用户是否要求通知某人，先完成任务；身份不足时按需通过工具查询当前群成员，确认真实 UID、显示名及真人身份。同名、查询失败或找不到合适目标时，由模型判断并降级为普通 `@名字` 或纯文本，不强制澄清、不猜 UID，也不要求展示点名未完成。话题使用已确认父群查询成员，回复地址保持原话题。
3. 模型最终回答的普通正文使用 `@[uid:displayName]`。模型不计算 entity offset，不构造原始发送 JSON，不为同一最终回答再调用 `octo-cli message send`。
4. Channel 仅在当前 final 文本确定后解析显式标记；thinking、工具输出和进度消息不触发通知。沿用身份与作用域校验，生成可读 `@displayName` 正文、去重的 mention.uids 与按出现位置记录的 entities，再扩展现有最终回复链传递 `content + mention`。REST 已有参数可复用；不另走 CLI 发送，不为 Bot 另造 IM 协议。
5. 普通 @昵称、代码块、行内代码和引用示例不作为点名指令，代码内容保持原样。发送前无法确认或校验失败的目标不生成 mention，能解析显示名时降级为普通 `@名字`，其他内容保留；不回退广播、不追加失败提示，其他有效目标仍可点名，最终正文继续交给原发送入口。

这里的“统一发送”指同一份逻辑最终回答，不额外经工具发送一次。若现有发送链需要分段，转换后的 entity 必须随正文切片重定位；不得另建持久投递账本。长文本分段不是另一个新增需求。

正文投递本身失败时沿用现有发送链的错误与重试合同；不因 mention 结果未知就新增一次纯文本补发，避免重复消息。本专项不承诺网络故障下必然投递成功。

## 修正此前设计的依据

此前把主动 mention、查询工具和发送工具绑在一起，又把显式结构标记与普通昵称字符串匹配混为一谈，导致“能否由最终回答发送”被错误地保留为待决项。强制模型用 CLI 再发总结会产生重复发送风险，也脱离现有最终回复链。

更符合模型工作方式的分工是：模型根据语义决定是否需要通知，通过工具补足真实身份，再在最终回答中表达点名意图；Channel 负责确定性的格式转换、范围校验和实际发送。解析已定义的显式标记不是猜测自然语言里的 @昵称。人类编辑器同样先选择身份再生成协议字段，复用这一过程可以保持真人与 Bot 的通知语义一致。

首次短 guidance 即可说明能力，不需要先强制安装专用 skill，也不必把全员名单永久注入。指引不是权限，历史中出现过的通知要求也不自动授权本轮通知。

## 剩余边界

Bot 作为出站目标时的明确授权、触发与循环控制，以及模型出站 all/humans/ais 广播是否开放，继续单独讨论，本期真人点名不自动开放这些范围。入站 `@所有AI` 已实现，不再属于待决广播范围。原生 reply 的通知及 Bot 触发行为仍需核对。入站群/话题免 @ 需求已明确拒绝，见[渠道架构规则](../../rules/channel-integration.md)；入站只认本条消息真实 UID 点名或有效纯 ais 元数据，不扫描正文补齐。

无效标记的反馈已决定不额外展示，不再列为待决项。模型判断降级，发送端不猜目标、不阻断正文、不为失败调用模型。reset、重启与 Provider 恢复失败后的指引提交遵循[Context 指引](context-guidance.md)及[历史专项](../channel-new-session-history/brief.md)，不新增持久化绑定、上下文或成员缓存。

## 验收依据

普通回复验收覆盖真人和 Bot 发起的 DM/群/话题：最终回复不因发起者身份、入站 @ 或正文 @昵称自动产生 mention 字段；模拟 A @ B，B 的普通回复不自动 @ A。此检查不代替其他 Bot 循环路径的评估。

显式真人点名验收覆盖：已知 UID 和工具查询两条路径、同名或找不到目标时模型可直接降级、成员查询失败、非成员/跨 Space 校验失败、多个目标、重复目标及正文前含 emoji 的 UTF-16 位置。所有点名失败路径均不阻断最终正文、不追加“未完成点名通知”等文案、不触发模型重跑或额外补发。一个目标无效不影响其他有效目标。

普通 @昵称和代码/引用样例不能触发通知，代码块内容保持原样；无有效目标时不生成 mention。仅 final 文本触发转换，thinking/工具/进度输出不触发；工具查询和最终回复不得各发送一份总结。

验证首次 Context 的 v3 格式、指引可见性及 reset/新 Provider 会话重提；后续空业务 Context 有效，显式重复输入必须完整转发。真实群/话题的接收端高亮、通知及返回原频道行为在 https://im-test.deepminer.com.cn/ 验证；若采用原生 reply，同时验证其通知与 Bot 触发行为。本次文档检查不代替上述功能验收。

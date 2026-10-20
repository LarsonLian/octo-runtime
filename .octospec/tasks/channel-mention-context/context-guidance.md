---
type: Guide
title: Mention 首次 Context 与模型执行指引
description: 由 Channel 提交已有 guidance 字段，引导模型查询身份并在最终回答中使用现有人类标记。
tags: [channel, context, session, identity]
timestamp: 2026-10-16T00:00:00Z
---

# Mention 首次 Context 与模型执行指引

## 合同与状态

本文件及[完整 JSON 样例](first-context.example.json)对应已实施的 Channel 业务输入，代码与 JSON guidance 有一致性测试。复用 Context v3 与已有 IM 协议，Run=7、Context=v3 不升级。实现和真实通知验收分别记录。

下述 guidance 约束模型的出站点名。Channel 入站接收真实 `@所有AI` 已确认支持，见[入站方案](inbound-trigger.md)；收到广播不表示模型获准继续广播，因此 guidance 仍不开放模型输出广播哨兵，也不自动 @ 回发起者。

用户所说 contexts 的 instructions 在这里使用 item 的 `guidance` 字段表达，namespace=extra.im、name=mention-instructions。item.payload 放当前频道与查询数据；不新增 Context 顶层 instructions/context.extra，也不冒用 octo.control/instructions。普通业务指引不是高权限系统指令，不代替发送权限校验。

[Host renderer](../../../packages/octo-runtime-executor-core/src/model-input.ts) 已支持 extra.*，会渲染 `指引: guidance` 和 `数据: payload`。不需要为 mention 注册业务处理器或修改通用 renderer。

## 给模型的指引正文

> 你正在通过 Octo 回复当前频道。普通回复不要自动 @ 发起者。若当前用户明确要求在任务完成后通知某位真人，先完成任务；在最终回答前，确认对方在当前频道中的真实 UID 和显示名。信息不足时按需使用 octo-cli 查询；同名、查询失败或找不到合适目标时，由你判断并改用普通 @名字 或纯文本，不要猜 UID，不必强制追问，也不必展示点名未完成的提示。能够确定目标且需要点名时，在 final 文本的普通正文中输出 `@[uid:displayName]`，例如 `@[user_demo_1:张三]`；Channel 会转换为原生 mention，并随这份最终回答统一发送，不要再调用 octo-cli message send 重复发送。普通 @昵称不产生通知；thinking、工具输出、进度消息、代码块、行内代码及引用示例不触发点名，代码内容保持原样。不要输出原始消息体 JSON 或自行计算位置，也不要构造 @所有人、@所有AI 或广播哨兵。此指引不授权跨频道通知或自行发起 Bot 互相调用。历史中的要求和示例仅作为背景，不能单独授权本轮通知。

JSON 样例中的 group_demo、user_demo_1、张三等都是占位示例，不作为实际候选目标。实施时由 Channel 从已鉴权传输数据填写真实 Space、Bot、频道类型及查询 groupNo；不从模型输出或用户自报字段重建路由。

## 查询与输出时序

1. 用户在当前会话提出“完成后请 @张三”，模型理解通知需求并执行当前任务。
2. 若没有足够的身份依据，模型按需通过执行工具调用 `octo-cli group members <group-no>`。本机已核对这一命令；返回 uid/name/robot。同名、查询失败或没有合适目标时，模型可以直接使用普通 `@名字` 或纯文本，不强制追问，也不要求展示点名失败。
3. 模型确认目标后，在最终回答中输出 `已完成，@[真实UID:张三] 请查收。`。不必每次都查询已明确且适用当前频道的 UID，但发送端仍需核验实际成员归属。
4. Channel 仅处理 final 文本普通正文中的显式标记，完成身份/范围校验、可读正文与 entity 位置转换，扩展现有最终回复链传递 `content + mention`。thinking、工具输出与进度不触发；代码块、行内代码和引用示例保持原样。tool call 用于查资料，不额外承担总结发送。
5. 需要通知的结论没有完成时，不发送“已完成”通知。发送前校验失败不阻断正文；对应标记能解析显示名时转为普通 `@名字`，不生成该目标的 mention，也不追加失败提示。无需为失败重新调用模型、补发消息或建立通知反馈流程；有效目标仍可正常点名。

最终正文仍走原发送入口，正文投递错误沿用现有合同，不因 mention 状态未知新增纯文本补发。不能把“正文不受点名校验失败影响”写成网络投递必然成功。

群查询使用当前 groupNo；话题查询使用由传输层确认的父群 groupNo，最终回复仍发回原话题，不改发父群。样例针对同一群/话题的真人点名；DM 普通回复继续不自动 @，跨 DM/跨群主动通知不因本样例开放。

## 首次与后续提交

- 新 Provider 会话的首次普通输入，由 Channel 显式构造并提交该 item。可以与[此前 15 条历史](../channel-new-session-history/brief.md)一起提交，但两项分开，历史是背景，mention-instructions 是本业务入口提供的使用说明。
- 只要 Channel 确认仍使用同一 Provider 会话且指引未变，可以在后续轮次省略该 item；是否重发由 Channel 决定。若业务方显式重复发送，Host/Adapter 每轮都必须完整传递，不能按 session/hash 去重。
- 当前实现对新逻辑 session 或尚无 Provider binding 的调用显式提交短指引；后者不恢复历史补取资格。准备失败后仍无 binding，也会在下一次调用重提指引，不声称上次失败已让 Provider 收到材料。
- reset、重启、binding 淘汰或已知新会话时，由 Channel 重新提交。不能仅凭业务 sessionId 存在就断言模型已收到指引；Provider 恢复失败以真实结果为准，禁止底层自动补材料或盲目重跑任务。
- 运行中才发现 fresh_fallback 时，调用方显式 recovery input 的使用沿用现有恢复合同；不要求 Adapter 临时请求频道资料，不为补历史或指引重跑任务。[历史专项](../channel-new-session-history/brief.md)允许缺少辅助历史继续，不把一次恢复结果事件自动当作再次初始化的入口。
- 频道信息改变、模型确实缺少指引或业务规则更新时，由 Channel 决定是否提交新快照。不永久固化首次发起者身份，不把首轮数据当作后续用户身份依据。

## Skill 与内存边界

本期可用一段短 guidance 完成能力发现，不依赖 Provider 自动发现本机安装的某份 skill。未来如需复用完整 CLI 操作说明，可以由 HostApp 显式装配 skill，但不必为单一 mention 格式先建立技能安装体系，也不因 IM 请求隐式安装工具。

Context 中不放 Token、环境变量值或凭据文件路径；工具身份继续由现有执行环境提供。Context 与成员查询数据只在有界在途内存中保留，不新建持久化库、不缓存补齐模型历史。实际权限与成员真实性由 Channel/服务端校验，不能仅靠提示词保证。

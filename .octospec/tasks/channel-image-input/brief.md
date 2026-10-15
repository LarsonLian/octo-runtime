---
type: Task
title: Channel Codex 独立图片输入专项
description: 仅将 Octo 独立图片消息接入 Codex，复用现有多模态输入。
tags: [channel, multimodal, adapter, context, testing]
timestamp: 2026-10-16T00:00:00Z
---

# Channel Codex 独立图片输入专项

## 已确认结论与状态

2026-10-15 用户进一步确认：本专项仅支持 Codex Adapter，且只支持独立图片消息。OpenClaw、Claude Code（cc）和其他 Adapter 不在本期图片支持范围；富文本内图片、合并转发内图片及其他媒体解析不纳入。本结论替代初稿的 Codex/OpenClaw 范围及消息形态待决项，不推断其他产品的所有原生能力。

本文件为初版开发简报，未修改代码或完成线上验收。图片支持不要求持久化 Context、不要求每会话工作目录，也不自动扩大到其他 Adapter、WeCom 或所有媒体消息类型。

## 当前依据

- [入站准入](../../../packages/octo-runtime-extra-channel-gateway/src/transport/normalize.ts) 只接受 type=1 且 content 为字符串的文本；[Channel](../../../packages/octo-runtime-extra-channel-gateway/src/transport/channel.ts) 将 content 转成 text。
- [请求构造](../../../packages/octo-runtime-extra-channel-gateway/src/execution/dispatcher.ts) 当前只提供文本，没有把入站图片传成 modelInputParts。
- [InvokeInput 合同](../../rules/invoke-input.md) 已有 text/image part，支持 PNG、JPEG、WebP；每组最多 4 张，单图 2 MiB，总计 8 MiB。沿用现有合同，图片字节不得转成说明文本或 URL 后声称模型已看到图片。
- [Codex app-server](../../../packages/octo-runtime-adapter-codex/src/app-server.ts) 已有 image part 到 data URL 的转换；完整 Channel 链路仍需接通。本期不调查或改造 OpenClaw 图片附件路径。

## 开发范围

1. Channel 识别独立图片消息，保留真实发送者、Space、DM/群/话题原地址和已有触发授权。单条独立图片形成一次合法 Codex 调用，不依赖用户再附带文本，不合并相邻文本消息。
2. Channel 获取当前图片原字节，按现有 inputs 生成 mimeType、规范 base64、byteSize 和 sha256。每条独立图片消息提交一张图片，沿用单图 2 MiB 和已有 MIME 类型限制；不因通用合同支持多图就增加本期批量图片需求。URL 只是获取来源，不作为图片内容替代品。
3. 复用 Host 与 Adapter 的多模态合同。图片放 inputs，不放 extra Context 的 JSON payload，不增加协议版本或业务能力准入门槛。
4. 下载使用当前 Bot 凭据和取消信号；实现重定向逐跳凭据限制、地址校验、类型校验及流式大小上限。不得把 Bot token 发给无关域名，也不得隐式安装下载工具或 Runtime。
5. 当前图片字节及解码副本只在有界在途内存中保留，结束、失败、取消或卸载时释放。确需临时文件时，先评估 Provider 必要性与清理行为，不默认新增图片归档。
6. 通过入站触发准入后，选中非 Codex Adapter（包括 OpenClaw、cc）时，独立图片消息明确返回本期不支持；不能静默丢图后继续执行、自动切换引擎或为其他 Adapter 发起图片执行。未通过群/话题 mention 门槛时保持静默，不发送“不支持图片”回复。

## 群/话题触发规则（已确认）

2026-10-16 用户确认：同一群聊内，别人没有真实 mention 就不得触发 AgentRun；同时明确支持用户主动选择的 `@所有AI`。文本与独立图片共用[Mention 入站判断](../channel-mention-context/inbound-trigger.md)：本条消息的 `payload.mention.uids` 包含当前 `config.bot_id`，或 ais 置位且 all/humans 未置位，同时满足发送者、Space 和群范围准入。DM 沿用现有私聊准入。

- 无 mention、仅点名其他成员且未使用有效 AI 广播、只有正文中的 `@名字` 或 `@[uid:name]`，均不触发当前 Agent。历史或引用正文中的 mention 不作为本条消息的触发元数据。
- 已有活跃 session 不放宽门槛；上一条消息 @ 过 Bot，也不授权下一条未 @ 的图片。不合并相邻文本与图片来推断触发意图。
- “独立图片无需附带文本”表示不要求说明文字，仍要求该图片消息自身携带有效 mention 元数据。先完成准入，再下载图片或调用 Provider。
- 群/话题免 @ 已被架构决策明确拒绝，不作为延期需求，不预留账号、群或会话级开关。有效 `@所有AI` 与单独点名共用准入，不要求广播同时列出当前 Bot UID；不引入代理身份触发。仅 @所有人 或 all/humans 与 ais 混合、且未点名当前 Bot UID 时，不触发。
- 若真实客户端暂不能为独立图片附带 mention 元数据，群/话题图片路径应记录为尚未打通；不得通过取消门槛声称支持。客户端发送能力属于接线核对，不改变触发决策。

参考旧插件 `/Users/lvsijia/github.com/Mininglamp-OSS/openclaw-channel-octo/src/inbound.ts`：采用其直接 Bot UID 与纯 ais 的协议判断及 all/humans 抑制 ais 的规则（约 1974–2005 行）；拒绝免 @、代理身份及正文名称匹配例外。旧实现还在 mention 判断前处理媒体下载，本专项把下载放在准入之后，不迁入旧插件的历史缓存策略。此前文档中“仅 Bot UID、所有广播均不触发”的表述由本次用户决定替代。

## 后续实现核对

- 核对独立图片消息的真实 URL、MIME 类型与触发元数据，按现有授权规则处理群/话题，不为纯图片绕过 @ 及发送者准入。
- 本专项不补取历史图片字节；历史中的图片元数据展示由历史专项另行确定。
- 下载失败、超限、格式不支持或损坏时返回明确错误，不改成文本执行。输入格式限制按已有协议处理，不隐式引入图片转码需求。

## 验收依据

自动检查覆盖独立图片无需附带文本、单图大小与类型边界、坏 URL、跨域重定向、取消释放、非 Codex 明确拒绝，并确认不展开富文本或合并转发内图片。连接 https://im-test.deepminer.com.cn/，以真实 Codex 验证 DM/群/话题授权及模型识图结果；记录实际 Provider 版本、成功与未覆盖项，不保存凭据或图片正文。OpenClaw 图片执行不列为本期验收。若变更协议，按工程规则同步构建 Worker、Runtime、桌面并重启相关进程。

群/话题需覆盖：未 @、仅 @ 别人、仅正文名称/标记或历史 mention、仅真人广播、已存在 session 但本条未 @，均为零 AgentRun、零图片下载、无回复；此前单独发过 @ 文本也不得改变结果。有效图片自身点名当前 Bot，或携带有效纯 ais 广播，且其他准入通过时，无附带文本仍能触发一次正常执行。UID 和 ais 同时命中也只接收一次；执行中的既有重试合同不变。

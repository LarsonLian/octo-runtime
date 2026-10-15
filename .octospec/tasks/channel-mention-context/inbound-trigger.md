---
type: Guide
title: 真实 Mention 与所有 AI 入站触发方案
description: 只按本条真实协议元数据判定点名，支持纯 ais 广播，拒绝正文匹配与免 @。
tags: [channel, identity, protocol, testing]
timestamp: 2026-10-16T00:00:00Z
---

# 真实 Mention 与所有 AI 入站触发方案

## 已确认目标与现状

用户明确要求：群聊普通交流不得启动 Agent；正文中的 `@李白` 可能只是 Markdown 报告或代码，不能据此生成通知或触发执行。同时支持用户主动选择的 `@所有AI`，它是显式 mention，不是免 @。

本文件属于[Mention 专项](brief.md)。2026-10-16 已在 [normalize.ts](../../../packages/octo-runtime-extra-channel-gateway/src/transport/normalize.ts) 实施 UID/纯 ais 判断，文本和独立图片共用入口；[channel.ts](../../../packages/octo-runtime-extra-channel-gateway/src/transport/channel.ts) 通过准入后才提交消息或下载。没有修改通用 Host、Adapter 或 Context renderer，Run=7、Context=v3 不变。下文保留设计依据与验收矩阵。

## 标记与实际协议

`@[uid:name]` 是编辑器或模型发送前使用的标记，由发送端在有效位置转换为可读正文与 `payload.mention`。仅在正文中粘贴这个标记，不保证生成元数据；接收端不负责猜测或补齐。出站 final 的转换仍遵循[已有协议方案](protocol.md)，代码块、行内代码及引用示例保持原样。

用户选择 `@所有AI` 后，接收端应能处理的最小文本消息 payload 为：

```json
{
  "type": 1,
  "content": "@所有AI 请各自检查这个问题",
  "mention": { "ais": 1 }
}
```

`content` 用于模型输入和展示，不参与 mention 判断。`ais` 是明确的协议标记，不能由正文中的“所有AI”推导。发送端可以额外提供 `uids` 和 `entities`，但接收 ais 不依赖列出全部 Bot UID，也不为展开广播查询群成员。线上标志使用数字 1；沿用旧插件对布尔 true 的读取，不接受字符串 `"1"`、`"true"` 或其他真值。

## 选定判断与行为矩阵

先保留现有身份和范围校验：拒绝自身发送的消息、错误 Space、未授权发送者、未配置群、未知频道类型及无效消息身份。话题按父群验证范围，执行和回复保持原话题地址；DM 保留原规则。

对通过上述校验的群/话题消息，只读取本条 `payload.mention`：

```typescript
const flag = (value: unknown) => value === 1 || value === true;
const direct = Array.isArray(mention?.uids)
  && mention.uids.includes(config.bot_id);
const aiBroadcast = flag(mention?.ais)
  && !flag(mention?.all)
  && !flag(mention?.humans);
const mentioned = direct || aiBroadcast;
```

实现时应校验 mention 是非数组对象，UID 数组只按真实字符串 UID 精确比较，不做字符串转型。格式错误不得变成触发或导致接收循环崩溃；独立有效的 UID 点名不被无关标记覆盖。

| 本条消息的真实 mention | 当前 Bot 是否命中 | 原因 |
| --- | --- | --- |
| 缺失、空对象，正文有 `@名字`/`@[uid:name]`/`@所有AI` | 否 | 不从正文补元数据，包括代码块、行内代码、引用和报告 |
| uids 包含当前 Bot | 是 | 直接 UID 点名 |
| uids 仅含其他人，无有效 ais | 否 | 没有通知当前 Bot |
| ais=1 或 true，无置位 all/humans | 是 | 显式 AI 广播，不要求 uids |
| ais=1，uids 同时包含当前 Bot | 是，一次接收 | 两个条件合并判断，不分路启动任务 |
| all=1 或 humans=1，无当前 Bot UID | 否 | 真人广播不触发 Agent |
| ais=1 且 all/humans 任一置位，无当前 Bot UID | 否 | 抑制混合广播的 ais 路径，与旧插件一致 |
| all/humans/ais 混合，但 uids 包含当前 Bot | 是 | 当前 Bot 的直接 UID 点名仍有效 |
| 只有 entities 或实体哨兵 -3，无 UID/有效 ais | 否 | entities 描述展示位置，不代替触发字段 |
| ais 为 0、false、字符串 "1"、字符串 "true" | 否，除非直接 UID 命中 | 不使用宽松 truthy 判断 |

表中“是”表示通过 mention 门槛；取消、既有命令、排队、限流及执行失败继续按各自合同处理，不承诺每条准入消息必然执行成功。即使同一消息同时有 UID 与 ais，也只形成一条逻辑任务；既有受控重试可产生多个执行尝试。

已有 session、上一条 @ 文本、历史消息中的 mention 和名称相同均不授权下一条未 mention 消息。无 mention 的消息在准入处静默返回，不拉历史、不下载图片、不启动 typing/模型，不发送提示回复。通过准入才做本轮历史准备和后续工作；不新增非 @ 消息的缓存或持久化。

## 与旧 OpenClaw 插件的取舍

源码依据是 `/Users/lvsijia/github.com/Mininglamp-OSS/openclaw-channel-octo/src/inbound.ts` 的 1974–2005 行，以及 `src/inbound.test.ts` 的 mention trigger matrix：纯 ais 可命中；all/humans 抑制 ais；直接 UID 仍可命中。旧源码注释提到服务端可能把历史 all 改写并附带 ais，因此保留混合标志抑制；这是已查客户端行为依据，不冒充 IM Server 实现或线上验证证据。

不采用旧插件约 2022 行的正文 `@botName` 正则回退。它不能判断用户是在点名，还是在报告/代码中展示文本，会把普通内容错误提升为触发意图。也不采用 requireMention=false、群免 @ 偏好、onBehalfOf 代理触发，或从历史 mention 推导本轮授权。

旧插件注释称正文回退用于兼容未填写 mention 的旧发送端，尤其是 Bot 对 Bot 的消息；这是作者说明的动机，不构成采用该方案的依据。按[架构责任原则](../../rules/architecture.md)，生产方漏填应在生产方修复，传输丢失应在传输层修复。接收端增加正则边界或 Markdown 排除规则仍是在猜测，不能替代正确的协议生成；本计划不沿这条路径继续增加复杂度。

当前桌面端 `packages/im-kit/src/core/mention.ts` 有 ais 标志与 Bot UID 展开逻辑，但实际 composer 是否传入完整机器人成员名单尚未核实。新增接收逻辑直接支持纯 ais，不能依赖这条未经验证的展开链路。实现验收须记录真实客户端发出的 payload，不能把测试构造等同于真实投递。

## 开发步骤

1. 在 Gateway 的 normalize 入站模块集中实现直接 UID/纯 ais 判断，保留现有身份、发送者、Space、群范围及消息类型校验。对同一入口返回一个准入结果，不新增配置、成员 API 查询、全局广播调度器或 Host 能力。
2. 为现有文本路径补齐协议矩阵回归，并在真实 transport 到任务调度链验证无 metadata 的 Markdown 报告不会调用 Host。复用现有 messageId 去重，确认 UID/ais 同时命中不重复提交；不新增持久化账本。现有命令处理和权限规则保持其合同，广播不授予额外审批或取消权限。
3. [Codex 独立图片专项](../channel-image-input/brief.md)扩展消息类型时复用上述同一判断，先准入再下载、再构造 inputs。文本 ais 支持可先完成，不依赖图片开发；图片验收另覆盖自身 ais/UID 元数据，不合并上一条消息的 @。
4. 检查最终回复和进度链：收到 ais 不自动复制该字段到回复，不自动 @ 发起者，不生成出站 AI 广播。发送者仍按当前准入规则判断，不因广播放宽，也不新增“已解决全部 Bot 循环”的承诺。
5. 构建并运行 Gateway 对应回归后，在 `https://im-test.deepminer.com.cn/` 用真实客户端验证文本广播、报告误触发及回复行为。已有多个已授权 Bot 时确认每个接收方独立判断，不建立跨 Bot 的“只允许一个回答”机制。真实广播未送达时核对客户端/服务端投递，不放宽无 metadata 门槛。

## 验收与交付

- 单元与集成覆盖上述矩阵、群和话题、自身消息、未授权发送者、错误 Space、未配置群和 DM 原行为。负例不调用 Host，不产生任务副作用；text-only Markdown 报告中的名字和 UID 标记均不能触发。
- 接收纯 ais 不需要展开 uids 或调用成员查询；直接 UID 和 ais 同时出现只接收一次。同一 messageId 重投沿用现有有界去重，不扩大为重启后恰好一次承诺。
- 真实测试环境从 mention 选择器选择 @所有AI，核对实际 metadata 与符合准入的 Bot 执行；手打同形文字或粘贴代码/报告但没有 metadata 时零 AgentRun。混合 all/humans/ais 的矩阵可用受控测试报文补足，并明确区分真实客户端与构造报文证据。
- 真实返回消息不带自动生成的 ais 或发起者 mention，其他 Bot 不因普通回复的正文名称被唤醒。无法覆盖的客户端、话题或图片发送能力如实记录，不把本文当成上线验收。
- 交付源码、针对性测试、构建结果及脱敏验证记录；记录消息元数据形态和执行次数，不保存 token、群消息正文或图片。仅在实际变更协议时执行工程要求的跨项目同步构建与重启，本计划本身不变更协议。

当前代码已实施；[准入矩阵测试](../../../test/im-mention-trigger.test.js)覆盖组合、类型及正文反例，真实链路验证与客户端表现另行记录。

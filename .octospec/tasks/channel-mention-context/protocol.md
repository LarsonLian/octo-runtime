---
type: Guide
title: IM Mention 协议与人类客户端对齐依据
description: 区分模型/编辑器标记和实际消息体，复用真人点名的 content 与 mention 字段。
tags: [channel, identity, delivery, protocol]
timestamp: 2026-10-16T00:00:00Z
---

# IM Mention 协议与人类客户端对齐依据

## 核实结论

当前可查源码表明，人类 Web 客户端和旧 codex-channel-octo 都在发送端把 `@[uid:name]` 转成可读正文及 mention 元数据。Bot 应复用同一标记、字段与语义，不另造 Bot 专属协议，也不要求模型另用 CLI 发一遍总结。

本次没有取得 IM Server 的对应实现，也没有发送线上验证消息。因此不能宣称服务端绝不解析标记，但同样不能依赖“只发送原始标记正文，服务端就一定自动通知”。实施以已核实的客户端消息体为基准，线上效果另行验收。

## 两层格式

| 层次 | 示例 | 用途与处理方 |
| --- | --- | --- |
| 编辑器/模型发送前的标记 | `@[user_demo_1:张三]` | 明确绑定 UID 与显示名；发送端确定性转换 |
| 实际消息体 | `payload.content` 与同级 `payload.mention` | 与人类客户端相同，交给 IM 传输和接收端消费 |

`@张三` 只是普通正文；`@[uid:name]` 是本专项约定的发送前显式点名标记，不使用 Markdown 链接式 mention。标记中 UID 为接口返回的完整原值，不按昵称、前后缀或大小写推断身份；name 为显示名，不作为身份或授权依据。入站接收端不解析这两种正文来触发 Agent，只检查当前消息真实 `payload.mention`。报告、代码块或引用里粘贴原始标记而未生成元数据，不构成真正的 mention。

采用客户端已有的标记语义，不等于复制某个客户端的全部正则与广播回退。协议位置、UID 数据约束及边界必须显式校验，不复刻旧项目把普通 @昵称猜成通知的路径。

2026-10-16 补充决策：仅解析最终 final 文本普通正文中的标记，thinking、工具输出和进度不触发通知，代码块、行内代码及引用示例保持原样。模型无法确定合适目标时可直接输出普通 `@名字` 或纯文本；发送前校验失败不生成该目标的 mention，不阻断最终正文、不附加失败文案，也不另建通知补发流程。正文投递错误沿用原发送合同。

## 实际发送示例

模型最终回答：

```text
已完成，@[user_demo_1:张三] 请查收。
```

Channel 的发送消息体（示例 ID 均为占位数据）：

```json
{
  "channel_id": "group_demo",
  "channel_type": 2,
  "payload": {
    "type": 1,
    "content": "已完成，@张三 请查收。",
    "mention": {
      "uids": ["user_demo_1"],
      "entities": [
        { "uid": "user_demo_1", "offset": 4, "length": 3 }
      ]
    }
  }
}
```

| 字段 | 已核实的语义 |
| --- | --- |
| channel_type | 1=DM，2=群，5=话题；由原入站地址确定，不由模型覆盖 |
| payload.type | 本专项是文本消息，值为数字 1 |
| mention.uids | 被点名的 UID；与正文对应，建议去重，同一人出现多次不重复通知目标 |
| mention.entities | 每个可见 @ 段的 uid/offset/length；同一个人多次出现可以有多个 entity |
| offset/length | 转换后的 content 中 UTF-16 code unit 的位置和长度，包含 @，不是原标记位置、UTF-8 字节数或 Unicode 字符数 |

示例中“已完成，”占 4 个 UTF-16 code unit，`@张三` 长度为 3。显示名替换、正文截断或分段后必须重新保证位置正确，不能把模型给出的数值直接当作可信结果。模型不需要计算 offsets。

发送同一份 `content + mention` 是对齐人类通知与高亮的必要输入；最终的通知、角标与客户端显示仍要在真实 IM 验证。只看到正文中的 @，不能证明真实 mention 成功。

## 广播与 Bot 的边界

人类客户端完整协议还识别 all/humans/ais，线上置位使用数字 1；广播哨兵包括 -1（历史 all）、-2（真人广播）、-3（AI 广播）及渲染用 all。客户端对广播标记有额外来源约束，不能把模型输出的哨兵当作编辑器可信节点。

出站确认范围仍是同一频道内对另一个真人的点名。普通 @所有人、@所有AI 和模型输出哨兵不自动转换为 all/humans/ais，也不展开成员列表群发。模型主动广播、Bot 点名与循环控制继续独立待决，不将真人示例自动扩展为 Bot 相互触发。

入站 `@所有AI` 已于 2026-10-16 实施：纯 ais 标记可触发各个通过既有准入的 Bot，不依赖发送端展开所有 UID；all/humans 置位时抑制 ais 路径，直接 Bot UID 点名仍有效。采用旧 OpenClaw 插件的该段判断，排除正文名称匹配及免 @。具体规则见[入站方案](inbound-trigger.md)。im-test 实测会为含 ais 的请求扩展 Bot UID 列表，即使同时带 all；接收端按最终收到的 UID 判断，不推断 UID 是否来自服务端展开。自动化单独覆盖不带 UID 的纯 ais 与混合标志。

## 源码与 CLI 依据

| 来源 | 本次核查位置与结论 |
| --- | --- |
| octo-web | `packages/dmworkbase/src/features/chat-composer/ui/ChatComposer.tsx` 的 formatMentionTextV2 和发送前调用：编辑器标记先转成 content/mention；`adapters/tiptap/mentionSendParse.ts` 解析标记并校验当前成员，计算 entity 位置 |
| octo-work-app | `packages/im-kit/src/core/mention.ts` 的 serializeMention、toWireMention、isMentionMe、splitMentionParts：点名、广播及高亮的客户端语义；布尔视图转换为线上数字 1 |
| codex-channel-octo | `src/agent-bridge.ts` 注入标记指引；`src/mention-utils.ts` 转换；`src/stream-relay.ts` 发送前生成 mention 参数。旧实现另有普通昵称匹配及 all 回退，本次不采用 |
| Runtime Gateway | [MentionEntity](../../../packages/octo-runtime-extra-channel-gateway/src/transport/api/types.ts) 明确 UTF-16；[sendMessage](../../../packages/octo-runtime-extra-channel-gateway/src/transport/api/messages.ts) 与 [WS sendText](../../../packages/octo-runtime-extra-channel-gateway/src/transport/wukong.ts) 均支持 payload.mention；成功 final 由 Channel 转换并沿 WS 发送 |
| 本机 octo-cli，只读 schema/help | `schema group.members` 与 `group members --help` 确认查询命令及 uid/name/robot；`schema message.send` 确认 payload 对象和发送地址，但该 schema 没有展开 mention 子字段，不能用它单独证明全部内部约束 |

协议核查不等于发送验收。本次只读源码与 CLI schema，无外部消息发送、无凭据读取，无 IM Server 单端实现证明。

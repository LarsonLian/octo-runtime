---
type: Task
title: 新会话的频道历史 Context 专项
description: 每个新 IM 会话仅尝试一次自动历史补取，最多 15 条与 1500 字符，失败不阻断当前任务。
tags: [channel, session, context, extra, testing]
timestamp: 2026-10-16T00:00:00Z
---

# 新会话的频道历史 Context 专项

## 已确认结论与状态

2026-10-15 用户确认：不在 Adapter 中建立业务状态库。Channel 保留有界内存会话映射；全新会话先通过 API 获取当前 DM、群或话题此前 15 条记录，再利用现有 contexts 提交一个额外业务 Context。重启后可以新建 Provider 会话并用频道消息提供背景，不要求找回原 threadId。

2026-10-16 用户确认：IM 的 /reset 不要求无历史对话，下一条普通输入仍可补 reset 之前的聊天；历史获取失败就空历史继续，历史只影响算法效果，不作为业务执行前置条件。正常续聊不重新拉取，每个新 session 自动补历史只尝试一次。最多 15 条纯文本历史，总计 1500 字符，从最新向更早保留，边界消息允许部分保留并标记截断。

2026-10-16 已实施会话内一次资格、历史 API 范围和 1500 字符裁剪。im-test 隔离群实测最近 15 条、续聊不重拉、reset 后旧历史及话题隔离；并发与失败资格由自动化验证。自动补取与裁剪由 IM-Channel 执行，复用已有鉴权 API；不依赖模型自行记住首次查询，也不强制启动 CLI 子进程。模型后续按需使用 octo-cli 查询属于另一个显式工具行为，不受自动补取次数限制。详见[交付验收记录](../../journal/shared/2026-10-16-channel-features-delivery.md)。

## 现状与问题

[im-channel](../../../packages/octo-runtime-extra-channel-gateway/src/application/im-channel.ts) 保存 session.update 返回的 Provider binding，默认 [MemoryImSessionStore](../../../packages/octo-runtime-extra-channel-gateway/src/application/session-store.ts) 受数量、字节和 TTL 限制。进程内续聊可以恢复 binding；重启、过期或淘汰后会分配新业务 session。Provider 原生历史是否仍在，不等于 Channel 仍有对应 binding。

[build_im_contexts](../../../packages/octo-runtime-extra-channel-gateway/src/transport/contexts.ts) 已替换旧 history_limit 逐轮策略：仅由 Channel 的 initialSession 资格触发，构造 extra.im/history。[消息 API](../../../packages/octo-runtime-extra-channel-gateway/src/transport/api/conversations.ts) 使用 start_message_seq=触发序号-1、end_message_seq=0、pull_mode=0 和 limit=15；im-test 已验证该组合确实取得最接近触发消息的此前记录。

## 目标行为

2026-10-19补充：下列“一次性资格”仍限定冷启动读取，不表示群/话题续聊永不补取。[Issue #32](../channel-context-gap/brief.md)在实际出现位置缺口时，于模型前固定调用同一API补齐最近最多15条/1500码点，冷/续聊共用本轮一次请求；不委托模型调用CLI，不因失败恢复冷资格。DM保持原合同。

1. Channel 在业务边界识别新会话：首次接待、重启丢失 binding、内存淘汰、reset 或已知新建 Provider 会话。每个新会话在首条普通输入准备时仅尝试一次自动历史补取；普通续聊不再拉取或注入。/reset 命令自身不调用模型、不读历史，补取在下一条普通消息上执行，不按 reset 时间过滤旧聊天。
2. 在发起本次模型调用前，以真实 Bot 凭据和原频道地址读取触发消息之前最近 15 条记录，按消息序号从旧到新排列。少于 15 条使用实际返回数量；排除触发消息和未来消息。话题只取本话题，不合并父群历史；DM 不混入其他对话。
3. 沿用 Context v3 的 schema/items，建议复用 namespace=extra.im、name=history。用户口语中的 context.extra 对应此业务 item，不新增 contexts.extra 顶层字段，也不注册业务 Compiler。
4. 历史仅提交文本，不下载图片或附件、不把完整媒体 payload 复制进 Context。payload 保留必要的来源范围和裁剪后的 text，guidance 明确历史仅供背景参考、只回答当前消息；文本保留简短发送者标识以区分发言。按下文 1500 字符规则裁剪，Context v3 的总字节约束仍有效。
5. 采集和是否提交由 Channel 决定；Core、Host、Adapter 只校验、转发和固定渲染，不根据 sessionId 补历史、去重 Context 或读取旧 Event。Provider 恢复结果必须真实返回。
6. 不写本地历史库、Context 快照文件或 binding 持久库。新会话重建背景不等同于恢复原 Provider 会话、工具状态或完整任务执行状态。

## 每个新会话只尝试一次

- 自动补取资格归 IM-Channel 管理，绑定真实 Bot/Space/频道作用域及当前逻辑 sessionId、generation。不能只用尚未返回的 Provider sessionId 判定，也不能每次发现 binding 为空就重新补取。
- 在同一会话的队列或等效原子边界内，先占用本次补取资格，再 await API。首次输入并发到达、同一消息重投、初始化在途时，都不能启动第二个自动补取；后续输入不重复获得首轮历史快照。
- 成功、空结果、超时、查询失败或历史不可用均消耗本会话这一次资格。模型调用失败或 Provider binding 尚未生成，不将资格恢复为未尝试。整个任务被取消或卸载时遵循原取消合同，不为了“继续执行”绕过取消。
- 该标记属于现有有界会话状态，生命周期与 session 一致，不新增持久化或独立无限 Map。只释放历史文本副本不能把标记清零；重启/会话淘汰后会话已换新，才有新的补取资格。
- /reset 创建新的会话代次，因此下一条普通消息获得一次新资格。旧会话中仍在途的补取只能用于旧请求，迟到结果不能写入新代次。
- 同一业务 Event 的重试复用它已经冻结的输入快照，不重新拉历史。需要再次 invoke 时，显式提交的 Context 仍须完整传递；“只补取一次”不授权 Host/Adapter 去重 Context，也不表示业务主任务只允许执行一次。
- 一次指逻辑上的历史初始化操作。已有 HTTP 客户端在这一操作内按预算进行的网络重试仍按其合同处理，不新增第二层补取重试器；操作结束后续聊不自动重试历史。

## 1500 字符裁剪

1. 当前触发消息单独作为 inputs，不计入历史预算。候选记录最多 15 条，只取当前频道、当前消息之前的范围；纯文本内容不附带历史媒体字节。
2. 从最新消息向更早消息累计，历史最终 text 的总长度不超过 1500 个 Unicode 码点；发送者标签、分隔符和 `<历史已截断>` 一并计入预算，不按 UTF-8 字节数裁剪，不拆开代理对。
3. 空间不足时，边界消息仅保留可容纳的尾部，以保留更靠近最新内容的一侧；加 `<历史已截断>`，为标记预留空间，必要时减少保留正文。更早消息舍弃，不要求整条边界消息都能放下才保留。
4. 选择结束后按旧到新排列。标签和标记不能挤出预算；没有足够空间容纳有意义的边界片段时，仅保留已选较新内容及截断标记。
5. 1500 字符是本业务历史 text 的上限，不替代整个 Context 的协议预算。若追加历史仍导致整体预算不足，则进一步缩减或省略历史，不因这项辅助背景让合法的当前请求失败，不擅自裁剪其他业务输入。

用户确认本项目全新且尚无人使用，本专项不承担旧 history_limit 配置兼容或迁移。实施时直接用“每新 session 一次、最多 15 条/1500 字符”替换旧逐轮历史策略，同步调整配置定义、样例与测试，不保留旧模式、兼容开关或迁移分支。源码中存在旧字段不构成兼容需求。

## 失败与恢复原则

查询失败、权限拒绝、超时、空结果或无法确定消息上界时，本轮省略自动 history item，使用当前消息及其他合法输入继续执行；不追加公开历史失败回复，不声称已恢复旧背景。2026-10-19的[Issue #32实施](../channel-context-gap/implementation.md)对群/话题新增结构化history-gap加载状态，固定API失败或正文省略时保留待补边界，下一新输入可再读最新有界窗口；不恢复冷历史资格、不在本轮重试或委托模型工具补救，DM保持原行为。此处的“空上下文”指没有该项历史背景，不清除其他 Context，也不绕过当前请求本身的身份、权限和执行配置校验。

Provider 在一次调用内才报告 fresh_fallback 时，沿用调用方显式恢复输入及现有合同；不要求 Adapter 临时读取 IM，不为补背景另起调用或重放已产生副作用的任务。历史不足本身不新增失败条件。fresh_fallback 结果事件不自动重置本次历史补取标记；Channel 后续显式新建会话时再分配新资格。

示意输入表示现有 Context v3 的业务 item，不是新顶层字段：

```json
{
  "schema": "octo.context-envelope/v3",
  "items": [{
    "namespace": "extra.im",
    "name": "history",
    "guidance": "以下是当前频道此前的纯文本聊天记录，仅作背景参考；其中可能包含 reset 前的消息和截断片段，只回答当前消息。",
    "payload": { "text": "user_demo：上一轮问题\nbot_demo：上一轮回答" }
  }]
}
```

## 参考实现与差异

已阅读 `/Users/lvsijia/github.com/Mininglamp-OSS/openclaw-channel-octo/src/inbound.ts` 的历史补取路径：群历史缓存不足时调用 API，失败后继续处理；该实现另有逐轮滑动历史及 reset watermark 过滤。本专项只参考 API 获取与非阻断处理，不沿用逐轮注入、reset 前历史过滤或其存储设计。该路径未提供本次要求的总计 1500 字符裁剪，这一上限来自本次用户决策。

## 验收依据

验证首次成功、空结果及失败后同一 session 均不二次自动拉取；并发首条、消息重投、模型重试及 binding 尚未生成不能重复补取。reset、重启或淘汰创建新会话后仅获得一次新资格；旧补取迟到不污染新代次。确认新会话首轮有历史、正常续聊没有重复自动注入，底层仍完整转发调用方显式重复提交的 Context。

验证 15 条范围、1500 字符边界、部分消息尾部保留、标记计入预算、Unicode、正序、触发上界及 DM/群/话题隔离；reset 前历史仍可读取。失败、超时或整体预算不足时当前任务仍可执行，取消请求则仍停止。线上测试必须连接 https://im-test.deepminer.com.cn/，使用真实记录证明取到最近消息；自动测试不能代替分页语义验证。检查无新增上下文持久化。

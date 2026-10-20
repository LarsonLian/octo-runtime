---
type: Rule
title: 会话归属与 reset
description: 业务映射、Provider binding 与有界 IM reset 的职责。
tags: ["session","reset"]
timestamp: 2026-10-20T00:00:00Z
implementation_baseline: df63c8f
id: runtime-session-reset
tier: repo
priority: 90
load_bearing: true
inject_when:
  paths: ["packages/octo-runtime-extra-channel-*/**","packages/octo-runtime-protocol/**","test/*session*","test/im-*"]
  touches: ["session","reset"]
source: self
supersedes: []
---

# 业务会话、执行 Session 与 Reset

业务方拥有 `conversation_id → 当前 session_id` 映射。Runtime 使用调用方已确定的执行身份和 opaque Provider session，不管理业务会话历史，不从旧请求补背景。Run 保持 7，Context 保持 v3。

## 身份与重置

`conversation_id` 表示业务会话，reset 前后不变。逻辑执行 session 在普通续聊中复用，reset 后换新；Provider 返回的 `sessionId` 是另一层原生恢复标识，存在该值不保证恢复成功。

业务入口拦截 `/reset`，成功回复“会话已经重置”。命令自身不调用模型，不创建执行 Run，不删除历史、产物、工作目录或 Provider 长期记忆。reset 不等于取消；取消使用独立执行入口。

当前 IM 实现采用延迟分配：reset 清除 session 与 Provider binding、增加 generation，下一条普通输入入队时生成新的 session。已入队请求保留原先冻结的身份；旧执行的迟到更新不能恢复当前 binding。详见 [im-channel.ts](../../packages/octo-runtime-extra-channel-gateway/src/application/im-channel.ts)。

新 session 所需的背景由下一轮业务发起方明确提供，执行层不读取旧 Event 或聊天历史自动补齐。

2026-10-15 用户确认 IM Agent 固定 workdir；每会话目录不是需求。reset 只切业务 session、代次和 Provider binding，不切目录或删除产物；延迟分配的现有实现不应改成修改旧 Provider 的 opaque ID。2026-10-16 进一步明确这是 IM 层的架构决策，不是功能计划，也不要求通用 Host 限制其他调用方的合法目录配置。决策依据及共享文件、并发影响评估见[固定目录决策](../tasks/channel-fixed-workdir-decision/brief.md)，分层责任见[IM Agent 与 invoke 边界](../guides/im-agent-invocation-boundary.md)。

IM reset 不要求无历史对话。已实施的[历史策略](../tasks/channel-new-session-history/brief.md)为：下一条普通输入可补 reset 前的最近聊天，每新 session 仅自动尝试一次，最多 15 条/1500 字符；失败或空结果也消耗本次资格，当前任务空历史继续。正常续聊不自动重新拉取；重试复用冻结快照。一次性资格由 Channel 在有界会话状态中管理，Host/Adapter 不去重或补齐 Context，不增加持久 reset 屏障。2026-10-16 im-test 已验证 reset 后补旧历史且工作目录不变，详见[交付记录](../journal/shared/2026-10-16-channel-features-delivery.md)。

## 当前内置 IM 存储

Issue #32的群/话题gap元数据附于同一有界binding，无旁路聊天库。观察与ACK只原子patch已有同session/generation条目，不续TTL、不改淘汰顺序；reset清除旧元数据，旧turn/ACK不能更新新代次。固定历史API在模型前完成，第一次交接只推进本地prepared事实，不宣称Provider已接受或Agent已读；API失败或正文被预算省略时保留待补边界。Provider显式fresh_fallback只使下一条新输入重新取最多15条，不重拉本轮历史或另起invoke；同代次卡片重试复用冻结快照，不重新采集。详见[缺口状态机](../tasks/channel-context-gap/design.md)。

### 调度状态与业务 binding 分开

Octo 与 WeCom 的 `ImRuntime.#sessions` 只登记有排队或在途执行的调度对象，不是历史会话列表，不设累计 128 个会话的接待门槛。当前队列计数为零且没有活动 invocation 时立即删除；准备失败、Provider 异常、控制命令和拒绝入队也执行同一释放检查。终态后的最终投递仍属于当前队列工作，投递结束后再释放。

状态查询的 `sessions` 只返回上述在途条目。`/session` 从业务 store 恢复 binding 和最近 Run 元数据；回收调度对象不主动 reset 或删除业务 binding。卡片 cancel 按当前 key 与 invocation 查找；retry 重新进入当前队列，不能捕获并重新使用已经释放的调度对象。

单设备每天一万个 Session 表示累计接待量，不等于一万个并发模型执行。已有每 Bot 64 条待处理消息限制继续约束在途消息，不随历史会话数量消耗；默认 store 的容量和期限仍是下述独立业务合同。此修复不代表 AdapterHost 的历史源窗口已经移除，也不承诺默认内存 store 保存一天内全部一万个 binding。

未配置宿主工厂时，当前 [Octo 接入模块](../../packages/octo-runtime-extra-channel-gateway/src/daemon-module.ts) 使用 [MemoryImSessionStore](../../packages/octo-runtime-extra-channel-gateway/src/application/session-store.ts)，不创建 `im-sessions.db`，不承诺跨进程恢复。WeCom 包使用自己的同类内存实现。

| 数据 | 数量上限 | 序列化大小上限 | 保留时间 |
| --- | --- | --- | --- |
| session binding | 1024 | 4 MiB | 24 小时 |
| 消息 occurrence | 4096 | 16 MiB | 120 秒 |
| reset 去重 | 4096 | 1 MiB | 120 秒 |

访问时检查过期，另有 10 秒清理定时器；超限淘汰最早项。模块关闭时清理映射。重启、过期或淘汰后创建新 session，不声称恢复旧 Provider 会话。去重只在当前窗口内有效，不是持久投递保证。

Work App 的业务会话和完整事件保存在它自己的存储中，不属于 Runtime SQLite；宿主负责自己的 reset 持久化和历史展示。

## Gateway 宿主存储工厂

2026-10-20 Issue 57：GatewayDependencies 扩展 ChannelDependencies，可选 createSessionStore(JsonObject): ImSessionStore 只属于 Gateway。每个启用且配置有效的 Bot 使用已校验且再次复制的完整 Bot JSON（包括宿主扩展 scope）创建独立句柄，经 Extra→Manager→ImRuntime 实际读写。宿主负责可信账号/组织/助理 scope、SQLite、保留期限及事务，不从入站消息推断存储归属。未提供工厂仍使用上述 Memory；工厂或存储异常不得回退。

工厂返回值由 Manager 拥有；直接 sessions 继续借用且与工厂互斥。读写同步，close 可异步且只释放句柄，不能关闭宿主共享数据库。停止接纳及取消后，等待队列和原调用收尾，允许同 session/generation 的真实 session.update 写入，不继续展示/交互/最终投递；reset 后迟到更新不得覆盖新代次。释放一次，失败结果持续报告。draining 存储异常即使被业务诊断捕获也使 cleanup 失败，不能以句柄释放成功掩盖绑定写入失败；正常停止不进入未知结果展示或再次 flush presentation。owner abort 立即启动 Manager 清理，不等待挂起 initializer。

Manager 清理最多 5 秒，与 Extra 既有宽限协调；超时撤销旧包装句柄访问，失败记录阻止替换，不能假报宿主资源已释放。宿主负责 draining 期间可写及最终期限撤权。方法合同、错误观察和完整 SDK 示例见 [SDK 第 8 节](../../SDK_CHANNEL_GATEWAY_GUIDE.md#8-宿主会话存储与重载恢复)，范围与验收见 [任务](../tasks/channel-host-session-store/brief.md)。

## 验证入口

- [im-host-session-store.test.js](../../test/im-host-session-store.test.js)：工厂装配、SQLite 重开、scope/reset、句柄关闭与 SDK 生命周期。

- [im-session-store.test.js](../../test/im-session-store.test.js)：映射、reset、容量、过期与关闭。
- [im-session-scheduling.test.js](../../test/im-session-scheduling.test.js)：两种渠道分别接待一万个不同会话、闲置回收、续聊、卡片重试、失败、排队、reset 与关闭；使用 `--expose-gc` 时额外断言预热后堆内存增长。
- [im-runtime.test.js](../../test/im-runtime.test.js)、[im-wecom.test.js](../../test/im-wecom.test.js)：入口控制命令与执行行为。
- [stateless-executor.test.js](../../test/stateless-executor.test.js)：daemon 不创建数据库、重启不恢复旧 Run。

这些是当前测试入口，不表示本次文档整理重新完成了真实 IM 收发或线上执行验收。

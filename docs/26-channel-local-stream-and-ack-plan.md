# Channel 专项：本地 invoke、内存续流与 ACK

本页说明本地 Channel 的执行流和回执边界，架构见 [Runtime 合同](runtime-local-and-online-contract.md)。

daemon 本地 SDK 与共享 Host 独立运行；Octo 与 WeCom 接入按宿主选择携带和显式启用，不要求 Worker 包或设备注册。

## 1. 接入边界

所有本地 IM 和本地助理都调用本机 Host，不将本机输出上传云端再经 SSE 拉回。

业务接入使用注入的共享 Host，复用 Adapter、取消和交互能力。Octo 与 WeCom 协议分别位于 `octo-runtime-extra-channel-gateway` 和 `octo-runtime-extra-channel-wecom`；当前仓库不再提供 Worker 接入包。

Octo 接入已有私聊、显式群／话题触发、可选 GROUP.md／历史读取、会话复用与重置、模板进度卡、typing 和最终文本回发。WeCom 使用自身的 stream 回复协议。代码支持不等于线上闭环验收；群／话题、规则／历史及按钮的实际验证范围以专项记录为准，见 [Octo 接入说明](../packages/octo-runtime-extra-channel-gateway/README.md)。

Work App 使用 daemon SDK 的 `invoke()` 和既有唯一 preload 桥。renderer 不获取登录 token，kit 通过 Provider 注入的 Port 调用。业务自行消费完整 CanonicalEvent，自己保存和投递。

## 2. ACK 结论

| 机制 | 是否需要 | 原因 |
| --- | --- | --- |
| invoke / cancel / respond 的 RPC 响应 | 保留 | 确认命令受理与参数错误 |
| Runtime 命令受理 ACK | 保留 | 区分接纳与未接纳；不等于每事件确认 |
| 逐事件 ACK / durable ACK | 删除 | 不持久化传输队列，不按确认删除事件 |
| 重连 after_seq | 保留 | 描述消费者最后连续收到的位置 |
| IM 发送回执和重试 | 应用决定 | 是 IM 投递责任，不能冒充执行层持久化 |

正常连接没有累计事件 ACK。短暂连接中断的修复依赖 Host 内存源窗口，与 SQLite 无关。没有理由为此增加逐事件 INSERT、确认水位 UPDATE 和 ACK DELETE。

## 3. 本地 RPC 与重连

默认走 UDS / Windows Named Pipe，无本地 HTTP SSE 服务。

```text
业务 invoke → Host 接纳 Run → 同一 IPC 连接收到 canonical notifications
连接中断 → 同一源的 after_seq 补发 → 继续接收新事件
```

`agent_run.invoke` 接受 adapter 与完整 InvokeRequest，返回一次源身份响应。后续通知包含 `run_id`、`stream_id`、`seq`、完整 `event`。SDK 将其还原为 CanonicalEvent AsyncIterable，不改写或裁剪 payload。

只有连接修复使用 `agent_run.subscribe`。源身份不可变、游标排他，收到重复序号可以去重。源变化、窗口覆盖、序号超出尾部都明确失败。断线不重新 submit，不宣称执行结束，也不显示“执行已完成，正在同步答复”作为兜底。

Host 默认 128 Run、每 Run 4 MiB / 4096 条、总事件 64 MiB、单条 256 KiB、120 秒、16 IPC 订阅。保留不受消费者 ACK 控制；慢连接不能固定占住无限旧帧。Host 进程重启不保证旧事件恢复。

本地读取受账户 Home、OS 用户和 socket 边界保护。未来公开 WS listener 必须增加鉴权和作用域校验；本轮没有公开 WS listener。

## 4. SQLite 是业务历史，不是传输 outbox

Work App 保存完整 CanonicalEvent，包括 payload 扩展、工具数据、交互和终态。UI 投影可以过滤不公开内容，但原始事件不能因此少字段或少事件。

采用 WAL，事件每 64 条或 250ms 一次追加事务，终态和切换账户时刷新。Session、消息、provider session 与展示投影独立保存；不随每个 delta 重写整段历史。所有事件保留为业务历史，没有消费 ACK 后删除的生命周期。

因此本次消除的是 Infra 的逐事件持久 outbox 与 ACK 删除成本，不是承诺产品历史零写盘。SQLite 事务、磁盘、事件大小仍有成本；需要以实际设备、并发和负载测量，不凭静态推断给出性能下降比例。批量提交有尚未刷盘的一批丢失风险，不能承诺断电后零丢失。

IM Gateway 若需要送达保证，应保存自己发送意图、目标消息 ID 和重试状态；不要求 Host 保存它的业务队列。Run 完成只表示执行完成，不等于 IM 投递成功。

## 5. 专项验收

1. 相同本地消息只 invoke 一次；IPC 断线后从源游标补发，不重新运行 adapter。
2. 原始事件完整进入业务存储；展示过滤不影响持久数据。
3. Host 默认事件数据库写入与事件 ACK 为零；应用无 ACK DELETE。
4. 缺口、源过期、Host 重启和投递错误分别可观察，不制造“完成但等同步”的永久状态。
5. IM 私聊、群聊和 GROUP.md 分别验收；私聊通过不能代替群聊、卡片或多端同步验收。

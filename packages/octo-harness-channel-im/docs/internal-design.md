# IM 包内部结构与卡片 / typing 设计

状态：本轮基础实现已落地；剩余能力和真实环境验收见 [README](../README.md)。本文中的 connector 专指 IM 平台连接器，不是 MCP 连接器。平台连接器适配收发/鉴权，不注册 LLM 工具或 MCP Server。

## 边界与实际目录

IM Channel 是边缘 IM 业务生产者。它通过平台 API 构造本轮 Context v3，提交共享执行入口；Host 统一封装模型输入。通道程序调用用包内 Octo API，LLM toolCall 用 octo-cli。Docs/PPT/Loop 自己构造、执行和回写，不经 IM 特殊分支。

```text
src/
  index.ts                         公共导出，导入不发现文件或启动进程
  contracts.ts / ports.ts           配置、归一化消息、执行/凭据/呈现端口
  lifecycle/
    configuration.ts               平台配置校验与真实接入身份
    file-config.ts                 宿主显式选用的文件入口及凭据适配
    manager.ts                     revision、登记/更新/移除与关闭
  application/im-channel.ts        去重、会话、排队、命令、交互与单轮编排
  execution/dispatcher.ts           现有 core 执行配置解析 → InvokeRequest
  presentation/
    run-projector.ts               CanonicalEvent → 可公开的 Run 状态
    typing.ts                      按地址/Run 租约管理有界 presence
  delivery/
    dispatcher.ts                  独立回执、有界重试和投递幂等
    scheduler.ts                   合并进度、串行发送、终态屏障
  connectors/
    registry.ts                    IM 平台工厂，type octo/wecom
    octo/
      channel.ts                   平台准入、消息端口、卡片/typing 与回调
      normalize.ts                 Octo 私聊/群/话题授权与地址
      contexts.ts                  build_im_contexts，标准协议 items
      wukong.ts                    二进制 WS、加密、ACK、心跳
      connector.ts                 REST 投递、profile 缓存、请求超时
      cards.ts                     服务端模板能力协商
      card-session.ts              单 Run 单卡、编辑序号、终态收敛
      card-action.ts               服务端权威回调解析，不合成普通 IM 消息
      reasoning-frame.ts           Octo 模板展示映射与 payload 预算
      api/
        client.ts / errors.ts      bf_token、超时、限流和结构化错误
        messages.ts / cards.ts     文本、媒体、模板卡和 presence API
        conversations.ts           历史、成员、会话信息 API
        rules.ts                   群/话题规则与偏好 API
        events.ts / files.ts       原生事件/ACK、上传与文件元信息
    wecom/
      connection.ts / channel.ts   企业微信 JSON WS、鉴权/心跳与消息映射
```

公共 Runtime 不直接导入 Octo 卡片或 API。平台通过 `ImInboundMessage` 提供 `buildContext(signal)`、`reply(text, effectKey?)` 和可选 `beginPresentation(runId, onDiagnostic, controls)`。呈现端口只有 `update(snapshot)/finish()`；controls 只控制原调用或接受一次授权重试操作。企业微信可不实现 Octo 呈现，复用公共执行和文本回复。

共享 Daemon 仅装配显式配置，CLI 在进程入口调用文件适配。SDK 不自动加载客户文件，客户 App 不默认绑定 WorkApp 的会话配置；接入缺省关闭。详见 [多平台配置](multi-platform-design.md)。

## Context 与执行

`build_im_contexts` 返回有序 `ContextItem[]`：显式配置 items 在前，群 `extra.im/group-rules`、话题 `extra.im/topic-rules`、有限历史 `extra.im/history` 随后。规则记录服务/Space/Bot/会话、群/话题、版本、更新时刻与 present/empty/not_found；403、网络或格式错误阻断准备，不当作空材料。当前没有规则缓存，后续轮次重新授权读取，无需移植规则变更消费者。

历史由 historyLimit 显式启用（1–100），限定触发序号之前、稳定排序并排除当前消息。材料不进入控制通道，不根据 GROUP.md 文件名升权，也不设置材料消费水位、persona 推断、自动摘要或冷启动补齐。

执行 dispatcher 复用 `resolveLocalContext`，把配置 defaults 与本轮执行 items 解析为 adapter/workspace/model/effort/approval/limits。仅执行项使用现有配置解析；业务模型 items 由生产者提交，保序传递，不按会话去重。当前请求仍独立为 prompt/modelInput，统一 Host renderer 封装本轮 Context，Channel 没有 prompt builder。

IM 是边缘业务节点，构造执行 Context 时缺省审批策略为 `full_access`。显式配置或 Context 的审批策略仍按协议解析；不改其他业务入口或统一执行层的默认策略。

单轮输入克隆后只用于这次调用。当前未持久保存 Event 和 Context，不声称支持跨重启幂等重投或隐藏背景恢复。投递重试不再调用 invoke。

## CanonicalEvent 展示优化

本轮参考 `octo-agent-app-channel/internal/connectors/octo/progress.go`、`card_api.go` 与 `internal/service/progress_projection.go`，复刻其通用展示规则，不迁入旧业务分支或数据库/outbox。

| 规则               | 当前实现                                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 事件身份与公开内容 | 按 messageId/toolCallId/stepId 关联；final 各消息独立累计。analysis 只展示 public_reasoning/public_summary/public_plan；私有或未知 exposure 不外发，工具原始输出不进入展示状态。        |
| 模型轮次           | 模型 step 内按不同 commentary 消息划分文字/工具阶段，同一消息的 delta 不拆阶段；优先 commentary，再选公开 reasoning。没有公开 reasoning 时显示真实工具或模型输出，不虚构“思考”动作。 |
| 失败与检查告警     | 保留工具失败事实和部分失败阶段。已知 detect --json/exit 2/结构化 findings 展示“检查发现问题”，不伪造成功，不外发原始输出。                                                              |
| 工具摘要           | 私聊允许经敏感内容过滤的命令/路径摘要；命令最多 42 个字符、路径仅末两段。群聊不展示参数。                                                                                               |
| 时间与计数         | 记录模型/工具耗时，按 ms/s/min 显示；未知总耗时不编造。标题计数使用完整投影，展示裁剪不减少总数。                                                                                       |
| 展示预算           | 最新 3 个阶段、最多 8 个动作，每阶段保留至少一个动作，优先当前阶段；长摘要保留开头和结论。总 thought 预算 540 个字符，最终 UTF-8 payload 遵守服务端 max_payload_bytes 并预留 128 字节。 |
| 接纳与终态         | 首帧为“思考中”；实际 activity/model_step 开始后按观察时间计时，不等待 Run 之外的 started 事件。完成/失败/中断均收起历史；失败信息按模板允许的 errorMessage 展示，不发送额外字段。 |
| 结果未知           | 流中断且无 Run 终态时显示“结果未知”，保留已有步骤，最终文本提示核查；不会伪造 completed/failed 执行事件。                                                                               |

## 卡片与投递生命周期

1. 读取 `/v1/bot/card/profile`，要求显式启用、card_version 1.5、octo/v1+octo/v2、template-ref/v1、指定 ai.reasoning-process 版本及完整 active/error/result 视图。缺失、不可用、歧义或不支持的操作时不发卡片；不使用旧本地渲染模板兜底。
2. 每个 Run 使用稳定 client_msg_no 创建一张 type-17 模板卡，后续编辑同一个服务端 message_id。保留 64 位字符串 ID；card_seq 是单卡本地递增序号，与执行事件序号分离。
3. 每 500ms 合并非终态快照，只保留待发最新值。发送串行；终态清除旧 pending，等待在途发送后持久编辑，晚到进度不能复活旧卡。短 Run 没有创建过卡片时直接创建终态卡。
4. 非终态 edit 带 transient:true，终态持久 edit 不带 transient。临时帧一次尝试，终态/最终文本最多 3 次，复用相同投递身份；429 遵守有界等待，长期限流不立即重试。
5. 卡片与 final 是独立投递，失败不能改变 Run 终态或自动重跑模型。dispatcher 记录 delivered/failed/unknown，状态有界；没有数据库持久 outbox，不承诺跨重启 exactly-once。

profile 缓存 5 分钟。卡片请求最多 3 秒，公共卡片数据预算按服务端 manifest 校验；profile 不兼容时保留 typing/最终文本能力。

## Typing 与交互

typing 在 Run 接纳时发送，按地址每 5 秒续期、单 Run 最多 10 分钟。多个 Run 共享地址时各自持有租约，结束一个不会清掉另一个；卡片发送成功、等待交互、Run 终态、断连或关闭释放租约并清理定时器。服务器没有显式 stop typing API，停止续期后由其 TTL 收敛。

标准 interaction 保存原 invocation、interactionId、原请求者/会话与期限。公开问题或审批摘要经文本展示，用户用 approve/decline/respond 命令回到原入口；验证来源、类型、期限并防止并发重复提交。elicitation 接受 JSON。当前尚未实现富交互卡 schema/按钮渲染。

Octo 卡片 stop/retry 回调只接受服务端权威 `operator_uid/channel_id/channel_type/space_id/message_id`，核对真实授权用户和本地原卡关联，不信任 inputs/data 自报 Run 身份。stop 控制原调用；retry 仅在已知失败后按新的用户动作发起新 Run。回调关联有界且 30 分钟失效。

仅为本包进度卡轮询 Bot events，读取 cursor 是本地位置；非卡片/未知业务事件不 ACK，不合成 IM，不回写 Docs/PPT/任务。真正共享多消费者之前需明确服务端分流/ACK 所有权。当前没有持久回调游标或死信协议。

## 自动化验证与剩余验收

`test/im-protocol.test.js` 验证公开过滤、多消息/模型轮次、摘要/耗时/预算、profile 协商、单卡编辑和终态屏障、typing 租约、Context 顺序/错误、执行配置解析、投递幂等与动态代次。`test/im-runtime.test.js` 用加密 WS 验证执行、会话、reset、即时 stop 和审批响应。`test/im-lifecycle-rpc.test.js` 验证共享 Daemon 不读客户文件、动态接口及 Host 不被替换。

这些 fixture 不能证明真实客户端显示或实际按钮服务合同。真实私聊回归见下文；群/话题、规则和按钮仍须真实环境验收。引用、附件/产物、外部通知 RPC、持久恢复和富交互依独立需求补齐。

## 真实私聊回归

2026-10-14，im-test 的 `orbtex-codex` 执行“执行 pwd，然后回复卡片测试完成”。Run `run_ba27e628-a7bc-4b46-a934-60fa56f97431` 共观察到 39 个 canonical 事件；同卡 `2110062964093390848` 的 7 次创建/编辑回执均为 delivered，没有失败回执。真实客户端显示已完成、18.7s、工具 1、2 步与折叠摘要，并另发“卡片测试完成”；用户确认“看起来可以了”。

此前卡片停在准备中的原因有两层：测试 Daemon 未加载新实现；更新后又因只等待历史 `run.started` 而未计时，发送空 `timerText` 被服务端 schema 拒绝。现改为根据实际 `activity.started/model_step.started` 计时，未知耗时省略字段，首帧显示思考中。

过程投影按 WorkApp 的文字/工具分段方式调整，同一模型轮次内多个 commentary 不再合并为一个阶段。新增真实服务端 `ai.reasoning-process@0.4.1` schema fixture，校验首帧、进度与各类终态，避免只通过本地类型检查却被服务端拒收。fixture 来源为 octo-server 的 `pkg/cardtmpl/ai_reasoning_process/handoff/ai.reasoning-process@0.4.1/contract/data.schema.json`。

本次验收覆盖私聊基础链路，不包含展开后的全部历史、群/话题或按钮。长任务完整中间过程仍需对应场景验收。

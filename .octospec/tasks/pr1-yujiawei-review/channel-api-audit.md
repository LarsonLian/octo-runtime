---
type: Task
title: Channel API 消费者与执行前后调用审查
description: 核实上传及旧 IM API 的消费者，按固定渠道职责和 Agent 工具任务区分调用，不以调用时点作绝对禁止条件。
tags: [review, channel, architecture, delivery]
timestamp: 2026-10-17T00:00:00Z
---

# Channel API 消费者审查

本文件保留实施前的消费者证据；三个 API 已按后续决定删除，图片解析保留，当前实施与验证见[实施记录](implementation.md)。

属于[PR 1 评审计划](brief.md)。基线仍为 `0eb8b8d8fe8be5829da74ec6e686bfa39432f521`；本轮只审查并记录，没有修改产品代码、删除导出、提交或推送。

## 用户本轮澄清后的判断依据

用户先要求检查模型结束后是否存在 Channel 自动调用业务 API 的流程，随后明确：最终 @ 身份校验这一类固定、统一的渠道逻辑可以用 API，不属于模型 toolCall；进一步指出没有绝对规则。

因此逐项判断调用的职责、触发来源和实际必要性。调用时点、是否直接发 HTTP、是否在结果中出现某个标记，均不能单独作为越界判据。固定渠道接入、呈现、身份校验和协议投递有自身 API 需求；模型任务中的业务查询、文件上传和产物交付，在当前方案中优先由 Agent 调用 octo-cli 等工具完成。是否有额外内置必要性必须结合具体功能评审。

本次没有发现 Channel 上传接口的实际消费者或新的内置需求，用户已决定清理这三项遗留 API；不将这个具体结论扩大为任何 Channel、任何场景都绝对不得调用上传 API。此前调查中把“模型后查成员”暂判为违规的意见已撤回，不作为整改项。

## 审查范围与证据强度

- Runtime 的 apps、packages、public、test、scripts 和 test-support：追踪 API 定义、具名导入、命名空间导出、方法调用、直接 fetch/http 请求及最终回复分支。
- 本地生态工作区的源码检索，重点复核 Work App 与 channel-gateway-register-demo 的宿主装配。两个宿主导入 gatewayModule 用于加载 Extra，没有发现访问 imApi 的业务调用。
- 工作区内旧 Runtime 副本与当前源码区分；源码副本中的同名定义不是外部消费者。检索排除 node_modules、构建产物等重复内容，没有检查未知第三方产品的运行时代码。
- 公共入口仍通过 `export * as imApi` 暴露 API。没有已知调用不等于导出无法调用；本轮删除已核对声明文件、文档、脚本与发行接口，详见实施记录。

## 上传与查群 API 的消费者

| API | 产品消费者 | 测试 / 脚本消费者 | 已知宿主消费者 | 结论 |
| --- | --- | --- | --- | --- |
| getUploadPresign | 未发现 | 未发现 | 未发现 | 已确认删除实现与公开导出；已实施并验证，不继续建设 Channel 上传能力 |
| uploadFileToPresignedUrl | 未发现 | 未发现 | 未发现 | 已确认删除实现与公开导出；R02a/R02b 通过清理处理，已实施并验证 |
| getGroupInfo | 未发现 | 未发现 | 未发现 | 已确认删除实现与公开导出，覆盖 R01；与群准入、群规则、成员查询分别处理，已实施并验证 |

定义分别位于 [files.ts](../../../packages/octo-runtime-extra-channel-gateway/src/transport/api/files.ts) 与 [conversations.ts](../../../packages/octo-runtime-extra-channel-gateway/src/transport/api/conversations.ts)，导出链为 [API index](../../../packages/octo-runtime-extra-channel-gateway/src/transport/api/index.ts) → [包入口 imApi](../../../packages/octo-runtime-extra-channel-gateway/src/index.ts)。

未发现 execution/task、最终回复、工具进度或 CanonicalEvent 投影调用上述上传 helper；也未发现扫描工作目录、读取产物文件并上传、解析 artifact/mediaUrl 后代发业务消息、或工具漏调后补做上传的执行链。该结论限于审查的源码，不是未知宿主或线上运行的全量证明。

## 已有调用按用途与时点核对

| 调用 | 消费者与触发点 | 时点 | 评审结论 |
| --- | --- | --- | --- |
| verifyBotIdentity / registerBot | GatewayTransport.start 验证 Bot、Space 并取得连接信息 | 建联；重连也会重新建联 | 固定接入职责，保留 |
| getGroupMd / getThreadMd | build_im_contexts 准备本轮群 / 话题规则 | 本轮 invoke 前 | 既有输入合同，保留 |
| getChannelMessages | 新会话首次准备时有界读取当前触发前的历史 | invoke 前，重试复用冻结输入 | 既有上下文准备职责，保留 |
| downloadImageInput | 已准入独立图片消息的 buildInputs | invoke 前 | 原生图片输入准备，保留；这是输入下载，不是输出文件上传 |
| sendReadReceipt | 普通任务开始时 markRead，失败不阻断任务 | 准备阶段发起；异步请求可能稍后完成 | 固定消息接入反馈，不能仅因请求完成时间判越界 |
| getGroupMembers / 内联 user-info GET | 成功 final 的 replyFinal → prepareFinalMention；只有发现普通正文的显式 @ 标记才查询身份 | 模型结束后的最终回复转换 | 用户已确认这类固定业务逻辑可用 API；保留为合理的渠道校验，不列违规 |
| getCardProfile | connector.reasoningTemplate / rawCard 查询平台卡片能力；模板缓存约 5 分钟，交互卡片也会查询 | 可能在执行中或收尾时 | 卡片投递的协议准备，不是代办模型任务；无依据要求仅为时序而强制前移 |
| sendTemplateCardMessage / editTemplateCardMessage / rawCard | CardSession 或交互呈现将规范事件投影为卡片 | 执行中、交互时、终态收尾 | 固定呈现与投递职责，保留 |
| sendTyping | TypingController 为当前执行提供状态反馈 | 执行中 | 固定渠道反馈，保留 |
| fetchBotEvents / ackBotEvent | 卡片按钮轮询、验证用户与原消息归属、respondInteraction/cancel/retry | 执行中与保留的交互窗口 | 固定用户交互回传，保留；不把任意领域事件转换成业务任务 |
| WukongConnection.sendText | 当前消息的 reply / replyFinal；最终地址绑定原连接与频道 | 命令反馈、执行中交互、最终回复 | 当前会话结果投递，保留；没有据模型内容选择任意频道代发的链路 |
| replyDeliveryUnknown | 在回复 ACK 状态未知时发送独立展示卡片 | 投递失败处理阶段 | 既有 F27 投递反馈，不重跑模型任务、不上传产物 |

对应链路见 [transport/channel.ts](../../../packages/octo-runtime-extra-channel-gateway/src/transport/channel.ts)、[application/im-channel.ts](../../../packages/octo-runtime-extra-channel-gateway/src/application/im-channel.ts)、[contexts.ts](../../../packages/octo-runtime-extra-channel-gateway/src/transport/contexts.ts)、[connector.ts](../../../packages/octo-runtime-extra-channel-gateway/src/transport/connector.ts) 和 [card-session.ts](../../../packages/octo-runtime-extra-channel-gateway/src/transport/card-session.ts)。

最终 @ 的精确行为是：模型 final 普通文本出现 `@[uid:displayName]` → 解析并排除代码、引用等区域 → 对群/话题查询当前群成员，私聊查询当前对方 → 仅转换经确认的真人身份 → 原频道发送最终回复。该查询用于验证已给出的 UID，并不按模型要求任意搜索业务资料；失败降级为普通文字，不阻断正文。这也解释了为什么它不能和自动产物上传一概而论。

## 其他遗留 API 与脚本依赖

| API / 方法 | 消费者状态 | 建议 |
| --- | --- | --- |
| fetchUserInfo、searchSpaceMembers | 产品、测试及脚本中未发现调用；实际 final 私聊核验直接用 getJson，不调用 fetchUserInfo | 列入清理候选；不能把 helper 无调用误写成 user-info endpoint 没有调用 |
| getMentionPref | 未发现调用；当前准入固定要求真实 @，不读取免 @ 偏好 | 清理候选，避免旧免 @ 注释误导后续接线 |
| sendMediaMessage、sendRichTextMessage | 未发现调用 | 清理候选；入站富文本解析仍有用途，与这两个出站 helper 分别处理 |
| sendHeartbeat | 未发现调用 | 清理候选；不影响当前 WS 心跳或服务端在线识别 |
| OctoConnector.notification → sendMessage | helper 有方法级引用，但 notification 本身没有调用方；当前实际文本回复走 WS | 属于未接线的间接调用链，不能误报为正在主动通知；可连同无消费者方法整理 |
| fetchBotGroups | 产品运行链没有调用，但三个真实联调脚本使用 | 不是完全无人使用；如果生产包移除，先把脚本查询迁到 octo-cli 或专属测试工具 |
| inferContentType、ensureTextCharset、parseImageDimensionsFromFile | 当前包内没有业务调用；仅后者内部调用 parseImageDimensions | 不属于本次三项 API 的已确认删除范围；后续如需清理，另行核对必要性 |
| parseImageDimensions | image-input.ts 有真实调用 | 保留；不得整文件删除导致原生图片准备回归 |

fetchBotGroups 的具体消费者为 [群准入脚本](../../../scripts/verify-channel-group-admission-live.mjs)、[SDK/CLI 入口脚本](../../../scripts/verify-channel-group-entrypoints-live.mjs)及 [Context 联调脚本](../../../scripts/verify-im-context-live.mjs)。本轮没有运行这些会操作真实 IM 的脚本。

## 验证及后续建议

运行 `node --test test/im-final-mention.test.js`，5 项通过。现有测试明确断言普通回复不查询成员，带标记的 final 查询一次，重投复用同一结果；应用测试验证只有成功 final 进入转换。使用合成数据及 mock 网络，没有向真实用户发送消息，不是 im-test 线上联调。

审查结论：未发现 Channel 自动上传或代替 Agent 交付产物的运行链；三个无已知消费者的 API 属于可收敛的公开接口面。用户确认 octo-cli 已支持对应业务能力且端到端验收通过，因此已选定删除 getGroupInfo、getUploadPresign、uploadFileToPresignedUrl；保留原生图片尺寸解析。用户提供的验收结论不冒充本轮独立执行的证据。

判定依据是具体职责、消费者、替代能力及内置必要性；不能以模型执行前后或是否直接调用 API 一概判越界。固定 @ 校验、卡片、typing、交互和协议投递仍可使用 API。完整原因、范围及后续验收见[已确认决策](brief.md#已确认决策r01r02ar02b)。

后续已按决定删除三个 API 的实现与导出，保留 files.ts 的图片解析。此前路径编码、上传重定向和存储白名单备选已退出本次计划；其他清理候选未自动实施。

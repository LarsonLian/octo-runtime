# Adapter 执行体验一致性改造基线

日期：2026-10-09（Asia/Shanghai）。基线 ID：`OCTO-ADAPTER-EXPERIENCE-BL-01`。版本：`0.2`。

状态：核心修复已实施并按问题提交；完整线上与逐 Provider 资格验收尚未完成。实现记录见 [实施与验收记录](adapter-experience-implementation-2026-10-09.md)。本文中的“必须”和“不得”仍是验收要求，不表示所有场景均已通过。

适用项目：`octo-runtime`、`octo-agent-worker`、`octo-work-app`。读者为 Adapter、Host、Worker 投影和 Work App 的开发与测试人员。

范围解释：本基线将需求中的“不大概当前的统一协议”暂按“不大改当前统一协议”处理。本轮直接修正当前版本，不设计旧版本兼容层；沿用现有 CanonicalEvent 与 Presentation 事件、字段和版本。若该解释与需求原意不同，必须先修订本节，再实施受影响部分。

## 1. 目标与非目标

### 1.1 改造目标

不同 Adapter 必须按同一份生命周期合同表达执行过程，使 Work App 能够连续展示启动、公开思考、工具执行、回答和终态。

“与 Codex 体验一致”指以下可观察行为，不要求所有 Provider 输出与 Codex 相同的文本、思考量或事件密度：

1. 请求提交后有对应的等待反馈；进入执行后，尚无正文时仍有活动反馈。
2. Provider 已公开的思考内容、工具调用和执行进度不得在转换中丢失。
3. 思考、工具和回答按真实身份与先后关系展示；同一对象的增量不新增对象。
4. 工具运行中不得提前显示失败或完成；文本快照更新不得结束仍在运行的活动。
5. 根 Run 结束后，活动动画与计时停止；公开过程保留，并有可发现的展开入口。
6. 实时流、历史详情和重连快照对同一公开事实给出一致结果。

### 1.2 本轮不包含的工作

- 不新增第二套执行协议，不新增事件类型、公共字段或协议版本。
- 不为旧 Adapter、旧 Worker 或旧 Work App 增加双写、双读、版本协商和兼容开关。
- 不批量改写历史记录，不因“不考虑兼容性”删除数据库、会话或用户文件。
- 不伪造 Provider 未提供的思考正文、工具开始时间、进度百分比或模型轮次。
- 不把私有推理或公开性未知的文本改成公开内容。
- 不要求模型通过提示词补写“思考中”“正在调用工具”等界面状态。
- 不将 Provider 进程复用、模型首 token 优化或全新会话架构作为本轮交付前提。

## 2. 术语与协议依据

| 主名称 | 本文含义 |
| --- | --- |
| Provider 原生事件 | Codex app-server、ACP、CLI 或 Gateway 发出的事件；由 Adapter 解释 |
| CanonicalEvent | Adapter 与 Host 输出、Runtime 持久化并发送给 Worker 的统一执行事件 |
| 根 Run | 一次执行的权威生命周期；工具结束、消息结束不等于根 Run 结束 |
| 消息段 | 具有独立 `messageId` 的文本对象；同一段允许增量与快照更新 |
| 模型轮次 | 由 `model_step.started/finished` 表达的轮次关联；不等于思考活动 |
| 活动 | `activity.*` 表达的当前执行状态，例如 starting、thinking、executing_tool |
| 公开思考 | 已标记为 `public_reasoning`、`public_summary` 或 `public_plan` 的 analysis 内容 |
| Presentation | Worker 对外提供的公开投影，例如 `text.patch`、`tool.upsert`、`activity.upsert` |
| 终态 | 根 Run、工具和模型轮次的 completed、failed、cancelled；activity 另有 superseded |

协议依据是当前工作区的 [protocol.schema.json](../packages/octo-runtime-protocol/schema/protocol.schema.json)、[生成类型](../packages/octo-runtime-protocol/src/generated/protocol-types.ts)及[运行时校验](../packages/octo-runtime-protocol/src/index.ts)。本基线不另定义 payload。

必须特别区分两种 `update`：

- `tool_call.update` 的现有正式合同只允许终态，不能承载 running 或 in_progress。
- `message.update` 能够承载文本快照；收到该事件不等于消息已经结束，消费者必须检查 `status`。

“Provider 原生 tool_call_update”与“CanonicalEvent tool_call.update”不是同一合同。Adapter 不得仅依据名称相似进行一对一转换。

## 3. 已核实事实与证据边界

### 3.1 源码与最小复现

核实对象为 2026-10-09 本地工作区，包含其他工作流的未提交修改。以下结论不代表全部线上部署版本。

| 编号 | 已核实事实 | 影响与定位 |
| --- | --- | --- |
| F01 | ACP 和 CodeBuddy 将原生 in_progress 传入 `canonicalTerminalStatus()`，最小复现输出 failed | 运行中工具被提前收口；[ACP](../packages/octo-runtime-adapter-acp/src/index.ts)、[CodeBuddy](../packages/octo-runtime-adapter-codebuddy/src/index.ts) |
| F02 | Host 收到 `message.update(status=streaming)` 后，结束对应 activity 为 completed | 流式快照替换导致活动提前结束；[InvocationExperience](../packages/octo-runtime-adapter-host/src/experience.ts) |
| F03 | Host 对缺失 messageId 的消息使用 `${runId}:${channel}` | 不同消息段可能合并；[Host 消息补全](../packages/octo-runtime-adapter-host/src/index.ts) |
| F04 | OpenClaw Gateway 路径复用 analysis 消息身份，并基本以整次调用表达一个 step | 工具后的新思考仍归入旧消息；[OpenClaw 转换](../packages/octo-runtime-adapter-openclaw/src/index.ts) |
| F05 | Claude Code、ACP 等路径将普通文本直接归为 final；Codex 保留 commentary 与 final 的区别 | 前导说明与最终回答缺少相同的分段语义；不得据此假定所有 Provider 都有原生 channel |
| F06 | 前端思考预览要求 analysis 的 firstSeq 晚于本组最后一个工具的 firstSeq | 复用旧思考 ID 后，新内容可能不再成为当前预览；[过程投影](../../octo-work-app/src/renderer/src/surfaces/execution-process.ts) |
| F07 | Work App 在执行结束后默认折叠过程 | “页面没有显示”不能直接判为“转换丢失”；[Transcript](../../octo-work-app/src/renderer/src/surfaces/Transcript.tsx) |
| F08 | Host 已在等待首个 Provider 结果前输出 starting；Runtime 的上下文准备发生在进入该调用之前 | starting 不覆盖全部提交等待；[Host](../packages/octo-runtime-adapter-host/src/index.ts)、[Runtime](../packages/octo-runtime-daemon/src/agent-work-runtime.ts) |

对上一轮分析的校正：向 Host 直接注入 `tool_call.update(status=running)` 可以复现错误收口，但该输入本身违反现有正式协议。修复必须将中间状态挡在 Adapter／校验边界，不能通过允许非终态 update 改写协议。Host 的 streaming 消息快照问题则属于合法消息更新的消费错误。

### 3.2 已有真实样本

上一轮分析通过 CDP 读取了真实 Electron renderer，并核对该次运行已有的事件记录和历史详情。环境为 `https://im-test.deepminer.com.cn` 登录服务、`http://127.0.0.1:8091/agentworker/api` 本地 Worker 和真实 OpenClaw。该证据不等于已连接线上部署的 Worker。

样本：`conv_d200dfde230b4e94b578e2cfddfea544`，执行：`aexec_bfa9faaeb8914acfabd5a312adfc3ea4`。既有记录位于本机 `/tmp/octo-openclaw-main-qa/report.json`；临时文件不作为长期验收归档。

| 观察点 | 结果 |
| --- | --- |
| 首个 queued 到 running／starting | 约 1.27 秒 |
| 首个 queued 到首段公开思考 | 约 3.41 秒 |
| 客户端工具记录 | 3 次：write、read、read |
| 历史公开过程 | 608 字符的公开思考及全部 3 个工具项仍在 |
| 完成页面 | 最终答复可见，过程折叠在“用时 18秒”入口内 |

时间差由该样本客户端记录的 `tsMs` 计算，仅描述该次观察；不作为性能目标，也不能用于判断某个准备步骤的耗时。字符数为读取时字符串长度，不是 token 数。其他 Adapter 的源码结论不得写成已经通过真实 Provider 验收。

## 4. 分层责任与改造约束

```text
Provider 原生事件
  → Adapter：解释状态、保留身份、转换文本与工具事实
  → Host：校验合同、补齐合法生命周期、管理活动
  → Runtime Runtime：持久化、发送、维持根 Run 权威状态
  → Worker：脱敏、公开投影、快照与重放
  → Work App：当前活动、过程分组、折叠与计时
```

| 层 | 必须负责 | 不得负责 |
| --- | --- | --- |
| Adapter | Provider 状态映射、原生 ID 关联、快照与增量识别、公开性声明 | 将界面标签塞进 final；猜测未发生的工具开始 |
| Host | 统一校验、合法消息生命周期补全、活动去重与终态清理 | 用字符串兜底将未知状态解释成失败；仅凭 step 开始认定模型正在思考 |
| Runtime | 保留既有准备、租约、取消、持久化和发送顺序 | 为缩短视觉等待跳过准备封存、权限校验或将 run.started 提前到不真实的时点 |
| Worker | 公开投影、敏感数据过滤、身份与顺序保存、重放一致性 | 丢掉已经公开的工具／思考；按 Provider 名称另造投影协议 |
| Work App | 根据公开事实展示、保持过程可发现性、断线与终态反馈 | 直接解释 Provider 原生包；从无事件推测思考正文或执行成功 |

Kit 能力仍必须经 Provider 注入 Port。凭据只在 main 取用；renderer 不新增宿主全局，不绕过 `window.octoWork` 唯一桥。改造不得破坏 `SpaceScopedApp key={spaceId}` 与切租户清缓存机制。

## 5. 必须实现的行为合同

### 5.1 工具生命周期

Adapter 必须按 Provider 的已核实状态表分类，先判断原生状态，再选择 CanonicalEvent。`canonicalTerminalStatus()` 只能处理已经判定为终态的值。

| Provider 事实 | CanonicalEvent 行为 | 用户可观察结果 |
| --- | --- | --- |
| 工具开始或已确认进入工具执行阶段 | 首次输出 `tool_call.create`，带稳定 id、name、args 和 running | 一个工具项进入运行中 |
| 原生 pending／in_progress 中间更新 | 不发终态 update；有内容时按下一行处理；无内容时保持当前工具状态 | 不提前失败、完成或停止动画 |
| 参数片段、输出片段或完整输出快照 | 分别使用 `argsDelta`、`outputDelta`、`outputSnapshot` | 参数按片段组合；输出快照替换，不重复追加 |
| 可公开的工具进度 | 输出 `tool_call.progress` | 更新已有工具的进度，不创建第二个工具 |
| 明确成功、失败或取消 | 输出 `tool_call.update`，status 为 completed、failed 或 cancelled | 仅结束对应工具；根 Run 不因此结束 |
| 首次只收到终态工具记录 | 输出携带已知身份与最终结果的终态记录；沿用现有投影补建路径 | 历史工具可见，但不伪造运行阶段和耗时 |
| 无法识别的原生状态 | 不调用终态兜底函数；保留已有状态，记录去敏诊断 | 不制造失败事实；根 Run 继续遵循既有超时和终态规则 |

参数片段必须按顺序拼接后解析。完整参数快照不得作为多个 JSON 片段重复追加。若 Provider 的参数替换语义不能由现有字段无损表达，必须记录为能力缺口，不得私加字段。

同一工具的重复开始、终态重放不得创建第二个工具项。多个并行工具必须按各自 id 独立更新；工具 A 结束不得结束工具 B 的活动。根 Run 的终态只清理仍未结束的活动，不得覆盖工具已经确认的失败或成功事实。

运行时校验必须与现有 schema 一致：拒绝 `tool_call.update(status=running/in_progress)`，不得将其默默修正为 failed 后继续发布。

### 5.2 消息段、公开思考与文本通道

1. Provider 提供稳定消息／内容块 ID 时，Adapter 必须保留其关联。同一原生段的 create、delta、snapshot 和终态必须指向同一 `messageId`。
2. Provider 没有消息段 ID 但有明确边界时，Adapter 必须在一次 invocation 内按实际边界生成稳定 ID；计数在 invocation 内维护，不放入跨租户模块级单例。
3. 工具后出现新的思考段时，Adapter 必须创建新消息段，不得继续写入工具前的 analysis 消息。判断必须依赖原生段边界或已验证的轮次重建规则，不能按文本长度或时间间隔猜测。
4. Provider 只有持续文本、没有可验证的分段事实时，Adapter 必须保留原有连续段，并在资格记录中注明分段能力不足；不得声称已经达到逐段一致。
5. Host 不再以 `${runId}:${channel}` 作为所有缺失身份消息的全局合并策略。身份的来源由 Adapter 明确；Host 只在已确认属于同一消息段时补全其生命周期。
6. `message.update(status=streaming)` 必须替换对应文本快照，并保持该消息活动未结束。只有明确的消息结束或根 Run 终态才能收口。
7. Provider 明确区分 commentary 与 final 时，Adapter 必须保留。Provider 未区分时，Adapter 不得按“我将”“接下来”等措辞猜测 channel；该 Provider 的通道规则必须在资格记录中说明。
8. 文本通道不明确的 Provider 可以保留现有 final 归类，但不能因此合并有独立身份的消息段。Work App 必须按已知段顺序组织活动中的过程，不得将所有 final 段提前抽离导致先后关系丢失。
9. 私有或公开性未知的 analysis 正文不得进入公开存储、DOM、辅助文本或复制结果。明确的 reasoning 生命周期可以表达 thinking 活动，且不得附带私有正文。

### 5.3 活动与模型轮次

- `model_step` 用于轮次关联。Host 不得仅凭 `model_step.started` 生成 thinking；不确定当前阶段时使用已有 working。
- 明确 reasoning 开始、公开 thought chunk 或等价原生事实可以触发 thinking。没有正文的 thinking 状态与可展开的公开思考正文必须分开处理。
- Adapter 和 Host 不得为同一事实同时创建两条竞争活动。同一活动持续期间复用 `activityId`；结束后发生的新活动必须有独立身份。
- 文本和工具的中间更新保持活动；有明确阶段切换或终态时才结束活动。
- 活动中的界面必须只有一个主状态入口。并行工具事实保留在详情中，不因主入口合组而丢失。
- 同一执行出现多个有效活动时，沿用当前选择优先级：等待审批、等待输入、重试、压缩、工具执行、思考、回答、启动、通用处理。断线和取消中的反馈优先于这些普通活动。
- 根 Run 终态到达后，Host／Worker 必须清理残留活动，Work App 必须停止活动动画。迟到的 delta、usage 或重复终态不得重新启动根计时和忙碌状态。
- 重试、压缩、计划与工具进度只在有原生依据时映射到已有事件；本轮不要求没有对应能力的 Provider 伪造这些事件。

### 5.4 启动与等待反馈

“受理成功”表示请求已被系统接受，不表示 Provider 已执行；`run.started` 也不等于首段公开文本已经产生。

| 阶段 | 事实来源 | 界面要求 |
| --- | --- | --- |
| 本地提交尚未取得 ACK | Work App 发送状态 | 显示发送中；失败时保留既有重试语义 |
| 已受理，仍在排队或准备 | 既有执行状态、已有准备投影 | 至少显示等待执行；只有已有公开事实能区分准备时才显示准备中 |
| Host 已进入 invocation，Provider 尚未产生语义输出 | 既有 starting／working 活动 | 显示启动或处理状态，不等待正文才出现反馈 |
| 已收到明确思考、工具或回答事实 | 对应公开事件 | 切换到事实对应的活动 |
| 断线、审批等待、取消中 | 既有连接、交互及执行状态 | 显示真实等待原因，不继续假装模型正在输出 |

`session.update`、usage 或空消息占位本身不得被视为“已经开始回答”的证据。starting 的结束条件必须与有意义的执行进展关联，不能使用“收到任意事件”作为唯一判断。

实现必须记录以下时点用于诊断：客户端提交、受理 ACK、Runtime 准备开始／结束、Host invoke、Provider 请求写出、首个原生输出、首个公开文本／工具事件。优先复用现有日志和 observation；这些诊断时点不新增为公共协议字段。

耗时必须注明计时点和时钟来源。同一进程内优先使用单调时钟；未经校时，不得直接相减不同主机的时间戳。当前没有获批的性能阈值，本轮不得编造“首屏小于 N 秒”的验收承诺。

### 5.5 展示、历史与恢复

Work App 必须同时满足：

- 执行中保留当前过程入口，已有正文或已完成工具不导致入口消失。
- 同一消息段的增量不新增折叠入口；新的独立正文段可以建立新的过程间隔。
- 本轮保留完成后默认折叠。存在工具或公开思考时，入口必须能识别“有执行过程”，不能只依赖用户猜测耗时文字可点击。
- 展开后保留公开思考、工具输入输出与失败状态。没有公开详情时不得显示空展开按钮。
- 复制最终回答不包含计时、活动标签或折叠控件文案。
- 历史详情、重连快照与实时流保留同一公开对象身份、顺序和最终状态；断线期间不删除已取得的过程。
- 当前思考预览必须跟随最新的真实思考段。不得通过把旧消息的首次顺序改成最新顺序掩盖 Adapter 身份错误。
- 动效继续遵循 reduced-motion；展开入口支持键盘与焦点；计时不得逐秒触发读屏播报。

## 6. Adapter 改造清单

| Adapter | 本轮重点 | 能力边界 |
| --- | --- | --- |
| Codex | 作为生命周期参照；回归独立 itemId、commentary/final、公开摘要、工具增量和进度 | 不将私有 reasoning 文本改为公开；不把 Codex 原生结构提升为公共协议 |
| Claude Code | 保留 thinking block 身份；补齐普通消息段身份；核对 partial 与整块重放去重 | 普通文本 channel 必须基于可验证事实，不按措辞猜测 |
| 通用 ACP | 修复非终态映射；明确状态表；保留 thought 分段和工具身份；核对轮次重建 | thought chunk 未产生时，无公开思考正文属于能力／配置边界 |
| Kimi Code、Qoder CLI、Qoder CN、MCode、Hermes | 各自提供原生样例，验证共享 ACP 修复真实生效 | 共享实现通过不等于每个 Provider 通过；命令不可用必须记为未验收 |
| CodeBuddy | 修复非终态映射；补齐消息身份与轮次关联，减少独立转换与通用 ACP 的语义分叉 | 是否复用同一实现由原生差异决定，但输出合同必须相同 |
| OpenCode | 核对原生 reasoning、工具 running 与终态帧；区分快照和增量 | 只有终态工具帧时只承诺历史可见，不承诺实时执行状态 |
| OpenClaw | 修复跨工具思考复用；处理滚动快照；核对 Gateway 工具与思考事件订阅 | 必须区分当前 Gateway 路径与其他 parser 路径，不能用未走到的 parser 证明已支持 |
| ZCode GUI | 核对 step 内消息身份、工具 scheduled／running／终态映射及 reasoning 分段 | 以实际 GUI bridge 事件为依据，不套用 Codex 原生假设 |

每个 Provider 的资格记录必须注明：版本、接入方式、所选模型、是否产生公开思考、是否产生工具开始和增量、消息边界依据、channel 映射规则、启动观察点、通过与未覆盖项目。记录不得包含 token、密钥、私有推理或用户敏感正文。

## 7. 实施顺序与交付边界

| 阶段 | 交付内容 | 完成条件 |
| --- | --- | --- |
| P0：纠正生命周期 | ACP／CodeBuddy 非终态转换；Host streaming 快照；协议运行时校验与 schema 对齐 | A01—A05 通过；Codex 已有流式路径不回归 |
| P1：统一身份和分段 | 消息段、思考段、工具与 step 关联；公共 Host 补全规则 | A06—A09 通过；每个 Provider 有明确分段规则或能力缺口 |
| P2：补齐消费者 | Worker 公开投影与恢复；Work App 活动选择、启动反馈、过程入口 | A10—A14 通过；不新增公共事件或字段 |
| P3：真实联调 | 逐个 Adapter 的原生→CanonicalEvent→Presentation→DOM 证据 | A15—A17 通过；未覆盖项逐项列明 |

实现顺序不表示可以将中间不一致版本作为最终交付。Runtime、Worker、Work App 必须以同一基线联合验证，不承诺新旧组件混用。

本轮只补齐既有协议的生产与消费，不修改 schema 表达范围。若实现发现必须新增字段才能表达已确定需求，必须停止该扩展、记录缺口并修订基线；其他不依赖该扩展的修复继续进行。

## 8. 验收矩阵

以下为完整验收要求。各项当前覆盖与缺口以实施记录为准，不能将单测通过等同于全部 Provider 实机通过。

| 编号 | 输入或场景 | 必须观察到的结果 |
| --- | --- | --- |
| A01 | ACP／CodeBuddy 工具开始→in_progress→完成 | 中间阶段只有一个运行中工具；failed 不得出现；仅终态产生 tool_call.update |
| A02 | 工具中间更新没有 status 或没有新增内容 | 不推断成功／失败，不制造空 delta，不结束已有活动 |
| A03 | 注入非法 canonical tool_call.update(status=running) | 校验拒绝；不转换为 failed 后发布 |
| A04 | message.create→多个 streaming 快照→消息完成 | 同一消息身份，快照替换，活动直到完成才结束 |
| A05 | argsDelta、outputDelta、重复输出快照 | 参数完整解析；增量有序；快照不重复追加 |
| A06 | 思考 A→工具→思考 B→回答 | A、B 身份独立；B 能成为当前预览；顺序可追溯 |
| A07 | 独立正文段与同段 token 增量交替 | 独立段不合并；同段增量不增入口；channel 不按文本措辞猜测 |
| A08 | 两个并行工具，A 失败后 B 继续 | A 失败可见，B 继续运行，根 Run 不被工具终态提前结束 |
| A09 | 只收到工具终态记录 | 历史工具可见；不伪造开始动画、开始时间或耗时 |
| A10 | 零正文启动、只有 session／usage／空消息占位 | 页面持续有发送／等待／启动／处理反馈；不错误显示正在回答 |
| A11 | Provider 无公开思考；私有／未知 analysis 与公开摘要混合 | 状态反馈存在；只公开允许的内容；不制造可展开私有详情 |
| A12 | 完成／失败／取消后迟到 delta、usage、终态重放 | 活动与计时不重启；工具失败事实不被覆盖；无重复项 |
| A13 | 实时流后重连、刷新、历史读取 | 公开对象身份、内容、顺序和终态一致；原有过程不消失 |
| A14 | 完成折叠、键盘展开、复制答案、减少动态效果 | 入口可发现；过程可读；复制不混入状态；可访问性行为符合 5.5 |
| A15 | 逐个 Provider 执行同一只读工具任务 | 保存四层对应证据；工具确实执行且界面对应；不能仅以最终回答声称成功 |
| A16 | im-test 真实 renderer 联调 | 记录实际 Auth／Worker 地址、Runtime 与 Provider 版本；CDP 验证 DOM、异常和网络错误 |
| A17 | 切租户及断线恢复 | 旧租户过程不残留；连接状态不伪装成 thinking；恢复后以权威快照校准 |

校验与自动化要求：

1. Runtime 执行适用的类型检查、构建、协议／Adapter／Host／Runtime 测试；Worker 执行投影与受影响服务的 Go 测试。
2. Work App 修改 UI 或真实接口后，必须执行 tsc、Vitest、build，并通过 CDP 驱动真实 Electron renderer 验证。
3. 调试必须使用 im-test 体系。若 Worker 由本地覆盖，报告必须明确写“im-test 登录＋本地 Worker”，不能标成线上 Worker 验收。
4. 后续正式联调必须包含线上测试环境 Worker；其凭据、服务版本或可用性未满足时，记录阻塞范围，不将本地替代结果记为通过。
5. 每条 Adapter 路径必须取得自己的证据。不可用的 Qoder CN 或未配置模型的 Provider 记为未验收，不以单测替代实机结论。
6. 新验收证据必须持久保存在项目文档目录，并去除敏感内容；不能只引用 `/tmp` 文件。截图证明布局，事件记录证明生命周期，二者不得互相替代。

## 9. 待确认事项与停止条件

| 事项 | 当前处理 | 影响范围 |
| --- | --- | --- |
| “不大概当前统一协议”的原意 | 暂按“不大改协议”落地，本轮进一步限定为不增加公共事件／字段／版本 | 若用户实际允许协议重构，需另行修订范围；不影响已确认的生命周期错误 |
| 各 Provider 的真实原生边界和配置 | 实施时采样并形成资格记录 | 缺少证据的思考分段、工具开始和 channel 区分不得宣称完成 |
| 启动性能目标 | 本轮只要求阶段可解释、诊断可测量，不设数值承诺 | 需要性能 SLA 时，再按同一环境和统计口径确定阈值 |
| 线上测试 Worker 版本与可用性 | 后续实机阶段核实 | 未满足时保留明确的未验收项，不阻止先完成本地实现和单测 |

本基线完成的判定是文档合同可用于实施；改造完成的判定是第 8 节对应测试通过，并明确列出 Provider 能力限制和未验收项。二者不得混写。

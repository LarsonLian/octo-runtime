# IM 接入 （已通过架构评审）

现行设计见 [Runtime 本地存在与按需在线合同](../../docs/runtime-local-and-online-contract.md)。HostApp 决定携带和启用哪些包；本地 Runtime 身份与云端登记独立。

**术语：本包的 connector 是 IM 平台连接器，不是 MCP 连接器。** `connectors/octo` 与 `connectors/wecom` 适配 IM 协议；不管理 MCP Server 或模型工具。多类型配置、默认 Codex、平台专属与公共领域边界见 [多平台 IM 方案](docs/multi-platform-design.md)。

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../docs/context-llm-injection.md) 与 [IPD-SE](../../../docs/event-context-rendering-ipd-se.md)。Host 仅按白名单 pattern 保序拼接，不做业务检查或编译。

**角色定位：IM Channel 是直连 IM Server 的边缘侧 IM 业务方，也是 IM Event/AgentRun 的发起方。** 本包获取 IM 信息并构造标准 Context items，再交给 AgentRun 统一封装与执行；无需在 Channel 与 IM Server 之间再设一个“聊天业务方”。文档评论等其他入口由其发起方构造 Context，直接调用同一 AgentRun 合同。本文的底层执行框架指 Worker、daemon、Host 与 Provider Adapter，不包括作为 Event 生产者的 IM Channel。

## 当前实现与责任边界

已实现本轮明确的 Octo IM 改造：直连 IM Server、私聊与显式群/话题触发、标准 Context v3 构造、共享 AgentRun 执行、CanonicalEvent 投影、模板卡片、typing、最终文本、运行控制和动态接入。公共 Runtime 通过 IM 平台连接器端口复用会话/排队/执行；Octo 专属协议留在 `connectors/octo`，企业微信接入另见 [多平台设计](docs/multi-platform-design.md)。

- 本包是 IM 业务发起方：自行获取 IM 信息，提交本轮协议 items。Host 按统一规则渲染，Channel 不拼提示词，不提供 `before_prompt_build`。
- 通道程序调用使用包内 Octo REST API 和 `apiUrl + bf_token`。API helper 从旧 OpenClaw 插件迁入，保留消息、卡片、typing、GROUP.md、历史、成员、文件和事件接口；LLM 的 toolCall 继续使用 `octo-cli`。Channel 不通过 CLI 子进程获取这些接口数据，也不注册 Docs/PPT 等业务工具。
- 文档评论、PPT、Loop 任务由对应生产者构造 Context，直接发起统一 AgentRun 并回写业务对象。本包无 `synthesizeDocMentionMessage`、`docTask`、评论回写或 PPT continuation。
- 客户 App 决定账号范围、Home、配置来源、凭据保存和启停。不自动绑定 WorkApp，不继承其聊天的 adapter、模型、思考强度或工作目录，不扫描账号目录。
- 卡片参考 `octo-agent-app-channel` 的公开事件投影与展示优化；实际目录、状态与验证范围见 [内部设计](docs/internal-design.md)。
- 当前为有界内存接入。回执表示服务端接纳，不代表客户端已经显示；不承诺进程崩溃后的执行恢复、持久补发或跨重启 exactly-once。

## 宿主接入与最小能力

宿主显式提供 `ImBotConfig`、共享执行端口和可选凭据获取函数。接入默认关闭，必须 `enabled: true` 才启动连接。两种平台都使用同一公共 Runtime；`type` 选择 IM 平台，adapter 选择执行引擎，二者独立。

```ts
const channels = new ImChannelManager({
  host, // invoke / cancel / respondInteraction，使用标准执行协议
  credentials: (config, signal) => accountCredentials(config.id, signal)
});
await channels.upsert(
  {
    type: "octo",
    id: "agent-a-im",
    enabled: true,
    apiUrl: "https://im-test.deepminer.com.cn/api",
    botId,
    spaceId,
    workdir: absoluteWorkdir,
    context: { schema: "octo.context-envelope/v3", items: [] }
  }
);
```

`ImRuntime(config, dependencies)` 保留 `start()/close()/status`；`ImChannelManager` 提供 `upsert(config)/remove(id)/status/close()`。共享执行端口只要求履行调用合同，客户 App 无需启动 CLI 或创建默认文件。内部凭据函数返回 `undefined` 表示未就绪，凭据不进入 Context、模型输入、卡片或状态。

执行配置使用现有 `resolveLocalContext`：IM 边缘业务节点构造 Context 时提供 defaults，本轮 `octo.execution/*` 与 `octo.security/approval_policy` 按已有协议解析。缺省 adapter 为 `codex`，IM 审批策略为 `full_access`，运行上限为 120 秒；显式审批策略、模型和 reasoning effort 可由标准 item 提供。此默认值仅属于 IM 入口，不修改其他入口或执行协议的默认策略。执行项不进入模型正文。程序接入须显式提供工作目录，或通过 Context 提供固定 workspace；缺少工作区时报告准备失败，不自行采用 App 当前目录。

[daemon SDK](../octo-harness-daemon/README.md) 接收本包的 `createImModule` 工厂描述。宿主显式 `startModule("channel-im", {})`，再通过 `requestModule("channel-im", "upsert" | "remove" | "status", params)` 操作。仅携带本包或登记工厂不建联；不需要 worker-access。Octo 接入要求 space 属于当前活跃账号授权租户，账号/租户退出由宿主关闭接入。

`loadImBots(home)` 和 `configuredCredential(config)` 是**显式选择的文件入口适配器**。CLI 在自己的进程入口使用它们；共享 Daemon 未提供 `imBots` 时接入列表为空，不读取 `im.json`。客户 App 可以自行选择文件适配，也可以完全不用文件。CLI 默认值与落盘规则见 [CLI README](../../apps/cli/README.md#im-默认接入)。

## 动态接入：本地设备新增 Agent

当前已支持运行中的单项登记、更新、停用和移除，无需重启整个 Daemon。新增 Agent 是否接入 IM、绑定哪个 Bot、何时取得凭据，均由宿主决定。

| 情况                                   | 当前行为                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| 未显式启用接入                         | 不连接 IM Server，也不执行入站消息。                                                        |
| 已启用，但凭据为空/未取得              | 状态为 `waiting_credentials`，退避后重新调用注入的凭据来源，不影响其他 Bot。                |
| 宿主选择文件适配，文件不存在或内容为空 | 凭据适配返回未就绪；同一路径稍后取得有效内容可被重试读取。                                  |
| 凭据格式、注册身份或认证拒绝           | `authentication_failed`，不以无限网络重试掩盖；宿主更新凭据后重新激活。 |
| 本地新增 Bot/Agent 接入                | 宿主调用 SDK 或 RPC `upsert`，只增加该实例，不扫描目录。                                    |
| 更新已有接入                           | 关闭旧连接、取消该实例活动调用并清理关联，然后按提交配置启动；其他实例保持运行。 |
| 移除/撤权                              | `remove(id)` 关闭并移除该实例；实例不存在时直接成功。 |
| CLI 的 im.json 被编辑                  | 没有文件 watcher 或 CLI reload 命令；文件不会自动转为动态登记。SIGHUP 仍用于关闭。          |

管理操作按调用顺序串行执行，不使用配置版本。一个 manager 最多登记 16 个接入实例；超过上限明确拒绝。配置更新采用关闭受影响实例再替换，**不承诺该 Bot 的在途 Run 无损迁移**。

## 会话与限制

会话按 IM 服务、Space/Bot、接入身份、执行绑定和会话类型/地址隔离。每个会话串行，最多 128 个会话、64 个排队轮次；消息去重最多 4096 项、保留 120 秒。`/session` 返回本地会话信息，`/reset` 在前序轮次完成后清除 Provider handle 并增加 generation。`/stop`、`/cancel` 直接控制活动调用，不排在该调用之后。

标准交互使用 `/approve <interactionId>`、`/decline <interactionId>` 或 `/respond <interactionId> <回答/JSON>` 回到原 invocation。必须是原请求者、原会话且未过期；这些控制消息不发起新的模型 Run。Octo 进度卡的 stop 控制原 Run，retry 仅在明确失败后按一次新的用户操作发起新 Run，投递失败不会自动重跑。

Octo 默认只接收 owner，`allowedSenderIds` 可显式缩小或扩展准入；群/话题还需 `groupIds` 包含父群并真实 @Bot。规则读取由 `groupRules: true` 开启，每轮重新读取群和话题，区分 present/empty/not_found，权限或网络失败阻断该轮发起。历史由 `historyLimit` 显式开启（1–100），按触发序号之前的有限窗口读取、稳定排序，排除当前请求，不设置材料消费水位。

公开最终文本最多 256 KiB；卡片投影最多 512 个进度项与消息。卡片 profile 缓存 5 分钟，进度合并间隔 500ms，终态优先且持久编辑，投递记录各最多 512 项。typing 每 5 秒续期、单 Run 最多 10 分钟，卡片已发送、等待交互、终态或关闭时清理。群卡片不展示工具参数；私聊只展示经过过滤的命令/路径摘要，工具原始输出和私有 reasoning 不外发。

企业微信在 Run 开始时发送一次 `<think></think>` / `finish=false` stream，触发客户端原生思考／输入气泡；不将耗时、工具次数或私有 reasoning 写进聊天正文。最终回复用同一 stream id 的 `finish=true` 收尾，失败、取消、结果未知也明确结束。等待输入时展示交互指令。同一 `req_id` 的回复串行等待 ACK。该方式参考 [Hermes WeCom 原生流实现](https://github.com/NousResearch/hermes-agent/blob/main/plugins/platforms/wecom/streaming.py)，并非独立 typing API。2026-10-14 用户已确认企业微信客户端原生思考气泡与最终回复测试通过。

## 验证与剩余范围

自动化验证在 `test/im-runtime.test.js`、`test/im-protocol.test.js` 和 `test/im-lifecycle-rpc.test.js`：注册/加密 WS、会话/reset/即时取消、交互授权、规则/历史 Context、执行配置解析、卡片 profile/64 位消息 ID/终态屏障、typing 清理、投递重试、动态 SDK/RPC 的基础边界。企业微信测试见 `test/im-wecom.test.js`。

2026-10-14 在 im-test 用 `orbtex-codex` 完成私聊卡片回归：首帧思考中、同卡进度编辑、完成态耗时/计数/折叠与独立最终文本已核对，用户确认“看起来可以了”。实际 Run 的 7 次卡片创建/编辑回执均成功。群/话题、真实规则/历史与 stop/retry 按钮仍需真实环境验收；本地 HTTP/WS fixture 不作为真实界面证据。详见 [验收记录](docs/internal-design.md#真实私聊回归)。

尚未实现：引用回复/免 @ 策略、单独引用消息读取、图片附件/产物的端到端准备与回发、富交互卡、独立外部通知 RPC、持久 outbox、断线续流和跨重启恢复。文件/API helpers 已迁入，不等于这些完整业务流程已实现。下方 29 项保留完整规划与逐项交付状态。

整体架构见 [根 README](../../README.md)。

## 为什么都用 JSON-RPC 2.0，还需要统一 AgentRun 协议？

JSON-RPC 2.0 统一请求、响应、通知与错误的消息格式；AgentRun 统一“一次 Agent 执行”的业务合同。统一 AgentRun 可以继续使用 JSON-RPC 2.0，无须另造 RPC 格式。仅有相同的消息格式，不意味着方法、参数、状态和执行保证相同。

| 层次              | 解决的问题                                                           | 本项目中的例子                                                                  |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 传输              | 消息通过什么连接发送                                                 | stdio、UDS / Pipe、WebSocket；未来云端接口按实际服务适配                        |
| RPC 消息格式      | 怎样表达调用、关联响应、推送通知和返回错误                           | JSON-RPC 2.0 的 `id`、`method`、`params`、`result`、`error`                     |
| Agent 执行合同    | 执行什么、属于谁、如何传入 Context、怎样取消、何时完成、如何交付结果 | AgentRun、Context v3、统一执行事件与交互语义                                    |
| Provider 原生协议 | 某个执行器的具体调用方式                                             | Codex 的 thread / turn / item；未来 Serverless Agent 的任务提交、查询或回调接口 |

Codex app-server 使用双向 JSON-RPC 风格协议，公开 `thread/start`、`thread/resume`、`turn/start` 等方法。官方文档还注明其线上消息省略 `jsonrpc` 字段，因此不应把“都基于 JSON-RPC”理解为消息可不经适配直接互通。[OpenAI 官方 App Server 文档](https://developers.openai.com/codex/app-server)

如果产品只调用 Codex，直接采用它的 thread / turn / item 合同是合理选择，可以减少映射成本。本项目同时接入多种本地 Agent，并计划接入云端 Serverless Agent；若把 Codex 原生合同作为所有入口的公共接口，其他执行器就需要模拟 Codex 的会话、工作区、交互和事件对象，上层也会跟随 Codex 原生接口变化。

统一层的价值是让 IM、Loop、Work App 按同一种执行语义工作：发起一次 Run，传入 Context，消费公开进度，回答交互，请求取消，确认终态和产物。Codex Adapter 负责映射到 Codex 原生调用；其他 Adapter 映射到各自原生接口。当前已有的对应关系见 [Host RPC](../octo-harness-adapter-host/src/rpc.ts) 与 [Codex Adapter](../octo-harness-adapter-codex/src/app-server.ts)。

### 面向云端 Serverless Agent 的设计理由

以下是目标适配场景，不是已经实现的云端能力。假设某个云端 Agent 提交后返回任务 ID，随后通过查询或回调提供结果，且没有本机进程、固定工作目录或可恢复的 Codex thread。它仍可通过适配层履行 AgentRun 合同，上层无需识别该服务的专有任务格式。

| 上层需要的语义 | 本地 Codex 映射                          | 未来 Serverless 映射示例                                       |
| -------------- | ---------------------------------------- | -------------------------------------------------------------- |
| 发起执行       | 准备或恢复 thread，再启动 turn           | 提交云端任务并保存原生任务 ID 的关联                           |
| 跟踪一次 Run   | 关联本次 invocation 与原生 thread / turn | 关联本次 Run 与云端任务；RPC 响应不等于任务完成                |
| 消费结果       | 将原生 item / turn 事件映射为统一事件    | 将查询、SSE 或回调结果映射为统一事件，只报告实际可观察的信息   |
| 取消与交互     | 调用原生中断或响应接口                   | 使用服务实际支持的取消或交互能力；不支持时明确返回限制         |
| Context 与资源 | 应用本地准备结果和原生运行配置           | 使用授权资源引用及云端可接受的输入，不能直接传本机路径         |
| 断线与超时     | 依实际会话、进程和事件状态判断           | 查询原任务或报告结果未知；不能因连接超时认定任务失败并重新提交 |

这里需要分别保留 JSON-RPC 请求 `id`、业务 `run_id` 与 Provider 原生执行 ID：请求 `id` 只关联一次 RPC 往返，不能单独承担跨连接追踪、提交幂等或授权。更换传输连接不应改变同一次 Run 的身份。执行位置变为云端，也不意味着必须先经过云端 Event 登记；执行器适配与 FEAT-IM-006 的可选登记是两个独立问题。

统一合同会带来映射与维护成本，因此只统一上层确实依赖的执行语义。不要复制 Codex 的全部管理 API，也不要把所有执行器压成只有文本的最低共同能力。Provider 特有能力由 Adapter 明确处理；不支持必需语义时应拒绝请求，不能伪造取消、恢复、Context 应用或完成证据。可选扩展继续遵循当前合同的未知字段处理规则。

## 功能规划：边缘 IM 业务发起与投递

本章按 2026-10-13 的职责约束重新评估旧计划和 `openclaw-channel-octo` 的功能。**Channel 是 IM 业务方：获取 IM 信息、构造协议、发起执行、投递结果。AgentRun 执行层统一封装提示词；其他领域的业务任务由各自入口构造 Context 并直接发起。** 下表的“保留／改造／拆分／移出”表示目标归属，不表示功能已实现。原 FEAT 编号保留供需求追踪，原先把 IM 业务上下文移给另一个聊天业务方的判断由本章替代。

这里的“发起”包括本包对有效 IM 触发进行授权、按绑定确定 Agent、调用 build_im_contexts() 构造 Context items 并提交共享执行入口；“投递”是消费标准公开结果并发送到明确授权的 IM 地址。本包不承担文档评论、PPT 编辑或 Loop 任务的处理与回写，也不将它们合成为 IM 消息。本文中的 Channel 指边缘 IM 业务包；Provider Adapter 指 Codex 等执行器适配包，两者职责不同。

Run 保持 `schema_version=7`，Context 保持 `octo.context-envelope/v3`。独立 RPC、routing 与 approval 协议沿用各自版本。协议格式、权限、执行身份、必要执行配置与 mandatory 继续在已有边界校验；不恢复旧 Context 版本、Compiler/Pipeline 或逐业务处理器。

### 目标责任边界

| 主体                                                                           | 负责的内容                                                                                                                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IM Channel（边缘 IM 业务发起方）                                               | 直连 IM Server，负责认证、消息/地址、触发与 Agent 路由、明确范围内的 IM 数据获取与 Context 协议构造、IM 会话关联、发起执行、公开呈现及文本/卡片/typing/附件投递     |
| Docs / PPT / Loop 等其他业务入口                                               | 各自接纳领域事件、构造协议、发起 AgentRun、判断业务变化并回写原对象；需要 IM 通知时调用本包纯投递能力，不经过 IM 聊天处理器                                         |
| HostApp / 入口装配层（CLI 或 daemon 本地 SDK 等）                                 | 决定配置、凭据、账号存储与启动策略，装配共享执行能力和 Channel，管理身份变化和生命周期；无需承担本包的逐轮 IM 数据构造，共享 Daemon 不决定客户 App 的目录与接入方式 |
| AgentRun 统一执行链路（Protocol / 执行配置解析入口 / Host / Provider Adapter） | 校验执行合同及必要配置，准备执行资源，统一分类封装模型输入，调用 Provider，报告实际会话/恢复结果与标准事件；当前由 Host 复用协议 renderer 按白名单固定渲染本轮数据  |
| Access / Worker 集成入口（选用远端执行时）                                     | 远端接纳、路由、租约和执行权交接；IM 复用该入口，不建立另一套云端登记或调度                                                                                         |

build_im_contexts() 位于本包的 IM 发起流程，按协议构造数据，connector 提供 IM Server 读取能力。Host、Worker、daemon 与 Provider Adapter 不采集或补齐这些业务材料。本包可使用 [Context Builder](../octo-harness-context-builder/README.md) 的可选工具，也可以直接创建 ContextEnvelope，不要求另一套流水线。这里不新增通用材料选择、摘要或消费水位机制。

### 功能归属矩阵

“是否在本模块实现”中的“部分”表示必须拆分：只保留表中列出的 IM 部分，其他部分交给目标归属。下表区分职责方案与本轮交付状态；“部分”不表示该行的所有目标已经完成。

| FEAT ID     | 功能点                                                 | 是否在本模块实现                | 处置与目标方案                                                                                                                                                                                                                                                  | 本轮交付状态                               |
| ----------- | ------------------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| FEAT-IM-001 | 模块边界与宿主装配                                     | 是（保留）                      | 宿主经 packages/SDK 注入共享执行能力和配置，动态登记/更新/移除单项接入；本包独立完成 IM 业务发起流程。Home、账号目录、文件发现、凭据存储和启动默认值由宿主/入口决定。                                                                                           | 已实现：公共端口/动态装配                  |
| FEAT-IM-002 | Bot 绑定、身份授权与配置校验                           | 部分（拆分）                    | 本包验证连接身份、发送者、群/话题读取权限、Bot/Agent 授权绑定与配置；执行入口继续验证执行身份及权限。凭据不进入模型或公开日志，不信任正文自报身份。                                                                                                             | 部分：注册身份/发送者/群授权               |
| FEAT-IM-003 | 连接与单一接入所有权                                   | 是（保留）                      | WS 认证、心跳、重连退避、连接代次与关闭清理属于接入；部署方/服务端须明确同一 Bot 的单一接收权，不把 ACK 当执行成功。                                                                                                                                            | 已实现：连接/退避/关闭；部署所有权外置     |
| FEAT-IM-004 | 消息与会话地址规范化                                   | 是（改造）                      | 本包保留消息 ID、修订、sender、群/话题/引用地址与 parts；编辑/撤回事件不自动重跑已有 Run，不能撤销已发生的工具副作用。                                                                                                                                          | 部分：文本与群/话题地址                    |
| FEAT-IM-005 | 群触发与被动上下文                                     | 是（改造）                      | 本包依据配置处理私聊、真实 @Bot、有效回复和免 @ 策略，过滤自回环；普通群消息默认不创建 Run。历史读取按 FEAT-IM-010 的明确范围实现，不为被动消息引入模型调用。                                                                                                   | 部分：显式群 + 真实 @                      |
| FEAT-IM-006 | Agent 选择、触发幂等与可选登记                         | 部分（拆分）                    | 本包按授权绑定选择 Agent，关联消息/Event/Run并处理触发幂等；执行接纳与远端登记复用共享入口，明确唯一执行权，不同时本地/远端执行。                                                                                                                               | 部分：静态绑定与内存触发去重               |
| FEAT-IM-007 | 会话作用域与多 Agent 隔离                              | 部分（拆分）                    | 本包隔离服务、Space、Bot、群/话题与 Agent 的 IM 会话关联；Provider handle 依执行入口管理，不将评论串映射到 IM 会话。                                                                                                                                            | 已实现：有界会话隔离                       |
| FEAT-IM-008 | 排队、取消与会话命令                                   | 部分（拆分）                    | 本包维护有界队列、授权命令与 IM 会话代次，转发 reset/cancel，并决定后续 Event 所需背景；执行层报告实际取消/恢复结果。停止不得排在活动 Run 之后等待。                                                                                                            | 已实现：队列/reset/即时取消                |
| FEAT-IM-009 | IM Context 协议构造与 AgentRun 统一封装                | 是（改造；模型封装归 AgentRun） | IM Channel 直连 IM Server，本身就是 IM 发起方；build_im_contexts() 将 IM 信息构造成标准 item 列表，区分材料、业务扩展、可信控制项与执行配置。AgentRun 统一封装提示词。文档评论 Context 由评论发起方构造并直接提交，不合成 IM 消息，不提供 before_prompt_build。 | 已实现：协议 items + 统一封装              |
| FEAT-IM-010 | 历史窗口、引用与完整性                                 | 是（改造）                      | 旧 IM 入站已有群历史和引用能力；目标由本包在授权会话内按明确窗口获取并构造标准 items，稳定排序、标记缺口，不重复放入当前请求。当前 historyLimit 显式设置为 1–100；引用和缺口查询尚未实现，不新增通用数据选择引擎。                                              | 部分：有限历史窗口；引用待实现             |
| FEAT-IM-011 | 增量上下文与冷启动恢复                                 | 部分（简化）                    | 保留统一合同对空、增量、重复 items 的支持；不照搬旧历史分段、回复水位推断或自动补齐机制。执行层报告实际恢复结果；本包后续发起时重新构造明确输入，不恢复隐藏 Context。                                                                                           | 已实现：空/重复输入，无隐藏补齐            |
| FEAT-IM-012 | 本轮快照与失败处理                                     | 部分（简化）                    | 本包冻结本轮输入，关联 Event/Run 与独立投递结果；同一 Event 重投使用原快照。接纳/持久化复用选定入口与宿主存储，不另建材料消费水位，不把准备成功当模型已消费，不因投递失败重跑 Run。                                                                             | 部分：本轮克隆；无持久 Event 重投          |
| FEAT-IM-013 | 获取群 GROUP.md + 话题 GROUP.md，构造标准 context-item | 是（改造）                      | 本包经直连 IM connector 授权获取当前群与话题正文，构造标准 items，保留来源/作用域/版本。AgentRun 统一封装，不预拼提示词。旧插件话题文档名为 THREAD.md，本项按话题 GROUP.md 能力描述。                                                                           | 已实现：群/话题规则标准 items              |
| FEAT-IM-014 | GROUP.md 信任等级与映射                                | 是（改造）                      | 本包依据认证身份与服务端管理权限区分普通材料和可信控制项，按现有协议构造；执行边界继续检查权限，文件名或正文自报身份不能升权。                                                                                                                                  | 已实现：规则仅普通材料，不自动升权         |
| FEAT-IM-015 | 规则变更、清空与撤权                                   | 是（改造）                      | 当前不缓存规则，每轮重新授权读取，下一轮直接看到修改、空正文或 404；无需复制规则事件缓存失效逻辑。已提交快照不变，不向在途 Run 注入；撤权阻断后续读取/执行/投递。                                                                                               | 已改为每轮读取；无规则缓存/变更消费者      |
| FEAT-IM-016 | 本地 group.md 显式使用                                 | 部分（拆分）                    | 宿主显式提供文件绑定、路径与读取授权，本包按 IM 策略读取/分类并构造 items；不扫描 cwd/Home，不写 Provider AGENTS.md，不隐式扩大到其他群。                                                                                                                       | 待实现：显式本地文件绑定                   |
| FEAT-IM-017 | 预算、裁剪与摘要                                       | 部分（简化）                    | 本包限制 IM 读取范围和协议输入容量，超限显式报告；不新增自动摘要/语义裁剪流水线。执行层校验容量，提交后不裁剪、重排、压缩或摘要本轮 items。                                                                                                                     | 部分：读取/协议预算；无摘要流水线          |
| FEAT-IM-018 | 附件、图片与引用资源准备                               | 部分（拆分）                    | 本包处理 IM parts 与授权引用，按协议提交正文或资源标识；执行资源物化复用已有准备能力，Host 不自行预取业务材料，不伪称图片已加载。                                                                                                                               | 部分：API helper；入站资源流程待实现       |
| FEAT-IM-019 | 执行策略与统一准备                                     | 部分（拆分）                    | 本包传递明确执行意图；已有入口解析权限、mandatory、模型、工作区、资源和租约。IM 构造 Context 时 approval 缺省 full_access，显式策略按协议解析；后续若增加权限上限，必须复用执行入口约束。                                                                                            | 已实现：共享执行配置解析                   |
| FEAT-IM-020 | 标准事件消费与断线续流                                 | 是（保留）                      | 仅消费标准事件，关联 Run/消息/序号，复用可用续流能力；缺口、过窗与结果未知如实报告。恢复流不重新 invoke，不解析 Provider 私有协议。                                                                                                                             | 部分：标准消费；续流待实现                 |
| FEAT-IM-021 | 通用协议进度卡、typing 与最终答案投影                  | 是（改造，明确实现范围）        | 标准执行事件投影成通用投递意图；按能力协商发送/编辑同一进度卡，终态持久收敛，typing 随接纳/卡片可见/交互/终态清理。final 独立投递，公开范围由协议决定，不公开私有 reasoning/工具凭据；具体模块边界见内部设计。                                                  | 已实现；私聊基础实机通过，群/按钮待验 |
| FEAT-IM-022 | 投递幂等、限流与重试                                   | 是（保留）                      | 独立记录发送/更新/分段结果，合并进度、限制队列、对未知回执查询或幂等核对。只重试投递，不重跑执行；未建立持久保证前不承诺跨重启 exactly-once。                                                                                                                   | 部分：有界重试/幂等；无持久补发            |
| FEAT-IM-023 | 文件与产物回复                                         | 部分（拆分）                    | 本包根据标准执行结果处理授权 IM 产物的上传、附件/链接发送与回执；执行入口提供产物合同，不扫描工作区，不判断 Docs/PPT 等业务验收。                                                                                                                               | 部分：上传发送 API；产物投影待实现         |
| FEAT-IM-024 | 交互请求、用户回答与审批响应                           | 部分（拆分）                    | 本包展示标准交互，验证 IM 响应者并关联原 Run/interaction/期限，经原入口回传；执行层验证交互与审批有效性。IM 卡片业务操作由本包处理，其他领域按钮交还对应入口。                                                                                                  | 部分：文本交互 + 进度卡 stop/retry         |
| FEAT-IM-025 | 外部业务通知与渠道扩展                                 | 部分（拆分）                    | 外部业务可提交已授权、明确内容/目标的 IM 通知请求，复用本包投递；该通知不触发模型，不改变本包对 IM Run 的发起和回复职责。渠道扩展只适配 IM 收发能力。                                                                                                           | 部分：多平台端口；外部通知 RPC 待实现      |
| FEAT-IM-026 | 有界状态与恢复保证                                     | 部分（拆分）                    | 本包约束 IM 读取/规则缓存、快照、连接、去重、会话和投递状态；需要持久化时使用宿主显式存储能力，不默认复制旧数据库/outbox 或材料消费游标。其他业务 ACK/死信归各自入口。                                                                                          | 部分：有界内存；持久恢复待实现             |
| FEAT-IM-027 | 切租户、撤权与关闭清理                                 | 部分（拆分）                    | 宿主广播身份变化，本包阻断受影响 IM 接纳/读取/投递，清理历史/规则/连接/关联，核对晚到回调代次；关闭不影响共享执行入口的其他业务。                                                                                                                               | 已实现：单项关闭/替换；账号由宿主驱动      |
| FEAT-IM-028 | 诊断、审计与真实环境验收                               | 部分（拆分）                    | 本包追踪 message → Context 来源/版本与 Event → Run → delivery，记录 IM 触发、材料缺口及投递问题；执行证据由共享入口返回，日志默认不存正文/凭据。                                                                                                                | 部分：脱敏状态/自动化；真实验收待完成      |
| FEAT-IM-029 | 统一执行合同与 Serverless 适配                         | 否（移出）                      | Protocol/Host/Provider Adapter 提供统一执行语义与云端适配；IM 只复用公共入口和事件，不能按 Provider 增加业务分支。实际云端接口选定前为待实现。                                                                                                                  | 移出：执行层，云端适配待实现               |

### 旧插件逻辑与事件取舍

以下是对当前本地 `openclaw-channel-octo` 的迁移评估，不修改旧插件行为，也不把旧插件的实现当成新包承诺。

| 旧逻辑或事件                                                                       | 新 Channel 是否实现                | 目标方案                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS 私聊、群聊、话题消息                                                            | 是，按范围逐步补齐                 | 已支持私聊及显式父群授权下的真实 @Bot 群/话题文本；引用回复和免 @ 尚未接通。                                                                                                                                                        |
| `before_prompt_build` 追加 GROUP/THREAD.md、成员名单、历史、persona 与工具提示     | 否，改为协议构造                   | IM Channel 在自身发起流程通过 build_im_contexts() 构造标准 items，配置中的控制项须有明确授权；AgentRun 统一封装模型输入。不能返回 prependContext/prependSystemContext 或预拼提示词，不建立 pendingInboundContext/persona 推断缓存。 |
| `before_agent_run`、`llm_output`、`agent_end` 等进度绑定/收敛钩子                  | 不照搬 OpenClaw 钩子；保留投递目的 | 由共享执行入口的标准 Run/message/interaction 事件驱动 IM 呈现。进度归属绑定与业务 Context 注入是不同职责。                                                                                                                          |
| `group_md_updated` / `group_md_deleted`、`thread_md_updated` / `thread_md_deleted` | 是（改造）                         | 当前无规则缓存，每轮按 FEAT-IM-013 获取并构造 items，无需独立事件消费者。配置事件本身不创建 Run，不向已提交快照追加内容。                                                                                                           |
| `mention_pref_updated`（免 @ 偏好）                                                | 部分，按产品需要                   | 本包核对服务端授权配置后更新 IM 触发行为，不把偏好当成模型 Context，不因配置事件启动模型。免 @ 不作为默认能力。                                                                                                                     |
| `doc_comment_mention`（普通 Docs、Sheets、画板、HTML、PPT）                        | 否                                 | Docs 对应业务入口授权接纳评论，提供当前请求与分类 Context item 列表，直接发起 AgentRun，复用相同模型输入封装；业务方消费结果并通过该文档的评论 API 回写原评论线程。                                                                 |
| `synthesizeDocMentionMessage()` 与 `docTask` 特殊分支                              | 否（移出，不迁入）                 | 旧插件把文档评论合成为 DM 形状消息，复用 IM inbound 后再抑制 IM 出站、改写评论会话和回写路径。这是非标准业务适配；新包不提供此入口。评论发起方直接构造 Context 并调用统一 AgentRun，不通过 IM 会话、队列或投递处理器。              |
| PPT revision/CAS、planning reply 判定、一次 continuation、评论进度 receipts        | 否                                 | PPT 业务负责版本校验、编辑结果验证、续轮决策、期限、回帖和不确定副作用处置；执行成功或已回复不等于编辑成功。                                                                                                                        |
| 通用 `bot_task`                                                                    | 否                                 | 任务生产方/业务消费入口直接构造并发起 AgentRun，负责来源幂等、重试、ACK、死信和业务回写；不伪造成 IM 消息，也不复用 docTask 来吞掉 IM final。                                                                                       |
| `card_action` 回答当前 Run 的输入/审批交互                                         | 部分                               | 本包处理卡片收发、真实响应者与 interaction 关联，经原执行入口回传；不默认合成普通聊天消息并开启新 Run。                                                                                                                             |
| `card_action` 执行业务按钮或发起新的业务任务                                       | 部分（按来源分开）                 | 本包处理自身 IM 卡片的操作，retry 经 IM 发起流程按授权新建 Run，delivery 不自动重跑。Docs/Loop 等其他业务按钮归其发起方，不合成为 IM 消息。                                                                                         |
| `bot_setting_updated`                                                              | 部分                               | 本包校验并应用授权的连接、Agent 绑定、IM 触发和卡片配置；如涉及经授权的控制项，在下一次发起时按协议构造，不通过 prompt 钩子或补丁修改在途 Run。                                                                                     |
| typing、进度卡、文本发送                                                           | 是，明确实现                       | 参考旧 Channel 通用投递协议实现模板能力协商、卡片创建/更新/终态收敛与 typing 生命周期，保持结果回执与 Run 状态独立；附件和已读另按产品范围接入。                                                                                    |
| `octo_management` 等群管理、规则编辑、voice context 与业务工具注册                 | 否                                 | 由对应业务工具/Skill/MCP 或宿主工具配置提供；Channel 不注入业务工具提示，不承担群规则编辑或业务工具授权。卡片发送工具如需要可复用明确的 IM 投递能力。                                                                               |
| 连接后向 owner 发 greeting                                                         | 非必需                             | 如产品需要，由宿主/业务方显式请求普通通知投递，不设为默认业务行为。                                                                                                                                                                 |
| 业务事件的通用 `/v1/bot/events` 轮询、cursor、ACK 与 dead-letter                   | 不整包迁入                         | Docs/bot_task 的消费协议由对应入口负责；如卡片回调依赖该接口，仅接入所需事件类型。混合队列的路由/ACK 归属需先明确，不能 ACK 尚未移交的业务事件。                                                                                    |

关键区别：旧插件为外部业务任务增加“禁止 IM 出站、改走评论、检查版本、补跑一轮”等分支，是因为多个业务被复用了同一个 IM dispatch。新方案由各发起方构造 Context，直接调用统一 AgentRun 并处理本业务回写，IM Channel 无需按 doc_kind、task_type 或业务结果切换出站方式。业务任务如还需要通知聊天，由业务方另行提交授权 IM 投递请求。评论锚点/选区、PPT revision/CAS 和 continuation 都不是 IM Context 能力。

### 协议构造与统一封装

所有 AgentRun 使用同一执行合同和模型输入封装规则。IM、Docs、Loop 等入口的差异体现在业务方提交的协议数据中，不通过各自的 before_prompt_build、字符串前缀或隐藏 prompt 注入实现。

`build_im_contexts()` 已在 [Octo Context 构造](src/connectors/octo/contexts.ts) 实现。IM Channel 就是调用方，通过直连 connector 获取当前 IM 作用域的信息，包括 FEAT-IM-013 的群 GROUP.md 和话题 GROUP.md，返回有序 `ContextItem[]` 并放入 `ContextEnvelope.items`，信封使用 `schema: "octo.context-envelope/v3"`。它不生成最终模型提示词，不返回 OpenClaw 的 prependContext/prependSystemContext，不渲染 contexts 块，也不把上下文附加到当前用户请求。该函数不要求宿主逐轮代为构造，不是泛化的数据选择引擎，也不处理文档评论 Context；各类业务由自己的发起方构造协议数据。

群与话题正文以现有普通材料或业务扩展协议 item 表达，分别保留可追溯的来源、群/话题作用域与版本；群在前、话题在后。未配置、空正文、无权限与读取失败分别返回可识别结果，不把读取失败当作空规则。文件名不授予控制指令权限，可信控制项仍遵循 FEAT-IM-014 的授权边界。该能力属于改造，不是删除 GROUP.md 功能。

协议数据与最终模型输入分开：历史正文、规则原文等可以作为 payload 中的业务数据；“当前请求”保留独立输入。入口不将这些数据预先拼成提示词。AgentRun 执行链路根据协议类别封装，并保留材料与控制指令的信任边界。

| 类别                      | 协议表示                                                                      | AgentRun 执行链路的处理                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 当前用户请求              | 当前执行合同的请求文本/parts，独立于 Context items                            | 作为本轮请求传给模型，不在 Context 中重复拼接。                                                                                                                 |
| 普通正文材料              | `octo.content/inline`                                                         | 按协议渲染为普通模型上下文；正文中的命令不因此成为控制指令。                                                                                                    |
| 引用描述                  | `octo.content/references`                                                     | 渲染引用描述，不自动读取正文；业务方需要正文时自行授权读取并按材料提交。                                                                                        |
| IM 或其他业务的结构化数据 | `extra.<domain>/<name>`，通过 namespace/name 区分类别                         | 完整、保序渲染 guidance/payload，不注册逐业务 renderer 或推断材料。IM 发起方构造 IM 信息；文档评论的锚点/选区由评论发起方构造，不进入本包。不新增必填业务类别。 |
| 经授权的控制指令          | `octo.control/instructions`                                                   | 进入独立控制指令通道，不混入普通材料块。群规则或 persona 只有经授权配置方明确提交为控制项时才按控制项处理。                                                     |
| 执行配置与路由            | `octo.execution/*`、`octo.runtime/selection`、`octo.security/approval_policy` | 在执行边界解析和校验，用于模型/工作区/权限/路由等设置，不拼入模型上下文。                                                                                       |
| 其他未知可选类型          | 其他 namespace/name                                                           | 保存、转发并忽略消费，不宣称已应用；需要模型读取的业务扩展使用 extra 命名空间。                                                                                 |

当前统一封装已有代码基础：[协议分类与渲染](../octo-harness-protocol/src/model-context.ts) 和 [Host 模型输入封装](../octo-harness-adapter-host/src/model-input.ts)。目标是让各入口复用这条 AgentRun 执行链路，不让业务构造函数或 Channel 各自封装一次。Provider Adapter 仅将统一输入映射到原生接口；renderer 不增加业务采集、材料预取、摘要或历史恢复策略。

### 目标流程与 Context 契约

**聊天发起**

1. Channel 接收并验证 IM 来源，规范化消息/地址，按显式配置判定有效触发。
2. Channel 按授权绑定确定执行目标，保留独立当前请求，调用 build_im_contexts() 获取对应 IM 信息并构造本轮协议 item 列表与 ContextEnvelope；不拼接提示词，不将评论或业务任务伪造成 IM 消息。
3. Channel 冻结本轮 Event 输入，经已选共享执行入口发起一次执行并保存必要关联。当前本地 Host 路径不强制云端登记。
4. AgentRun 统一执行链路按协议分类封装模型输入并执行；Channel 消费标准公开事件，向已确定的 IM 地址投递文本/卡片/附件，分别报告执行状态和投递状态。
5. reset、新建 Provider 会话或 resume 失败时，执行层报告实际状态；Channel 后续发起重新构造明确输入，不从历史 Event 自动补齐。

**评论或业务任务发起**

1. Docs、PPT 或任务业务入口接纳并授权自身事件，确定业务对象、Agent、幂等键和业务会话。
2. 评论/任务发起方提供当前请求，按协议构造并冻结本轮 Context item 列表，直接通过其选定的 AgentRun 执行入口提交，复用统一分类和封装；不调用 synthesizeDocMentionMessage，不使用 docTask，不经过 Channel 的 IM 消息处理、会话映射或队列，不预拼最终提示词。
3. 业务方消费标准结果，验证实际业务变化，回写原评论/任务对象，并处理自身 ACK、失败与不确定副作用。
4. 需要 IM 通知时，业务方提交明确内容、目标和幂等身份的投递请求；Channel 只处理该次通知。

**逐轮 Context 约束**

- 本轮内容、顺序和发送时机由对应发起方决定：IM 是本包，评论是评论入口。协议允许空、增量或显式重复；这些协议能力不意味着本包要实现通用数据选择引擎。
- Channel 构造并提交本轮 IM 快照；执行层不按 sessionId、run 次序、上下文 hash 或消费水位缓存、补齐、合并、去重或省略。两个不同 Event 的相同 items 均须传递；同一 Event 的幂等重投使用原快照。
- 引用可以只提供描述。IM 范围的正文获取和 GROUP.md 构造由本包完成，文档评论材料由评论发起方提供；Host 不预取引用或调用摘要/编译流水线。
- 必要 adapter/model/workspace/approval 等执行项仍按合同解析，且不注入模型上下文。空模型上下文有效，不表示执行配置缺失。
- `sessionId` 与 Provider handle 不是模型已保存背景的证据；不得将连接恢复或执行接纳等同于 Context 已应用、业务成功或 IM 已显示。

### 剩余实施与验收

本轮已完成 primitive 接入、IM Context 构造、标准卡片/typing、动态接入及文本交互，源码路径与自动化验证见前文。后续按独立需求补齐引用/附件/产物、富交互和持久恢复，不能因 API helper 存在就宣称流程已完成。

1. 在 im-test 补齐群/话题授权、GROUP.md/历史和长任务多阶段展示；继续核对真实客户端与服务端投递回执。私聊基础卡片回归已通过，不能据此推断其他场景通过。
2. 验证真实 stop/retry 的原 Run 归属、响应者身份和权限撤销，分别记录执行结果与投递回执；未知结果不能标记成功或自动重跑。
3. 接入独立引用、附件和产物时，复用已有准备协议与授权读取；不扫描工作区、不迁入 Docs/PPT 评论消费者。
4. 如需持久投递/恢复或多消费者共享 bot events，先明确宿主存储与分流/ACK 合同。当前 card poller 的 cursor 仅为本地读取位置，非卡片业务事件不 ACK、不回写，也不代表已移交其他生产者。

包内目录与参考工程展示规则见 [内部设计](docs/internal-design.md)，平台边界见 [多平台设计](docs/multi-platform-design.md)。

### 梳理依据

- 当前包：[IM 编排](src/application/im-channel.ts)、[悟空连接](src/connectors/octo/wukong.ts)、[基础测试](../../test/im-runtime.test.js)。现状依据源码；自动化验证与真实环境验收分别记录。
- 现行约束：[Context 注入矩阵](../../docs/context-llm-injection.md)、[Context Builder](../octo-harness-context-builder/README.md)、[Protocol](../octo-harness-protocol/README.md)、[Host RPC](../octo-harness-adapter-host/src/rpc.ts) 与 [Event Context IPD-SE](../../../docs/event-context-rendering-ipd-se.md)。不恢复已删除的 Compiler。
- 对照仓库：`/Users/lvsijia/github.com/Mininglamp-OSS/openclaw-channel-octo`。重点核对 `README.md`、`index.ts` 的 before_prompt_build/进度钩子、`src/inbound.ts` 的历史/成员/群规则拼接、`src/channel.ts` 的入口装配、`src/events-poll.ts` 的混合事件消费、`src/doc-mention-handler.ts` 和 `src/bot-task-handler.ts` 的业务任务处理。
- 卡片与 typing 参考：`/Users/lvsijia/codex.mlamp.cn/octoft4/octo-agent-app-channel` 的 `internal/ports/interfaces.go`、`internal/connectors/octo/card_api.go`、`progress.go`、`connector.go` 和 `internal/service/delivery_svc.go`；已核对通用投递意图、模板 profile、template-ref 收发、card_seq/transient 与 typing 清理。详细对应关系见内部设计。
- 旧 Channel/daemon 的历史取窗、awareness、Context store/消费游标，以及 [本地流与 ACK 提案](../../docs/26-channel-local-stream-and-ack-plan.md) 仅作历史参考；其中业务上下文归属和旧编译要求不得覆盖本章及全局 Context 约束。

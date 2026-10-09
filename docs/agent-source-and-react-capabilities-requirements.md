# Agent 提供方式与 ReAct 能力需求

日期：2026-10-09（Asia/Shanghai）。状态：当前分支已实施，CodeBuddy 与 OpenClaw 真实调用验收通过。

本文使用 technical-writing-zh 记录需求、执行合同和验收依据。实现覆盖 Worker、Harness、Work App 和配置管理页；当前分支实现不表示生产环境已部署。

## 1. 已确认需求

| 项目 | 已确认要求 |
| --- | --- |
| 行为能力 | Octo Harness 对外的 `capabilities` 当前只包含 `react`；默认值为 `["react"]` |
| Agent 提供方式 | 新增 `agent_source`，仅接受 `preset`、`provisioned` |
| 类型边界 | `agent_source` 不放入 `capabilities`；执行路径也不放入 `capabilities` |
| 分类删除 | 不恢复 Agent 的 `assistant / expert` 分类，不用这项分类控制任务候选或执行权限 |
| 上下文处理 | 使用统一 Context Compiler 和既有准备管线，不新增 `context_profile` |
| 当前范围 | 本轮不增加 `delegation`、`handoff` 等公开能力值 |

`react` 表示执行方能够依据任务输入，调用已配置且获授权的工具，观察工具结果，并继续处理直至本次执行结束。该声明不保证每次执行都调用工具，也不保证任何特定工具、图片输入、审批方式、文件系统或会话恢复机制。

默认 `["react"]` 的范围是本轮 Harness 接入合同。不能据此自动给所有云端 `ability_provider` 或任意第三方 RAG 服务标记 `react`。这些执行方是否具备该行为，仍需独立确认。

## 2. `agent_source` 的含义

| 值 | 定义 | 调用前置条件 | 本次执行行为 |
| --- | --- | --- | --- |
| `preset` | 接入方已经提供定义好的 Agent，Octo 选择或绑定后调用 | 目标 Agent 存在，引用可解析，调用方获授权 | 向指定 Agent 传入本次输入和编译后的上下文 |
| `provisioned` | Octo 提供 Agent 定义，由基础执行方承载运行 | 执行方可用，并支持应用本次定义和执行配置 | 应用 Octo 定义及编译结果，创建或继续执行会话 |

`preset` 不是 Octo 内置模板，也不等同于外部部署。`provisioned` 不要求接入方持久创建一个固定的 provider Agent；通过 app-server、ACP、SDK 或 CLI 创建执行会话，也可以承载 Octo 提供的定义。

来源不决定工具权限、文件系统权限或部署位置。两种来源都接收本次任务上下文；两种来源都可能有或没有可供 Octo 使用的文件系统。

| 场景 | 执行路径 | `agent_source` |
| --- | --- | --- |
| Octo 定义由 Codex、CC、MiMo、Pi 等基础执行方承载 | WS 连接 Harness daemon | `provisioned` |
| 调用 OpenClaw 已有 Agent | WS 连接 Harness daemon | `preset` |
| 云端根据 Octo 定义运行 Agent | `ability_provider` | `provisioned` |
| 云端调用接入方预置的 RAG Agent | `ability_provider` | `preset` |

上表表达目标分类，不表示列举的每个 adapter 已完成接入或通过验收。传输协议不决定来源；不能根据“使用 app-server”或“通过 WS 连接”直接推断 `agent_source`。

## 3. 字段归属与冻结合同

当前字段合同如下：

| 位置 | 实现合同 | 责任 |
| --- | --- | --- |
| Worker Agent 定义 | `agent_source`、`capabilities`；来源在创建后不可修改 | 描述所调用 Agent 的提供方式和行为 |
| Adapter 注册元数据 | `agentSources`、`capabilities`、`executionFeatures` | 分别声明来源、行为和底层执行条件 |
| Runtime 注册快照 | `agent_sources`、`capabilities`、`execution_features`，独立保留 `available` | 供 Worker 选择执行目标 |
| Run 冻结执行合同 | `resolved_execution_plan.agent_source`、`provider_agent_id` | 保证排队、重试和恢复使用同一提供方式与目标 |
| InvokeRequest | `agentSource`、`agentConfig.providerAgentId` | 让 adapter 按确定语义映射 provider 调用 |

Agent 的 `agent_source` 与 adapter 支持范围不是同一个字段含义。一个 adapter 是否同时支持两种来源，需要按实现确认，不能仅根据 provider 名称决定。

新建 Agent 必须显式指定 `agent_source`。已有记录必须按实际调用方式赋值；调用已有 OpenClaw Agent 的记录应使用 `preset`。在途 Run 消费冻结计划，不重新读取当前来源或目标。会话兼容性计算包含来源和目标，防止复用不兼容的 provider session。

## 4. 改造前的问题

以下内容记录改造前的合同问题，属于改造依据：

| 当前位置 | 当前行为 | 与目标需求的差异 |
| --- | --- | --- |
| `AdapterMetadata.capabilities` | 使用字符串数组表示会话、工具、图片等执行细节 | 同一个公开字段混合行为能力与接入细节 |
| daemon Runtime 注册 | 原样上报 adapter capabilities | Worker 和客户端拿到的是细粒度实现标签 |
| daemon 执行准入 | 按 `required_capabilities` 检查会话、图片、MCP 等条件 | 不能直接把数组替换成 `react`，否则现有检查失效 |
| Adapter Host | 通过 capabilities 检查审批、图片和动态 MCP | 底层检查需要迁移到内部执行合同 |
| `prepareRunContext` | 为运行准备 fixed/random workspace 和 provider 状态目录 | 当前准备产物统一要求本机工作目录 |
| `mapExecutionEnvelope` | 没有 workdir 时拒绝生成 InvokeRequest | 无文件系统的 preset 调用无法表达 |
| Protocol `assertInvokeRequest` | 要求非空 workdir | 工作目录被当作所有接入方共同前置条件 |
| OpenClaw adapter | 支持现有 external-binding 分支和受控 runner 分支 | 当前开关需要与新 `agent_source` 的语义对齐 |
| OpenClaw 目标选择 | 未配置目标时回退到 `octo-openclaw-runner` | preset 调用可能落到非用户选定的 Agent |
| OpenClaw session 创建 | 把 `req.workdir` 作为 cwd 传入 | Octo 本机路径不能自动解释为远端 Agent 工作目录 |

当前 ContextPipeline 已统一执行准备、编译、消费检查和回执封存。本次应修改这条管线的合同与映射，不另建一条 preset 专用上下文管线。

## 5. Octo Harness 改造需求

### 5.1 Protocol 与 Adapter SDK

Protocol 必须定义 `agent_source` 的两种取值，并在实际执行合同中校验。来源缺失、未知或与执行目标不匹配时，应在 provider 启动前返回可定位的错误。

公开 `capabilities` 必须使用粗粒度语义。本轮 Harness 只声明 `react`，不把 `preset`、`provisioned`、文件系统、会话恢复或 MCP 标签混入该数组。

底层执行约束保留在 `executionFeatures` / `execution_features`。本次请求显式需要的条件使用 `required_execution_features`，公开行为条件使用 `required_capabilities`。审批、图片、MCP、skills、会话恢复和 watchdog 仍按实际执行特性检查。

schema 源文件、生成的 TypeScript 类型、校验器、Go 消费端和合同 fixtures 已同步调整。Runtime Run Contract 使用 `schema_version: 5`；Invoke 事件协议仍使用 `protocolVersion: 2`。旧 Run 合同不通过新版本准入。

### 5.2 Adapter Host 与能力发现

Adapter Host 必须分别判断行为支持、来源支持和本次输入的可执行性。

`capabilities: ["react"]` 不等于 provider 已安装、已登录、目标 Agent 存在或本次执行可成功。发现与 probe 的可用状态必须继续独立表达。

审批、图片、动态工具注入等校验必须继续有效。某 adapter 没有会话恢复能力，不应仅因此拒绝一次不要求恢复的普通 ReAct 执行。

现有 `runtime.watchdog.v2` 等运行控制信息不得在改造后继续追加到公开行为能力数组；它们仍由运行控制合同表达和校验。

### 5.3 daemon 接收、准备与映射

daemon 必须在读取资源或启动 provider 前检查：已冻结来源、已授权执行目标、adapter 可用性、来源支持范围，以及本次输入要求的实际执行条件。

| 处理环节 | `provisioned` | `preset` |
| --- | --- | --- |
| Agent 定义 | 按合同应用 Octo 提供的定义 | 定位接入方已有 Agent，不隐式创建替代 Agent |
| 任务上下文 | 经统一 Compiler 生成调用输入 | 经同一 Compiler 生成调用输入 |
| 工作目录 | 按本次执行策略和 provider 合同准备 | 仅在本次请求需要、且目标接入支持时准备或映射 |
| 本机临时文件 | 可用于执行、资源物化和 provider 状态 | 可用于附件物化，但不等同于 preset Agent 的内部 workspace |
| 内部配置 | 按本次定义和授权执行配置应用 | 只通过明确支持的调用参数传入，不隐式重写预置 Agent 定义 |
| 必需资源无法应用 | 启动前拒绝，并报告失败项 | 启动前拒绝，并报告失败项 |

Protocol、PreparedRunContext、准备回执和 InvokeRequest 必须能够表示“不需要用户工作目录”。不得为了满足当前非空字段而给 preset 调用伪造 cwd。来源也不能替代实际工作目录需求判断：某个 preset Agent 仍可能明确支持工作目录参数。

统一 Compiler 负责生成输入；adapter 负责映射 provider 参数。把图片、工具配置或远端文件路径写进 prompt，不代表这些资源已经可用。必要配置必须有实际应用证据；不得静默丢弃。

现有 lease/fencing、来源边界、资源授权、取消、消费检查、上下文 hash 和封存确认规则继续适用。Compiler 成功、provider 接受请求和任务完成是三个不同状态。

### 5.4 OpenClaw adapter

调用预置 OpenClaw Agent 时，必须使用 `agent_source: "preset"`，并携带已经解析且获授权的目标引用。

缺少目标、目标不存在或无权调用时，必须明确失败。不得回退到默认 runner，不得把 daemon 在线解释为目标 Agent 已接入。

`preset` 路径不得要求预置 Agent 清空 skills、关闭 memory 或采用 Octo runner 的内部隔离配置。当前 runner 的配置校验不能套用到任意预置 Agent。

本次任务上下文仍可以通过 OpenClaw 已支持的消息、额外指令等调用参数传入。一次调用传入额外指令，不表示 Octo 获得了该 Agent 永久定义的管理权。

不得把 Octo 本机 cwd 直接当作远端 Agent workspace。若请求明确要求工作目录覆盖，接入实现必须验证 provider 支持情况和路径语义，否则拒绝该覆盖项。

旧 `externalBinding` 开关已移除。OpenClaw adapter 支持两种来源：`preset` 调用已有 Agent，`provisioned` 保留受控 runner 路径及其隔离校验。目标必须由 Context 显式提供，不回退到 `main` 或默认 runner。

## 6. Worker 与客户端联动

| 模块 | 必要联动 |
| --- | --- |
| Agent 模型、创建与查询 | 新增 `agent_source`，公开 capabilities 按粗粒度语义表达 |
| Runtime 注册与读取 | 接收新的行为能力与来源支持信息，保留独立的可用状态 |
| 执行前检查与调度 | 检查来源、preset 目标和本次执行条件；不再把细粒度标签当作 Agent 业务能力 |
| Run 快照与命令下发 | 冻结来源及目标引用，传入 Harness 合同 |
| Context 计划 | 移除“所有 Agent 都有工作目录”的前提；保留明确请求的执行约束 |
| 客户端 | 按提供方式收集配置；preset 选择已有 Agent，provisioned 提供定义和执行配置 |

Agent 默认配置不得再次无条件要求会话恢复、文件系统或特定工具注入能力。本次输入确实依赖这些机制时，执行层仍需检查并拒绝不支持的目标。

`ability_provider` 与 Harness 是独立执行路径。`agent_source` 可以跨路径使用，但本轮 Harness 默认 ReAct 声明不能替代云端执行方的资格确认。执行路径字段名称本轮不重新定义，也不复用已删除的专家/助理分类。

## 7. 验收条件

| 场景 | 通过条件 |
| --- | --- |
| 能力发现 | Harness adapter 对外 capabilities 为 `["react"]`，不含旧细粒度标签；可用状态独立保留 |
| CodeBuddy 普通执行 | 在目标可用、审批方式受支持且未要求恢复时，普通 ReAct 调用不会因缺少恢复能力被默认拦截 |
| 明确要求恢复 | 接入实现不支持请求的恢复机制时拒绝，不能因公开声明 react 而放行 |
| provisioned 调用 | 观测到 Octo 定义和编译输入实际应用，不只验证生成的字符串 |
| preset 调用 | 确认调用的是选定 Agent；没有隐式创建或默认目标回退 |
| 无工作目录调用 | 执行合同可表达无用户工作目录，不伪造 cwd；工作目录无关的输入可以完成准备和映射 |
| OpenClaw 上下文 | 本次上下文按支持的参数传入；预置 Agent 的永久配置不因调用被重写 |
| 不支持的输入 | 图片、MCP、skills 或目录覆盖等必需项无法应用时，provider 启动前明确失败 |
| 重试与恢复 | 沿用已冻结来源和目标；保留既有上下文一致性、授权和 fencing 约束 |
| 云端边界 | 第三方服务不因接入或来源取值而被自动标记为 ReAct |

验收包含 TypeScript/Go 同源合同测试、Worker preflight、daemon/Adapter Host 拒绝路径，以及连接 im-test 的真实 Harness 执行。实际运行结果需记录所验证的 provider 版本；未验证的接入不能作为已实现事实。

## 8. 已采用的实现选择

1. `agent_source` 属于 Agent 稳定身份，创建后不可修改；每次 Run 冻结来源和目标。需要改变来源时创建新的 Agent。
2. Harness 当前公开能力仅为 `["react"]`。细粒度执行条件保留在单独的内部字段，不新增公开 delegation/handoff 能力。
3. `workspace.mode: "none"` 表示不需要 Octo 本机工作目录。准备回执中的工作目录和 provider 状态目录均为空；需要本机资源物化的请求必须明确失败。
4. OpenClaw 保留受控 runner，并按 `provisioned` 处理。`preset` 分支不套用 runner 隔离配置，不覆盖永久定义，不传入本机 cwd。
5. 直接修改现有建库 schema 和本地数据库字段，不新增 migration，不添加启动时旧合同升级逻辑。

## 9. 实现依据

- [Adapter SDK 元数据](../packages/octo-harness-adapter-sdk/src/index.ts)
- [Adapter Host](../packages/octo-harness-adapter-host/src/index.ts)
- [Protocol schema 源文件](../packages/octo-harness-protocol/schema/protocol.schema.json)
- [Protocol 校验](../packages/octo-harness-protocol/src/index.ts)
- [Runtime 注册、准入与 InvokeRequest 映射](../packages/octo-harness-daemon/src/agent-work-runtime.ts)
- [统一 ContextPipeline](../packages/octo-harness-daemon/src/context-pipeline.ts)
- [Context 准备产物](../packages/octo-harness-daemon/src/context-preparation.ts)
- [OpenClaw adapter](../packages/octo-harness-adapter-openclaw/src/index.ts)
- [既有 Context 管线基线](context-pipeline-baseline.md)
- [既有 OpenClaw 接入方案](15-openclaw-external-agent-binding-design.md)，本文以 preset 替代其中来源名称 external；网络桥和已有 Agent 绑定的区别仍需保留。

## 10. 当前分支验收结果

测试环境为 `https://im-test.deepminer.com.cn`，通过已登录的 Work App renderer 调用真实 Worker、Agent Access 和内置 Harness。

| 场景 | 实际结果 |
| --- | --- |
| CodeBuddy 2.161.4，`provisioned` | preflight 通过；读取 Context 中的独立验证标记，调用文件工具写入并读回；Run 完成，聊天结果可见 |
| OpenClaw 2026.9.4，`preset`，目标 `main` | preflight 通过；读取同一 Compiler 生成的上下文，调用已有 Agent 写入并读回文件；Run 完成，聊天结果可见 |
| OpenClaw 无本机工作目录 | 冻结计划来源为 `preset`、目标为 `main`；准备回执为 `workspace_mode: none`，`workspace_path` 与 `provider_state_dir` 均为空 |
| Runtime 上报 | 在线 Runtime 的 adapter 公开 capabilities 均为 `["react"]`；来源支持范围和细粒度执行特性分别上报 |
| 就绪检查 | CodeBuddy 与 OpenClaw 均返回 `can_run: true`；修正 Context 表与 Agent 表排序规则不一致导致的批量查询 500 |
| Work App 配置 | 实际页面显示预置来源、显式目标 ID 和无本机目录策略；未出现加载错误 |
| 管理页配置 | 创建、发布与 Context 保存真实成功；1440px 和 390px 宽度下无横向溢出，preset OpenClaw 目录输入禁用 |
| 拒绝路径 | 来源缺失或未知、adapter 来源不匹配、preset 目标缺失、无目录请求依赖本机资源等测试通过；显式要求恢复时仍拒绝不具备该特性的 CodeBuddy |

Harness 全量测试通过：830 项通过、4 项跳过。Worker 全量 Go 测试通过。管理页 12 项测试通过。本次客户端相关 46 项测试通过，feature kit 测试通过；Harness、Work App 和管理页构建通过。

Context 三张表在现有建表脚本中显式使用 `utf8mb4_unicode_ci`，当前开发库直接修正为相同规则，没有新增迁移。独立 MySQL 测试库以 `utf8mb4_0900_ai_ci` 为库默认规则执行新建库回归，实际验证 Agent、revision、Context 的就绪关联查询通过。

客户端全量测试仍有独立的 presentation v2 样例与当前 v3 实现不匹配的 5 项失败；不将相关测试报告为通过。另一次并行构建期间出现 protocol 产物暂时缺失，单独重跑本次相关测试通过。

真实 Run：CodeBuddy `arun_f09219fa25014b969312f6b4b943def9`，OpenClaw `arun_6f953ef43a57467d93cbde5561f88d7f`。受控 OpenClaw runner 的分支测试通过，本轮未重新进行其独立实机验收。云端 `ability_provider` 的执行实现不在本次 Harness 改造范围内。

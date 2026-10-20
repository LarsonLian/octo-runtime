---
type: Review
title: Context v3 过度设计逐项评估
description: 按实际消费者与责任归属区分确定精简项、遗留清理候选及必要协议约束。
tags: [context, protocol, architecture]
timestamp: 2026-10-16T00:00:00Z
---

# Context v3 过度设计逐项评估

状态：源码初评，未改协议。任务目标见[计划](brief.md)。覆盖 ContextEnvelope、12 个内置 item、配置分层、渲染及关联遗留类型；不把所有名字带 Context 的协议当作同一协议。仓外消费者未穷尽，仓内无调用不等于可以无影响删除。

## 判断依据

优先精简无实际消费者的字段、用文字标签假装授权、把业务操作规划塞进通用协议的结构，以及已退出执行路径的类型。有实际执行含义、权限边界或不同状态的字段，不能仅因复杂而删。业务材料附加信息可通过开放 extra 表达，不必都由通用协议固定建模。

## 确定移除

### C01：instructions.source

按用户要求完整移除，复用[已有指令任务](../unify-execution-and-simplify-instructions/brief.md)。entries 保持列表，每项只留 text。

证据：Schema、publicPayload() 要求 text/source；validateLayers() 用 agent_configuration 再做分层判断，但 Schema 自己说明 source 标签不证明可信性，真实授权仍在上游。模型指令拼接只读 text。该字段增加所有生产者的负担，没有承载可信身份。

删除需同步 Work App 的 imChannelBotConfig、AgentManagement mandatory 构造和对应测试，不能只改 Runtime。保留真实配置写入授权。旧配置、历史快照和版本协调见[旧数据处理](brief.md#旧数据与兼容处理)。

## 其他精简候选

| 编号与对象 | 源码证据 | 评估与建议 | 实施前核对 |
| --- | --- | --- | --- |
| C02：references 的 resolver=mcp、locator.server_ref/tool、params、authorization_ref | 校验器只允许 mcp，Schema 描述为认证 resolver plan 的操作；Host 只渲染 payload，无执行前预取 | 高优先级。当前 Agent 按描述自行取材，这套强制 MCP 操作结构仍带旧编排含义。建议采用业务 extra 或中性引用，不恢复 resolver 证明旧字段有用 | 实际生产者、模型取材说明和资源标识；授权仍由工具/服务端执行 |
| C03：inline 的 source、summary、resource_ref 专用字段 | inline 与 extra 均原样渲染；这些字段不参与 Host 授权或准备 | 中优先级。评估只保留 text、附加材料元数据改由 extra 表达的收益；来源和摘要仍可能有业务价值，不能因同名 source 自动删 | 文档选区等生产者与模型实际需要；不同于控制来源枚举 |
| C04：ContextSelectionEntry / ContextResourceEntry 重复定义 | Schema 的引用图无入边，内容与现用 InlineEntry / ReferenceEntry 重复，仍公开导出 | 高优先级。清理无必要的同义定义及生成类型，保留实际使用的一套 | 仓外 TypeScript import；没有 Schema 入边不等于没有类型消费者 |
| C05：ContextContinuityPayload、ContextSyncRequest/Result、ContextCommitResult 及关联 Channel 类型 | 不在信封的 12 个 item 中；保留 Schema、公开导出、部分校验和测试，检索未见当前 Runtime 业务执行路径消费者 | 高优先级。旧回填/游标提交与业务显式提供本轮 Context 的职责不一致，核对后清理整组遗留合同 | 关联定义图、导出、校验器、测试和仓外消费者；不能称其为每轮 v3 实际携带的字段 |
| C06：catalog.trustedOnly / schemaRef | persistent 有配置层消费者；仓内 trustedOnly 只有定义，schemaRef 只见 Schema 存在性测试消费 | 中优先级。删无用途元数据，保留必要类型识别和持久化分类，不扩成处理器注册表 | 公开依赖；删除标签不删除真实授权 |
| C07：runtime selection 的固定 strategy=preferred_failover | candidates 已表达候选模式，strategy 只有一个值，另有 failover/offline_behavior | 中优先级。固定 strategy 可能只是重复常量，交 routing 专项评估；其余两项有不同语义，不能一起删 | Worker/远端路由实际消费者及独立 routing 版本，本轮未完成服务端验证 |
| C08：mergeContext 对 references 合并/去重/排序 | mergeReferences 按 resource_ref 覆盖后排序；配置持久化分类禁止 references；Host 按本轮 items 渲染 | 中优先级。核对真实调用后退出无必要的通用业务合并；不能在执行层改写本轮材料 | 区分显式 defaults/mandatory 配置解析与禁止的跨 Event 自动补齐，不能直接删全部 mergeContext |
| C09：limits.enforcement 与 model_idle_policy | watchdog 仍消费：前者 observe 关闭整体计时，后者仅控制模型空闲；Schema 有兼容组合限制 | 中优先级。可重评退出全局 observe、统一细粒度限额；属于有实际行为的历史机制，不直接删 | 宿主依赖、退出策略、长任务与限额回归 |

C02–C09 仅是评估建议，尚未决定全部删除，不构成破坏性更新或改写已有数据的授权。

## 应保留的约束

| 对象 | 理由 |
| --- | --- |
| schema/items、namespace/name、数组顺序 | 区分执行、可信控制与业务材料，支持开放 extra，无需 persona 专用类型 |
| instructions.entries 列表 | 用户需要多条指令，保序拼接 text 足够 |
| adapter、actmode、approval_policy | 各有执行消费者，分别表达引擎、模式与审批 |
| model.selection/reasoning、use_provider_default | 模型与强度独立；显式 Provider 默认可覆盖 Agent 的具体设置，而省略可能继承配置，不能等同。是否压平嵌套可另评 |
| workspace.fixed/random/none | 通用调用方确有不同目录归属；IM 固定目录不能删除其他入口能力。Schema 的“按 AgentSession 首轮建立并复用”描述需再核对，不能用文案替 Host 承诺业务会话管理 |
| envs、mcp | 实际执行环境和工具连接，不能改成模型文本；凭据独立传递。列表与服务映射的形式不因视觉统一而修改 |
| limits 各阶段时限 | 首帧、模型空闲、工具空闲/总时长、整轮、取消宽限有不同含义 |
| runtime explicit/candidates、独立 routing 版本 | 指定目标和候选处理是不同业务意图，不能由本地 IM 场景删除远端合同 |
| defaults/mandatory | 可覆盖默认与强制约束不同；source 删除不取消真实写入授权 |
| guidance/payload | 业务方表达指引与数据，Host 固定渲染，无需业务处理器 |
| 数量、UTF-8 字节、JSON 深度、Unicode、信封内重复 key 校验 | 有界资源及确定性约束；与跨 Event 自动去重不同 |
| canonical/hash、准备回执的 Run/lease/fencing 绑定 | 一致性及执行身份约束，不授权缓存或补历史；不能因字段多而删权限检查 |

## 兼容处理建议

instructions.source 沿用已有单一新结构计划。用户进一步确认本次支持破坏性更新、不考虑历史兼容；删除旧结构解析，不做自动迁移。当前生产者、示例与消费者一起更新，活动配置由宿主按新合同重新提供，旧格式明确拒绝。

不得在校验器内先剥离 source 再放行，这会保留旧结构支持。当前授权不包含扫描和改写用户数据；历史不可变快照不改写。

其他候选的依赖不同，不能机械套用“不兼容”。尤其 routing、执行限额和公开类型必须核对实际消费者。

## 核对入口与验证边界

- [Schema](../../../packages/octo-runtime-protocol/schema/protocol.schema.json)、[校验与合并](../../../packages/octo-runtime-protocol/src/context.ts)、[配置分层](../../../packages/octo-runtime-protocol/src/context-configuration.ts)、[catalog](../../../packages/octo-runtime-protocol/src/context-catalog.ts)。
- [导出和旧校验器](../../../packages/octo-runtime-protocol/src/index.ts)、[指令拼接](../../../packages/octo-runtime-protocol/src/model-context.ts)、[Host renderer](../../../packages/octo-runtime-executor-core/src/model-input.ts)。
- [输入准备](../../../packages/octo-runtime-executor-core/src/invoke-input.ts)、[执行解析](../../../packages/octo-runtime-executor-core/src/context.ts)、[watchdog](../../../packages/octo-runtime-executor-core/src/watchdog.ts)。

本轮完成源码搜索、Schema 引用核对和文档评估，无线上请求、模型调用或产品测试。Worker 当前仓内搜索未见上述 source 等字段的活动 Go 实现，不据此声称服务端或部署已审查通过。没有读取实际 Runtime 配置或凭据。后续实施按线上测试环境及协议同步构建/重启要求验收。

---
type: Rule
title: 本轮模型输入与工作目录
description: Context v3 的业务归属、固定 renderer、控制通道和工作目录边界。
tags: ["context","model-input","workspace"]
timestamp: 2026-10-19T00:00:00Z
implementation_baseline: df63c8f
id: runtime-context-input
tier: repo
priority: 90
load_bearing: true
inject_when:
  paths: ["packages/octo-runtime-protocol/**","packages/octo-runtime-executor-core/**","packages/octo-runtime-adapter-*/**","packages/octo-runtime-extra-*/**","test/model-context*"]
  touches: ["context","model-input","workspace"]
source: self
supersedes: []
---

# Context v3 的 LLM 注入约束

本表定义哪些 Context 数据发送给模型，以及发送到哪个通道。Event 发起方构造数据，Host 使用 [model-input.ts](../../packages/octo-runtime-executor-core/src/model-input.ts) 中的 `renderModelContexts` 渲染；通用执行接入层不追加业务指引或读取引用正文，业务发起方可构造所属材料与获取指引。执行合同仍为 Run 7 / `octo.context-envelope/v3`。

| 内部类型                        | 发送给 LLM | 通道与消费规则                                                                |
| ------------------------------- | ---------- | ----------------------------------------------------------------------------- |
| `octo.execution/adapter`        | 否         | 选择 Adapter；不拼入提示词                                                    |
| `octo.execution/model`          | 否         | Provider 模型及推理强度参数；不拼入提示词                                     |
| `octo.execution/actmode`        | 否         | 显式行为模式 default / plan；adapter 映射原生参数，不拼入提示词                |
| `octo.execution/workspace`      | 否         | 工作目录准备与执行参数；不拼入提示词                                          |
| `octo.execution/limits`         | 否         | 执行预算和限额；不拼入提示词                                                  |
| `octo.execution/envs`           | 否         | Run 范围进程环境；值不得作为上下文提示词输出                                  |
| `octo.execution/mcp`            | 否         | 本轮 MCP 连接配置；不拼入提示词                                               |
| `octo.runtime/selection`        | 否         | Worker 路由选择；不拼入提示词                                                 |
| `octo.security/approval_policy` | 否         | 执行审批策略；提示词不授予权限                                                |
| `octo.content/inline`           | 是         | 普通模型输入中的 contexts 块，完整保留 guidance 与 payload                    |
| `octo.content/references`       | 是         | contexts 块只包含引用描述；不在执行前解引用或预取正文                         |
| `octo.control/instructions`     | 是         | 已验证来源的独立控制指令通道，不进入 contexts 块，也不作为普通 extra 指引升权 |
| `extra.<domain>/<name>`         | 是         | contexts 块完整输出 guidance 与 payload，无逐业务注册或字段投影               |
| 其他未知可选类型                | 否         | 保存并转发，忽略消费；需要注入的扩展使用 extra 命名空间                       |

item 内部仅输出换行纯文本 `指引: ...`、`数据: ...`。不添加 guidance/payload 子标签，不执行 XML 实体转义，不要求严格 XML。空列表或只有非注入类型时，renderer 返回空字符串。

renderer 只匹配 namespace/name 的白名单 pattern，保序输出全部数据。renderer 不调用信封校验器，不做业务字段、场景、材料可用性、处理器注册、预算估算或编译应用检查。协议接纳与执行配置校验属于各自边界，不能成为追加或改写模型上下文的理由。旧 Compiler/Pipeline、预取、摘要和投影配置已删除。

## 人格与 SOUL 指令

人格、persona、SOUL 是业务方选择的提示词内容，必须由业务方构造 octo.context-envelope/v3 后显式提交；IM 场景由 ChannelGateway 构造本轮业务 Context。业务方决定正文、顺序、是否发送、更新和重复时机。普通人格文本可放入 extra.im 等业务 item 的 guidance/payload，不增加人格专用字段、Compiler、renderer 分支或处理器。

底层框架不得自行读取 SOUL.md 或 persona 文件、扫描技能目录补人格、合并默认人格、从历史补齐或按 session 缓存/去重。renderer 仍只按现有白名单保序完整输出本轮 items；没有人格项时不补默认内容，业务显式重复时不得省略。reset 或恢复失败后的重发仍由业务方决定。

人格中的指令不自动取得控制权限。普通 extra 保持普通模型上下文语义；确需可信控制通道时，沿既有来源校验及 octo.control/instructions 合同处理，不能通过名称或自定义解析升权。完整责任与实施边界见[架构约束](architecture.md#人格与-soul-的注入归业务方)及[F17 评审](../tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf17-人格技能说明与自动指引)。

## 系统指令的会话时机与协议变更

`octo.control/instructions` 与普通本轮 Context 使用不同通道。业务方在调用时显式提供指令，Host 保留本轮快照；Provider Adapter 在新 Provider 会话初始化时使用系统指令，正常续聊不重复注入，不改成逐轮用户正文。普通业务 Context 不适用该省略规则。既有恢复策略退回新 Provider 会话时，使用本次调用明确提供的冻结指令，不从历史缓存补齐；系统指令变化由业务显式新建或 reset 后生效。

2026-10-17 已实施：`instructions.payload.entries` 仅包含 `{ text: string }` 的列表，原顺序 `entries.map(entry => entry.text).join("\n")`；删除 source 分类，不新增替代来源字段，不兼容旧条目。旧 source 字段按协议拒绝，身份、配置写入权限与 mandatory 强制约束继续保留。格式、空值与校验规则见[统一执行与指令计划](../tasks/unify-execution-and-simplify-instructions/brief.md#2-instructions-仅包含文本列表)；本轮运行验证边界见[实施记录](../journal/shared/2026-10-17-extra-initializer-delivery.md)。

## 资源地址与获取指引

文档、网盘文件和内部附件可将资源类型、来源、标识/地址及获取指引作为本轮业务 Context 提交；IM 使用 extra.im。发起方不必预先取得全部正文，Provider/Harness 内的 Agent 可按任务需要调用 octo-cli 或实际下载/读取工具。取材发生在正常工具循环，不是 Host、renderer 或 Adapter 的执行前预取。获取指引不升级为可信控制指令，CLI 凭据继续走独立执行环境，不进入模型上下文。

上下文描述的可访问资源与发起方显式提交的原生 inputs 是两类意图。首轮直接理解图片等原始内容沿现有多模态 inputs；资源引用沿 Context，不因扩展名为 PDF/音视频就要求 Adapter 新增原生附件输入，也不自动下载后转换。工具读取失败、缺失或不支持时返回真实结果，不把“地址已传递”报告为“内容已读取”。

本条为目标责任约束，不表示当前 Channel 已接入全部资源类型；文档/网盘/file 的获取方法、边界及实施状态见[资源 Context 决策](../journal/shared/2026-10-16-resource-context-access-decision.md)。

## Resume 与本轮上下文

2026-10-19 用户明确：ChannelGateway作为业务Event发起方，在模型前固定调用API准备规则及有界历史，并构造本轮快照；这不是模型按需调用octo-cli的工具流程。Issue #32的群/话题历史固定补取最多最近15条，不依赖模型关键词或工具选择。该准备只在业务入口实现，不下沉到Host、Adapter或renderer，也不扩大为附件/文档通用预下载。

**MUST**：发起方决定每轮模型上下文的内容、顺序和发送时机。selection、项目背景、任务状态、引用及 extra 均由业务方选择；即使页面存在选区或状态发生变化，框架也不要求发送。业务方可以首次提供必要背景、续聊无变化时传空、有变化时只发本轮需要的项，也可以显式重复。必要的 adapter 等执行配置仍按执行合同和 defaults/mandatory 规则校验，不进入 LLM 上下文块，不使业务项变成必填。

**MUST NOT**：执行接入层、daemon、Host 和 Adapter 不得按 sessionId、run 序号或 hash 缓存、补齐、合并、去重或省略模型上下文。Host 只渲染本轮快照；两个不同 Event 显式发送相同 item 时两轮均须注入。原 Event 的幂等重投仍复用原快照，不产生新的业务采集。

空模型上下文是有效输入，不表示缺失；执行配置可以同时存在，renderer 仍返回空字符串。sessionId 不保证 Provider 已保存背景或 resume 成功。reset、新建 Provider 会话或恢复失败后，由业务方重新提供所需背景；底层报告真实会话／恢复结果，不从历史 Event 自动补背景，也不得声称空输入已恢复旧背景。

输出模式不改变模型输入分类；native / canonical 的合同见 [输出协议](output-protocol.md)。

## 输入与工作目录

执行计划已删除 `required_capabilities`、`required_execution_features` 和 `provider_compatibility`。后两者没有实际执行消费者，不作为预留能力合同。模型侧需要标签时由业务方显式放入合适的业务 Context，是否发送及如何使用均由业务决定，底层不据此进行能力匹配。完整边界见 [Adapter 元数据](adapter-metadata.md)。

公共入口使用 [InvokeInput](invoke-input.md)：`inputs` 保留本轮 text/image，`contexts` 保存业务方提交的 Context v3。Core 只解析本轮必要执行默认值；Host 冻结内部请求后，`withModelContexts` 将本轮渲染文本放在主输入及调用方显式提供的恢复输入之前，不查询业务历史。

`prompt` 是展示描述，`modelInput` 和 `modelInputParts` 是实际输入，不能用展示摘要覆盖原始图片或恢复材料。可信 `controlInstructions` 使用独立通道，其 Provider 会话策略不适用于普通业务 Context。

工作目录由已解析的执行配置与 [execution-preparation.ts](../../packages/octo-runtime-executor-core/src/execution-preparation.ts) 准备。固定目录按合同检查，随机目录按执行配置创建；cwd 不是权限或操作系统隔离边界。OpenClaw 的 `workspace: false` 跳过目录准备，保留 Provider 原生工作区，Context 快照仍保持原值。

本段描述通用执行能力，不代表 IM 产品需要每会话目录。IM Agent 固定 workdir 的策略由 Channel 选择；新 session 或 reset 不改变目录。通用调用方仍可按自身业务显式选择合法目录，Host 不按 sessionId 推导路径。两层职责见[IM Agent 与 invoke 边界](../guides/im-agent-invocation-boundary.md)。

对 IM 后台配置对应的 Agent，目录来自 Agent 配置，其任务提交的 workdir 或 workspace Context 不得改变该目录。此约束由 IM 业务入口负责，不能转成通用 renderer 改写业务 Context，或全局禁止其他调用方显式配置工作目录。

## 当前核对入口

- [renderer](../../packages/octo-runtime-executor-core/src/model-input.ts)：只按白名单选择 item，数组保序，payload 对象键排序后输出 JSON，不投影或丢字段。
- [统一输入解析](../../packages/octo-runtime-executor-core/src/invoke-input.ts)：只解析执行配置，不推断历史背景。
- [model-context.test.js](../../test/model-context.test.js)：空、本轮变化及跨 Event 重复等输入行为。

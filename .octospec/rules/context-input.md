---
type: Rule
title: 本轮模型输入与工作目录
description: Context v3 的业务归属、固定 renderer、控制通道和工作目录边界。
tags: ["context","model-input","workspace"]
timestamp: 2026-10-15T00:00:00Z
implementation_baseline: df63c8f
id: runtime-context-input
tier: repo
priority: 90
load_bearing: true
inject_when:
  paths: ["packages/octo-runtime-protocol/**","packages/octo-runtime-core/**","packages/octo-runtime-adapter-*/**","packages/octo-runtime-extra-*/**","test/model-context*"]
  touches: ["context","model-input","workspace"]
source: self
supersedes: []
---

# Context v3 的 LLM 注入约束

本表定义哪些 Context 数据发送给模型，以及发送到哪个通道。Event 发起方构造数据，Host 使用 [model-input.ts](../../packages/octo-runtime-adapter-host/src/model-input.ts) 中的 `renderModelContexts` 渲染；接入层不追加业务指引或读取引用正文。执行合同仍为 Run 7 / `octo.context-envelope/v3`。

| 内部类型                        | 发送给 LLM | 通道与消费规则                                                                |
| ------------------------------- | ---------- | ----------------------------------------------------------------------------- |
| `octo.execution/adapter`        | 否         | 选择 Adapter；不拼入提示词                                                    |
| `octo.execution/model`          | 否         | Provider 模型及推理强度参数；不拼入提示词                                     |
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

## Resume 与本轮上下文

**MUST**：发起方决定每轮模型上下文的内容、顺序和发送时机。selection、项目背景、任务状态、引用及 extra 均由业务方选择；即使页面存在选区或状态发生变化，框架也不要求发送。业务方可以首次提供必要背景、续聊无变化时传空、有变化时只发本轮需要的项，也可以显式重复。必要的 adapter 等执行配置仍按执行合同和 defaults/mandatory 规则校验，不进入 LLM 上下文块，不使业务项变成必填。

**MUST NOT**：执行接入层、daemon、Host 和 Adapter 不得按 sessionId、run 序号或 hash 缓存、补齐、合并、去重或省略模型上下文。Host 只渲染本轮快照；两个不同 Event 显式发送相同 item 时两轮均须注入。原 Event 的幂等重投仍复用原快照，不产生新的业务采集。

空模型上下文是有效输入，不表示缺失；执行配置可以同时存在，renderer 仍返回空字符串。sessionId 不保证 Provider 已保存背景或 resume 成功。reset、新建 Provider 会话或恢复失败后，由业务方重新提供所需背景；底层报告真实会话／恢复结果，不从历史 Event 自动补背景，也不得声称空输入已恢复旧背景。

输出模式不改变模型输入分类；native / canonical 的合同见 [输出协议](output-protocol.md)。

## 输入与工作目录

执行计划已删除 `required_capabilities`、`required_execution_features` 和 `provider_compatibility`。后两者没有实际执行消费者，不作为预留能力合同。模型侧需要标签时由业务方显式放入合适的业务 Context，是否发送及如何使用均由业务决定，底层不据此进行能力匹配。完整边界见 [Adapter 元数据](adapter-metadata.md)。

公共入口使用 [InvokeInput](invoke-input.md)：`inputs` 保留本轮 text/image，`contexts` 保存业务方提交的 Context v3。Core 只解析本轮必要执行默认值；Host 冻结内部请求后，`withModelContexts` 将本轮渲染文本放在主输入及调用方显式提供的恢复输入之前，不查询业务历史。

`prompt` 是展示描述，`modelInput` 和 `modelInputParts` 是实际输入，不能用展示摘要覆盖原始图片或恢复材料。可信 `controlInstructions` 使用独立通道，其 Provider 会话策略不适用于普通业务 Context。

工作目录由已解析的执行配置与 [execution-preparation.ts](../../packages/octo-runtime-adapter-host/src/execution-preparation.ts) 准备。固定目录按合同检查，随机目录按执行配置创建；cwd 不是权限或操作系统隔离边界。OpenClaw 的 `workspace: false` 跳过目录准备，保留 Provider 原生工作区，Context 快照仍保持原值。

## 当前核对入口

- [renderer](../../packages/octo-runtime-adapter-host/src/model-input.ts)：只按白名单选择 item，数组保序，payload 对象键排序后输出 JSON，不投影或丢字段。
- [统一输入解析](../../packages/octo-runtime-core/src/invoke-input.ts)：只解析执行配置，不推断历史背景。
- [model-context.test.js](../../test/model-context.test.js)：空、本轮变化及跨 Event 重复等输入行为。

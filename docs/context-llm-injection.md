# Context v3 的 LLM 注入约束

本表定义哪些 Context 数据发送给模型，以及发送到哪个通道。Event 发起方构造数据，Host 使用 `renderModelContexts` 渲染；接入层不追加业务指引或读取引用正文。执行合同仍为 Run 7 / `octo.context-envelope/v3`。

| 内部类型                        | 发送给 LLM | 通道与消费规则                                                                |
| ------------------------------- | ---------- | ----------------------------------------------------------------------------- |
| `octo.execution/adapter`        | 否         | 选择 Adapter；不拼入提示词                                                    |
| `octo.execution/model`          | 否         | Provider 模型及推理强度参数；不拼入提示词                                     |
| `octo.execution/workspace`      | 否         | 工作目录准备与执行参数；不拼入提示词                                          |
| `octo.execution/limits`         | 否         | 执行预算和限额；不拼入提示词                                                  |
| `octo.execution/envs`           | 否         | Run 范围进程环境；值不得作为上下文提示词输出                                  |
| `octo.runtime/selection`        | 否         | Worker 路由选择；不拼入提示词                                                 |
| `octo.security/approval_policy` | 否         | 执行审批策略；提示词不授予权限                                                |
| `octo.content/inline`           | 是         | 普通模型输入中的 contexts 块，完整保留 guidance 与 payload                    |
| `octo.content/references`       | 是         | contexts 块只包含引用描述；不在执行前解引用或预取正文                         |
| `octo.control/instructions`     | 是         | 已验证来源的独立控制指令通道，不进入 contexts 块，也不作为普通 extra 指引升权 |
| `extra.<domain>/<name>`         | 是         | contexts 块完整输出 guidance 与 payload，无逐业务注册或字段投影               |
| 其他未知可选类型                | 否         | 保存并转发，忽略消费；需要注入的扩展使用 extra 命名空间                       |

item 内部仅输出换行纯文本 `指引: ...`、`数据: ...`。不添加 guidance/payload 子标签，不执行 XML 实体转义，不要求严格 XML。空列表或只有非注入类型时，renderer 返回空字符串。

renderer 只匹配 namespace/name 的白名单 pattern，保序输出全部数据。renderer 不调用信封校验器，不做业务字段、场景、材料可用性、处理器注册、预算估算或编译应用检查。协议接纳与执行配置校验属于各自边界，不能成为追加或改写模型上下文的理由。旧 Compiler/Pipeline、预取、摘要和投影配置已删除；不提供兼容转换或双路径。

## Resume 与本轮上下文

**MUST**：发起方决定每轮模型上下文的内容、顺序和发送时机。selection、项目背景、任务状态、引用及 extra 均由业务方选择；即使页面存在选区或状态发生变化，框架也不要求发送。业务方可以首次提供必要背景、续聊无变化时传空、有变化时只发本轮需要的项，也可以显式重复。必要的 adapter 等执行配置仍按执行合同和 defaults/mandatory 规则校验，不进入 LLM 上下文块，不使业务项变成必填。

**MUST NOT**：Worker、daemon、worker-access、Host 和 Adapter 不得按 sessionId、run 序号或 hash 缓存、补齐、合并、去重或省略模型上下文。Host 只渲染本轮快照；两个不同 Event 显式发送相同 item 时两轮均须注入。原 Event 的幂等重投仍复用原快照，不产生新的业务采集。

空模型上下文是有效输入，不表示缺失；执行配置可以同时存在，renderer 仍返回空字符串。sessionId 不保证 Provider 已保存背景或 resume 成功。reset、新建 Provider 会话或恢复失败后，由业务方重新提供所需背景；底层报告真实会话／恢复结果，不从历史 Event 自动补背景，也不得声称空输入已恢复旧背景。

总体方案、代码退出清单和验收见 [Event Context IPD-SE](../../docs/event-context-rendering-ipd-se.md)。本文约束模型输入，native/canonical 输出模式不影响注入分类。

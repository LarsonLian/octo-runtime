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

## Resume 与本轮上下文

发起方建议在首次运行提供必要背景；同一 Provider 会话成功续接后，未变化且仍有效的背景无需每轮重复发送。发起方本轮没有新上下文时提交空 items；当前选区、任务状态或对象发生变化时只提交本轮需要的项。必要重复或重新说明由发起方决定。

Host 不按 sessionId 自动丢弃 context，也不保存上下文去重缓存。sessionId 不能证明 Provider 已保存每项信息，更不能证明 resume 成功。reset、新建 Provider 会话或恢复失败需要重新提供必要背景；不得让空 Context 的执行声称已恢复旧背景。

总体方案、代码退出清单和验收见 [Event Context IPD-SE](../../docs/event-context-rendering-ipd-se.md)。本文约束模型输入，native/canonical 输出模式不影响注入分类。

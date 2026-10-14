# Prompt、上下文与 Workdir

当前合同为 Run `schema_version=7`、Context `octo.context-envelope/v3`。业务方准备本轮输入及上下文，Runtime 不查询 Agent Revision、不生成业务背景，也不从工作目录反推业务状态。

## 模型输入

- `prompt` 保存可展示的本轮请求；`modelInput` 和可选 `modelInputParts` 承载实际模型输入。
- 业务方在 `context.items` 中显式提供本轮背景、引用或 `extra.*`。Host 冻结请求后，使用 [model-input.ts](../packages/octo-runtime-adapter-host/src/model-input.ts) 保序渲染，再放到模型输入前面。
- 执行配置不进入模型文本；可信 `controlInstructions` 使用独立通道。控制指令的原生载体和新建／恢复会话行为由 Adapter 实现，不能把该行为扩展为普通业务 Context 的首轮缓存。
- 引用只渲染描述，不自动读取正文。业务方需要正文时，在发起请求前自行完成授权和取材。

业务方可以提交空模型上下文，也可以在两个不同 Event 中显式提交相同内容。Host 每轮都使用本轮快照，不根据 session、Run 序号或 hash 补齐、去重或省略。Provider 恢复失败时，业务方决定并提供新会话需要的背景。

请求形状见 [Protocol Schema](../packages/octo-runtime-protocol/schema/protocol.schema.json)，分类规则见 [LLM 注入约束](context-llm-injection.md)。

## 工作目录

工作目录来自已解析的执行配置，准备入口为 [execution-preparation.ts](../packages/octo-runtime-adapter-host/src/execution-preparation.ts)。工作目录只是执行位置，不是权限或隔离边界；sandbox、宿主账户及审批仍按各自合同执行。

OpenClaw 声明 `metadata.workspace: false`，保留目标 Agent 的原生工作区，忽略 Harness 工作目录；不为它创建随机目录或传递 `cwd`。详见 [OpenClaw 连接合同](15-openclaw-external-agent-binding-design.md)。

Runtime 不在工作目录保存业务 Run 历史。完整事件、聊天历史和 Provider 会话绑定由消费应用保存，见 [纯执行实体](15-stateless-executor-design.md)。

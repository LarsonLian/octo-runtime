# Context v3 可选扩展

> 2026-10-13 全局 Context 约束：每轮模型上下文由业务发起方决定，selection 等业务项可不发送；可传空、只传当轮需要的项或显式重复。必要的 adapter 等执行配置独立校验且不注入 LLM。底层只转发并渲染本轮快照，不按 sessionId 缓存、补齐、合并、去重或省略；reset、新建 Provider 会话或 resume 失败后，由业务方重新提供必要背景。详见 [Event Context IPD-SE 0.3](../../docs/event-context-rendering-ipd-se.md)。本文原有 Compiler/Pipeline、材料预取、场景自动追加与此约束冲突的内容仅保留历史背景；旧链路退出尚未完成。

> 2026-10-13：本文记录当前字段投影实现。后续设计按 [Event Context IPD-SE 0.2](../../docs/event-context-rendering-ipd-se.md) 收敛：合法 `extra.*` 由 Host 完整渲染，退出 Worker 字段投影及扩展编译快照。新方案尚未实施，不能把该目标视为当前 API 已支持。

Context 保持 `octo.context-envelope/v3` 的 `schema + items`，Run 保持 `schema_version=7`。协议允许结构合法的未知 `namespace/name`；未知 item 计入数量、字节预算、canonical hash，并在中转时完整保留。已登记类型继续执行自己的 payload 校验。

Octo 的固定类型目录负责标品处理、持久化及 mandatory 约束。消费阶段使用 `findContextTypeDefinition` 查询可选处理能力；没有定义时跳过该阶段。显式要求标品定义的接口 `contextTypeDefinition` 仍会拒绝未知类型。未知类型不能直接保存为 defaults 或 mandatory。

外部材料由 Worker 的可信 `context_extensions` 配置按租户及完整类型键解析。Worker 把配置版本、ignored 原因或选定字段的 JSON 文本固定到 `ResolvedExecutionPlan.context_extensions`。Harness 校验快照完整对应信封中的非标品 item，只把 material 结果编译为不可信来源材料。ignored 原始 payload 不进入模型。配置不能接管 `octo` 或 `octo.*`。

材料编译和 compiled hash 包含处理快照。公开投影只显示类型、配置版本和处理状态，不显示正文；准备回执不代表模型已完成业务操作。

`ContextProviderRegistry` 是宿主可注入的采集注册器。Provider 用 `id/version/capture(scope, signal)` 提供信封，无须增加 Octo scenario。capture 固定当前 Provider 集合及身份 generation，检查取消和作用域变化，丢弃过期异步结果。多个 inline 贡献合并；其他同类型重复贡献必须由 Provider 先汇总，超预算则拒绝。

首版只实现按字段配置的材料模式。Worker 启动时加载配置，更新规则需重启；外部 handler、完整 JSON Schema、外部 defaults 持久化及管理 API 尚未实现。具体配置例子见 Worker 的 `docs/context-extensions.md`。

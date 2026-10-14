# @mininglamp-oss/octo-runtime-core

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../docs/context-llm-injection.md) 与 [IPD-SE](../../../docs/event-context-rendering-ipd-se.md)。Host 仅按白名单 pattern 保序拼接，不做业务检查或编译。

本包只提供执行配置解析：`resolveLocalContext` 和 `localRuntimeLimits`。业务发起方提供本轮 Context；配置 defaults 只参与执行配置解析，不补齐模型上下文。

本包不注册业务 Agent，不保存 Session、Run 或事件，不调度执行，不提供 SQLite 或内存领域数据库。Provider 执行、取消与有限事件回放由 adapter-host 的 Host 服务承担。详见 [纯执行实体方案](../../docs/15-stateless-executor-design.md)。

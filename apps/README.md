# 可执行入口与责任边界

现行设计见 [Runtime 本地存在与按需在线合同](../.octospec/rules/runtime-lifecycle.md)。HostApp 决定携带和启用哪些包；本地 Runtime 身份与云端登记独立。

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../.octospec/rules/context-input.md) 与 [IPD-SE 0.3](../.octospec/rules/context-input.md)；执行侧旧 Compiler/Pipeline 已移除。

| 入口 | 负责 | 实现依赖 |
|---|---|---|
| [cli](cli/README.md) | 运维、Home/profile、原生服务与诊断 | cross-service、daemon |
| [daemon](daemon/README.md) | 配置、进程启动、信号转发 | daemon 与共享 Host |

apps 只保留 CLI 与 daemon。daemon 直接解析 `@mininglamp-oss/octo-runtime-adapter-host/runner` 并启动独立子进程，通过 stdio RPC 调用共享 Host；SDK 使用同一个 runner。Host 的独立进程边界不要求独立 app 包，详见 [AdapterHost](../packages/octo-runtime-adapter-host/README.md)。

外部业务接入由 packages 中的 Extra 提供，所有执行复用共享 Host。`octo-runtime` 及其子命令保持原有用法。

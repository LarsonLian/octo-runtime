# @mininglamp-oss/octo-runtime-adapter-mcode

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../docs/context-llm-injection.md) 与 [IPD-SE](../../../docs/event-context-rendering-ipd-se.md)。Host 仅按白名单 pattern 保序拼接，不做业务检查或编译。

MiniMax Code ACP adapter，adapter type 为 `mcode`。每次调用启动 `mcode acp`，通过通用 ACP adapter 完成 session 创建/恢复、prompt 流、model step 重建和 canonical event 转换。

## 模型配置与环境变量

MiniMax Code 自行管理模型，不在 `session/new`/`session/load` 响应中发布 per-session 选模选项。因此 adapter 不发送 `session/set_model`，模型由 MCode 自身配置决定（可用 `MULTICA_MCODE_PATH` 之类的运行环境变量指定二进制路径，选模仍归 MCode）。若 Revision 显式配置了 `execution_profile.agent_config.model`，通用 ACP 逻辑会尝试选模；由于 MCode 不发布选项，会在发送 prompt 前失败，不会静默退回。生产使用时建议不为 `mcode` 配置 model，交由 MCode 自管。

## 会话恢复

MiniMax Code 当前版本 advertises `loadSession: false`。当某次 run 无法 `session/load` 已保存的 session（返回空结果）时，adapter 通过 `emptyLoadResultMeansMissing` 判定为会话缺失并回退到新建 session（`resumeOutcome: "fresh_fallback"`），run 仍可正常执行。

## 使用

```bash
pnpm cli adapter probe mcode
```

`probe` 只检查可执行文件；登录态、模型凭据和实际推理网络仍需在 Runtime 上配置。

## 模块责任边界

- 负责：将 mcode 原生执行协议映射为 InvokeRequest / CanonicalEvent，由 adapter-host 调用。
- 不负责：Worker/IM WS、聊天历史、Event/AgentRun 登记。
- 协作边界：见 [根架构与包边界](../../README.md#模块责任边界)。所有执行来源共用 adapter-host IPC；模块按职责提供协议、执行或宿主能力。

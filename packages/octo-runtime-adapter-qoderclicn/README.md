# @mininglamp-oss/octo-runtime-adapter-qoderclicn

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../.octospec/rules/context-input.md) 与 [IPD-SE](../../.octospec/rules/context-input.md)。Host 仅按白名单 pattern 保序拼接，不做业务检查或编译。

Qoder CN CLI ACP adapter，adapter type 为 `qoderclicn`。每次调用启动 `qoderclicn --yolo --acp`，通过通用 ACP adapter 完成 session 创建/恢复、模型选择、prompt 流、model step 重建和 canonical event 转换。

这是 Qoder 的中国区（CN）发行版，行为与 Qoder CLI 一致，但以独立的 `qoderclicn` 二进制分发，并注册为独立 adapter type，方便 Runtime 显式选择 CN 版本。

## 启动参数

`--acp` 让 Qoder CN 讲 Agent Client Protocol（JSON-RPC 2.0 over stdio）；`--yolo` 选择 ACP “bypass permissions” 模式，使无人值守的工具调用不会卡在交互式审批。

> **安全要求**：`--yolo` 是危险权限模式（bypass permissions）。按 `CONTRIBUTING.md` 安全约定，此类模式只能在 Runtime 提供的外部容器/VM 沙箱内运行；workdir 只是 `cwd`，不是安全边界。

## 模型配置

Qoder CN 在 `session/new`/`session/load` 响应中发布可选模型。若 Revision 配置了 `execution_profile.agent_config.model`，adapter 通过标准 ACP 选模设置该 session，值必须是返回的模型 id。未配置时沿用当前默认模型；请求模型不在发布列表时会在发送 prompt 前失败，不静默退回。

## 会话恢复

Qoder CN advertises 会话加载能力，已保存的 provider session 通过 `session/load` 恢复，不走新建回退。

## 使用

```bash
pnpm cli adapter probe qoderclicn
```

`probe` 只检查可执行文件；登录态、模型凭据和实际推理网络仍需在 Runtime 上配置。

## 模块责任边界

- 负责：将 qoderclicn 原生执行协议映射为 InvokeRequest / CanonicalEvent，由 adapter-host 调用。
- 不负责：Worker/IM WS、聊天历史、Event/AgentRun 登记。
- 协作边界：见 [根架构与包边界](../../README.md#模块责任边界)。所有执行来源共用 adapter-host IPC；模块按职责提供协议、执行或宿主能力。

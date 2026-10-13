# @mininglamp-oss/octo-harness-adapter-qodercli

Qoder CLI ACP adapter，adapter type 为 `qodercli`。每次调用启动 `qodercli --yolo --acp`，通过通用 ACP adapter 完成 session 创建/恢复、模型选择、prompt 流、model step 重建和 canonical event 转换。

## 启动参数

`--acp` 让 Qoder 讲 Agent Client Protocol（JSON-RPC 2.0 over stdio）；`--yolo` 选择 Qoder 的 ACP “bypass permissions” 模式，使无人值守的工具调用不会卡在交互式审批。

> **安全要求**：`--yolo` 是危险权限模式（bypass permissions）。按 `CONTRIBUTING.md` 安全约定，此类模式只能在 Runtime 提供的外部容器/VM 沙箱内运行；workdir 只是 `cwd`，不是安全边界。

## 模型配置

Qoder 在 `session/new`/`session/load` 响应中发布可选模型。若 Revision 配置了 `execution_profile.agent_config.model`，adapter 通过标准 ACP 选模（`session/set_config_option` 或 `session/set_model`）设置该 session，值必须是 Qoder 返回的模型 id，不是展示名称。未配置时沿用 Qoder 当前默认模型。若请求模型不在发布列表，adapter 会在发送 prompt 前失败，不会静默退回默认模型。

## 会话恢复

Qoder advertises 会话加载能力，已保存的 provider session 通过 `session/load` 恢复，不走新建回退。

## 使用

```bash
pnpm cli adapter probe qodercli
```

`probe` 只检查可执行文件；登录态、模型凭据和实际推理网络仍需在 Runtime 上配置。

## 模块责任边界

- 负责：将 qodercli 原生执行协议映射为 InvokeRequest / CanonicalEvent，由 adapter-host 调用。
- 不负责：Worker/IM WS、聊天历史、Event/AgentRun 登记。
- 协作边界：见 [根架构与包边界](../../README.md#模块责任边界)。所有执行来源共用 adapter-host IPC；模块按职责提供协议、执行或宿主能力。

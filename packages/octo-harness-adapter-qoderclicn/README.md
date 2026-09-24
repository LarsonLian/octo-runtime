# @mininglamp-oss/octo-harness-adapter-qoderclicn

Qoder CN CLI ACP adapter，adapter type 为 `qoderclicn`。每次调用启动 `qoderclicn --yolo --acp`，通过通用 ACP adapter 完成 session 创建/恢复、模型选择、prompt 流、model step 重建和 canonical event 转换。

这是 Qoder 的中国区（CN）发行版，行为与 Qoder CLI 一致，但以独立的 `qoderclicn` 二进制分发，并注册为独立 adapter type，方便 Runtime 显式选择 CN 版本。

## 启动参数

`--acp` 让 Qoder CN 讲 Agent Client Protocol（JSON-RPC 2.0 over stdio）；`--yolo` 选择 ACP “bypass permissions” 模式，使无人值守的工具调用不会卡在交互式审批。

## 模型配置

Qoder CN 在 `session/new`/`session/load` 响应中发布可选模型。若 Revision 配置了 `execution_profile.agent_config.model`，adapter 通过标准 ACP 选模设置该 session，值必须是返回的模型 id。未配置时沿用当前默认模型；请求模型不在发布列表时会在发送 prompt 前失败，不静默退回。

## 会话恢复

Qoder CN advertises 会话加载能力，已保存的 provider session 通过 `session/load` 恢复，不走新建回退。

## 使用

```bash
pnpm cli adapter probe qoderclicn
```

`probe` 只检查可执行文件；登录态、模型凭据和实际推理网络仍需在 Runtime 上配置。

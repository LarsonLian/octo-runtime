# OpenClaw 已有 Agent 接入

OpenClaw 接入只负责验证已有 Agent、执行会话、回传事件和处理 interaction。Agent 安装、插件管理、记忆和 workspace 由本地用户或 OpenClaw 管理。

## 本地绑定

使用 `adapter connect openclaw` 保存已有 Gateway、Agent ID 和 credential。具体命令见[Adapter README](../packages/octo-harness-adapter-openclaw/README.md)。CLI 验证 Gateway protocol v4 及公开执行能力，并通过 `agents.list` 检查 Agent 存在；缺失时失败。

连接流程不调用 `agents.create` 或 `config.patch`，不修改 Skill、MCP、memory、persona、tool denylist、workspace 或全局 `agents.defaults.skipBootstrap`。旧托管 runner 的 setup、configure/init 和自动迁移均已删除。

## 执行行为

每次 invocation 建立独立已认证 WebSocket，创建唯一 session key，订阅该 session 的消息流，再发送本次输入。Adapter 不通过 `sessions.create.cwd` 或 `agent.cwd` 覆盖原生 workspace。平台普通材料进入本次输入；OKF 记忆由 Loop 作为业务材料提供。

Adapter 将真实 session、model-step、reasoning、message、tool、usage 和 lifecycle 事件归一化。未知 stream 忽略；runId 不匹配的事件丢弃，重复 seq 不再应用。生命周期终态由 `agent.wait` 确认，取消通过 `sessions.abort`。凭据和私有认证字段不进入展示数据。

## 验证

合同测试覆盖已有 Agent 检查、连接凭据隔离、session 事件、取消、断线对账和审批。测试必须确认执行与连接均不调用 Agent 创建或 Gateway 配置写入 RPC。旧版本曾验证的托管 runner 隔离行为已经删除，不作为当前运行要求。

真实 Gateway/model 验收与线上 Worker 发起的联合验收分别记录。仅通过 fake Gateway 合同测试不能声明线上链路已通过。

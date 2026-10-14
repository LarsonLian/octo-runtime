# IM 平台连接器（不是 MCP）

本目录的 `connector` 专指 **IM 平台连接器**：连接 Octo、企业微信等 IM 平台，适配鉴权、心跳、消息、回复和平台呈现。

它与 MCP 连接器不是同一概念，不管理 MCP Server、不发现/注册工具，也不承担 MCP 授权。需要 MCP 的模型执行仍使用既有执行协议。

`octo/` 保存 WuKong、Octo REST、群规则、历史、卡片模板及卡片动作；`wecom/` 保存企业微信 JSON WebSocket 与流式回复。`registry.ts` 只按 IM `type` 装配平台实现。会话、队列、执行、标准事件投影与投递调度在包内公共领域目录中复用。

详见 [多平台方案](../../docs/multi-platform-design.md)。

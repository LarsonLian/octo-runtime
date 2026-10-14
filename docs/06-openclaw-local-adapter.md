# OpenClaw Runtime 接入

OpenClaw 与其他 Provider 共用本地 Runtime 身份、选择和执行入口。SDK 本地初始化后即可按宿主配置探测 OpenClaw，或指定 OpenClaw Home／Gateway URL 与 token；不要求先注册 Worker。连接信息保存在对应 Runtime Home 的 Runtime profile 下；云端上报仅在显式启用注册时发生。统一语义见 [Runtime 合同](runtime-local-and-online-contract.md)。

Context 的 `octo.execution/adapter` 使用 `type: "openclaw"` 与 `provider_agent_id` 选择本轮目标。连接配置不保存目标 Agent，不覆盖 Context。Adapter 验证已有 Agent、执行会话、回传事件并处理 interaction；安装、插件、记忆和原生 workspace 仍由宿主或 OpenClaw 管理。

概念、配置优先级、凭据归属与操作命令见 [Runtime 与 OpenClaw 连接统一合同](15-openclaw-external-agent-binding-design.md)。

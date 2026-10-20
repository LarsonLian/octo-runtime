# Packages 与责任边界

现行设计见 [Runtime 本地存在与按需在线合同](../.octospec/rules/runtime-lifecycle.md)。HostApp 决定携带和启用哪些包；本地 Runtime 身份与云端登记独立。

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../.octospec/rules/context-input.md) 与 [IPD-SE](../.octospec/rules/context-input.md)。Host 仅按白名单 pattern 保序拼接，不做业务检查或编译。

接入模块通过统一 Host IPC 执行。Worker 接入、IM 接入和本地助理共享 adapter-host；IM 已实现最小私聊单轮链路。Daemon 负责装配，接入包不创建第二套 Host。

| 模块                                                                           | 职责                                                                                                                                                                 |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [octo-runtime-acp-client](octo-runtime-acp-client/README.md)                   | 实现 ACP 传输、请求关联与协议交互                                                                                                                                    |
| [octo-runtime-adapter-acp](octo-runtime-adapter-acp/README.md)                 | provider 协议适配，由 adapter-host 调用                                                                                                                              |
| [octo-runtime-adapter-antigravity](octo-runtime-adapter-antigravity/README.md) | provider 协议适配，由 adapter-host 调用                                                                                                                              |
| [octo-runtime-adapter-claude-code](octo-runtime-adapter-claude-code/README.md) | provider 协议适配，由 adapter-host 调用                                                                                                                              |
| [octo-runtime-adapter-codebuddy](octo-runtime-adapter-codebuddy/README.md)     | provider 协议适配，由 adapter-host 调用                                                                                                                              |
| [octo-runtime-adapter-codex](octo-runtime-adapter-codex/README.md)             | provider 协议适配，由 adapter-host 调用                                                                                                                              |
| [octo-runtime-adapter-hermes](octo-runtime-adapter-hermes/README.md)           | provider 协议适配，由 adapter-host 调用                                                                                                                              |
| [octo-runtime-adapter-host](octo-runtime-adapter-host/README.md)               | 通过 AdapterHostRpc 统一 invoke、cancel、probe 和交互响应，管理适配器与事件生命周期                                                                                  |
| [octo-runtime-adapter-kimi-code](octo-runtime-adapter-kimi-code/README.md)     | provider 协议适配，由 adapter-host 调用                                                                                                                              |
| [octo-runtime-adapter-mcode](octo-runtime-adapter-mcode/README.md)             | provider 协议适配，由 adapter-host 调用                                                                                                                              |
| [octo-runtime-adapter-openclaw](octo-runtime-adapter-openclaw/README.md)       | provider 协议适配，由 adapter-host 调用                                                                                                                              |
| [octo-runtime-adapter-opencode](octo-runtime-adapter-opencode/README.md)       | provider 协议适配，由 adapter-host 调用                                                                                                                              |
| [octo-runtime-adapter-qodercli](octo-runtime-adapter-qodercli/README.md)       | provider 协议适配，由 adapter-host 调用                                                                                                                              |
| [octo-runtime-adapter-qoderclicn](octo-runtime-adapter-qoderclicn/README.md)   | provider 协议适配，由 adapter-host 调用                                                                                                                              |
| [octo-runtime-adapter-sdk](octo-runtime-adapter-sdk/README.md)                 | 提供适配器共用的进程、流解析和事件辅助工具                                                                                                                           |
| [octo-runtime-adapter-zcode-gui](octo-runtime-adapter-zcode-gui/README.md)     | provider 协议适配，由 adapter-host 调用                                                                                                                              |
| [octo-runtime-executor-core](octo-runtime-executor-core/README.md) | AgentExecutor：唯一执行实现、输入准备、取消、交互及清理；不含 IPC、回放或业务历史 |
| [octo-runtime-cross-service](octo-runtime-cross-service/README.md)             | 管理 launchd/systemd/Windows 用户服务的生命周期                                                                                                                      |
| [octo-runtime-daemon](octo-runtime-daemon/README.md) | Node/Electron 本地生命周期、账户隔离与 IPC；管理共享 Host，按宿主声明加载可选 Extra。生产依赖不包含 worker-access 或 channel-gateway。 |
| [octo-runtime-extra-channel-gateway](octo-runtime-extra-channel-gateway/README.md)                   | 读取本地 bf_token、连接 IM 专用 WS、管理私聊会话与 /reset，经共享 AdapterHostRpc 执行后回发最终文本。                                                                |
| [octo-runtime-protocol](octo-runtime-protocol/README.md)                       | 定义和校验统一执行、事件与 Context 合同                                                                                                                              |
| [octo-runtime-extra-channel-wecom](octo-runtime-extra-channel-wecom/README.md) | 企业微信专用 WebSocket、原生 stream 回复与独立生命周期；不依赖 gateway。 |

worker-access 预研已移到生态目录外的独立仓库 `../../octo-runtime-worker-access`，只作备份，不参与 workspace、构建、打包或宿主加载。

## Provider Agent 配置

业务发起方负责 Agent 定义、defaults／mandatory 和本轮执行配置，决定 adapter、workdir、model 与 provider-specific options。Worker 不管理 Agent registry 或配置；Runtime CLI／SDK 不在注册、启动或 invoke 时创建 Agent。

常见配置字段：

| 字段                  | 使用者                          | 说明                |
| --------------------- | ------------------------------- | ------------------- |
| `workdir`             | Codex/Claude/CodeBuddy/OpenCode | provider cwd        |
| `model`               | provider adapter                | provider model      |
| `permissionMode`      | Claude/CodeBuddy                | provider 权限模式   |
| `sandbox`             | Codex                           | Codex sandbox       |
| `providerAgent`       | OpenClaw                        | OpenClaw agent slug |
| `thinking` / `effort` | 支持的 provider                 | 推理选项            |

Provider 执行返回真实 `session.update`。本地调用由宿主业务保存 opaque provider session；远程调用按 Worker 独立执行合同保存和下发。Adapter 翻译原生 resume 参数，不保证恢复必然成功，也不补齐模型上下文。

## 安全

Workdir 不是安全边界。危险 bypass/auto-approve 选项必须结合容器、VM 或等价隔离。Runtime 凭据由宿主从受保护配置读取并注入接入模块。Adapter manifest 不得包含业务凭证、IM bot token 或 Worker token。

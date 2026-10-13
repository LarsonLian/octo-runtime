# Packages 与责任边界

接入模块通过统一 Host IPC 执行。Worker 接入、IM 接入和本地助理共享 adapter-host；IM 已实现最小私聊单轮链路。Daemon 负责装配，接入包不创建第二套 Host。

| 模块 | 职责 |
|---|---|
| [octo-harness-acp-client](octo-harness-acp-client/README.md) | 实现 ACP 传输、请求关联与协议交互 |
| [octo-harness-adapter-acp](octo-harness-adapter-acp/README.md) | provider 协议适配，由 adapter-host 调用 |
| [octo-harness-adapter-antigravity](octo-harness-adapter-antigravity/README.md) | provider 协议适配，由 adapter-host 调用 |
| [octo-harness-adapter-claude-code](octo-harness-adapter-claude-code/README.md) | provider 协议适配，由 adapter-host 调用 |
| [octo-harness-adapter-codebuddy](octo-harness-adapter-codebuddy/README.md) | provider 协议适配，由 adapter-host 调用 |
| [octo-harness-adapter-codex](octo-harness-adapter-codex/README.md) | provider 协议适配，由 adapter-host 调用 |
| [octo-harness-adapter-hermes](octo-harness-adapter-hermes/README.md) | provider 协议适配，由 adapter-host 调用 |
| [octo-harness-adapter-host](octo-harness-adapter-host/README.md) | 通过 AdapterHostRpc 统一 invoke、cancel、probe 和交互响应，管理适配器与事件生命周期 |
| [octo-harness-adapter-icons](octo-harness-adapter-icons/README.md) | 提供适配器品牌图标资源 |
| [octo-harness-adapter-kimi-code](octo-harness-adapter-kimi-code/README.md) | provider 协议适配，由 adapter-host 调用 |
| [octo-harness-adapter-mcode](octo-harness-adapter-mcode/README.md) | provider 协议适配，由 adapter-host 调用 |
| [octo-harness-adapter-openclaw](octo-harness-adapter-openclaw/README.md) | provider 协议适配，由 adapter-host 调用 |
| [octo-harness-adapter-opencode](octo-harness-adapter-opencode/README.md) | provider 协议适配，由 adapter-host 调用 |
| [octo-harness-adapter-qodercli](octo-harness-adapter-qodercli/README.md) | provider 协议适配，由 adapter-host 调用 |
| [octo-harness-adapter-qoderclicn](octo-harness-adapter-qoderclicn/README.md) | provider 协议适配，由 adapter-host 调用 |
| [octo-harness-adapter-sdk](octo-harness-adapter-sdk/README.md) | 提供适配器共用的进程、流解析和事件辅助工具 |
| [octo-harness-adapter-zcode-gui](octo-harness-adapter-zcode-gui/README.md) | provider 协议适配，由 adapter-host 调用 |
| [octo-harness-context-builder](octo-harness-context-builder/README.md) | 根入口提供浏览器可用的场景上下文构造。context-preparation、run-context、context-compaction、input-images 和两种 material-compaction 子入口提供 Node 侧执行准备工具。 |
| [octo-harness-core](octo-harness-core/README.md) | 维护本地执行状态和引擎，经注入的 adapter 调用能力执行 |
| [octo-harness-cross-service](octo-harness-cross-service/README.md) | 管理 launchd/systemd/Windows 用户服务的生命周期 |
| [octo-harness-daemon](octo-harness-daemon/README.md) | 管理共享 adapter-host 进程及重启、本地 UDS/Pipe 控制接口、reference Run 调度、诊断与观测。通过注入同一个 AdapterHostRpc 装配 Worker 接入模块。 |
| [octo-harness-embedded](octo-harness-embedded/README.md) | 为 Node/Electron 宿主提供运行时生命周期、账户隔离和本地 IPC 接入 |
| [octo-harness-im](octo-harness-im/README.md) | 读取本地 bf_token、连接 IM 专用 WS、管理私聊会话与 /reset，经共享 AdapterHostRpc 执行后回发最终文本。 |
| [octo-harness-observability](octo-harness-observability/README.md) | 提供日志、追踪、脱敏与诊断基础能力 |
| [octo-harness-protocol](octo-harness-protocol/README.md) | 定义和校验统一执行、事件与 Context 合同 |
| [octo-harness-worker-access](octo-harness-worker-access/README.md) | 管理 Worker 注册、profile、WS 建连重连、远端命令与准备回执、执行 envelope 转换和事件回传。构造 AgentWorkRuntime / AgentWorkSupervisor 时由宿主传入 AdapterHostRpc。 |

## Provider Agent 配置

Agent revision 的 execution profile 决定 adapter、workdir、model 与 provider-specific options。创建/发布 Agent 由 Agent Worker 完成，不由 Harness CLI 完成。

常见配置字段：

| 字段 | 使用者 | 说明 |
|---|---|---|
| `workdir` | Codex/Claude/CodeBuddy/OpenCode | provider cwd |
| `model` | provider adapter | provider model |
| `permissionMode` | Claude/CodeBuddy | provider 权限模式 |
| `sandbox` | Codex | Codex sandbox |
| `providerAgent` | OpenClaw | OpenClaw agent slug |
| `thinking` / `effort` | 支持的 provider | 推理选项 |

Provider 首次调用发出 `session.update`。Worker 把 opaque provider session 保存到 AgentSession，后续 run.start 再下发。Adapter 只读取 `providerSession.sessionId` 并翻译为原生 resume 参数。

## 安全

Workdir 不是安全边界。危险 bypass/auto-approve 选项必须结合容器、VM 或等价隔离。Runtime 凭据由宿主从受保护配置读取并注入接入模块。Adapter manifest 不得包含业务凭证、IM bot token 或 Worker token。

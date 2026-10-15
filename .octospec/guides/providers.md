---
type: Guide
title: Provider 实现与验证入口
description: 按当前适配器声明说明传输、模式及验证边界。
tags: []
timestamp: 2026-10-15T00:00:00Z
implementation_baseline: df63c8f
---

# Provider Adapters

可加载实现以 [adapters.json](../../config/adapters.json) 为准，完整包入口见 [Packages Guide](../../packages/README.md)。下面描述当前传输和执行边界，具体认证及原生参数见各包 README。

## 传输与输出

| Adapter | 原生传输 | Host 输出模式 |
| --- | --- | --- |
| [Codex](../../packages/octo-runtime-adapter-codex/README.md) | app-server JSON-RPC stdio | native / canonical |
| [Claude Code](../../packages/octo-runtime-adapter-claude-code/README.md) | stream-json stdio | native / canonical |
| [CodeBuddy](../../packages/octo-runtime-adapter-codebuddy/README.md) | ACP stdio | canonical |
| [OpenCode](../../packages/octo-runtime-adapter-opencode/README.md) | full_access 使用 JSON CLI，ask 使用 ACP | canonical |
| [OpenClaw](../../packages/octo-runtime-adapter-openclaw/README.md) | Gateway WebSocket RPC 与事件 | canonical |
| [ZCode](../../packages/octo-runtime-adapter-zcode-gui/README.md) | 私有 NDJSON RPC stdio | canonical |
| [Antigravity](../../packages/octo-runtime-adapter-antigravity/README.md) | agy stream-json stdio | canonical |
| Hermes、Kimi Code、MCode、Qoder CLI、Qoder CN | ACP stdio | canonical |

Host 公共 `invoke` 默认 native。使用 canonical-only Adapter，或需要统一事件的业务方，必须显式指定 `{ protocolMode: "canonical" }`。模式不支持时在接纳前拒绝，不从 canonical 重建原生输出，见 [输出模式合同](../rules/output-protocol.md)。当前仓库不再提供 Worker 远程接入包。

`capabilities` 描述公开行为，`executionFeatures` 描述实际执行特性，`agentSources` 声明来源支持；可用状态由真实 probe 单独判断。详见 [来源与能力](../rules/adapter-capabilities.md)。Host 当前没有公开 fork 流程，不因 Provider 原生具有 fork 就声明端到端支持。

## 会话与权限

Codex 使用 `thread/resume`，Claude Code 使用 `--resume`，ACP 使用 Provider 支持的 `session/load`；恢复和 fresh fallback 取决于对应实现。调用方保存 opaque Provider session；存在 session ID 不保证恢复成功。新会话所需背景由调用方提供。

OpenClaw 为每次调用建立隔离 session，验证本轮 `provider_agent_id` 指向已有 Agent，通过 `sessions.messages.subscribe` 取流、`agent` 执行、`agent.wait` 确认终态、`sessions.abort` 取消。它不创建 Agent、不验证旧 runner 隔离配置、不改写原生工作区，也不传 Harness cwd。见 [连接合同](../rules/openclaw.md)。

权限使用本轮 `approvalMode`。Adapter 按支持范围映射 ask／assisted／full_access，无法表达时明确拒绝。Claude Code 和 CodeBuddy 只在 full_access 下使用 bypass；OpenCode 只在 full_access 下使用自动执行 CLI，ask 使用交互 ACP。不能把某个引擎的默认权限写成整个 Runtime 的默认权限。

## Canonical 事件

Adapter 将原生消息、工具、活动、用量、交互和终态转换为规范事件，保留实际身份与公开性。Codex commentary 与 final、ACP thought 与正文等分别映射到对应通道；未知工具中间状态不能被当作终态。Host 等待执行器清理后发布终态，不把命令 ACK 或订阅断开解释成执行完成。

native 模式保留 Provider 原始消息结构，由独立 Host control 表达执行状态。业务消费者不能直接用原生 payload 中的 `completed` 字样推断 Host 已完成。

## 配置与验证

`agentConfig.effort` 使用统一 `low / medium / high / xhigh`；缺省时保留 Provider 默认值。原生转换、降档及未应用提示见 [思考强度映射](../rules/reasoning.md)。MCP 通过 [本轮 Context 执行配置](../rules/mcp.md) 提供，不触发插件安装。

新增 Adapter 按 [开发指南](adapter-authoring.md) 补齐声明、原生事件与成功／失败／取消／恢复测试。代码支持和 fixture 通过不能替代真实 Provider 与 im-test 验收；过往实测范围见 [历史验证摘要](../journal/shared/provider-validation-history.md)；这些记录不是当前版本的新验收。

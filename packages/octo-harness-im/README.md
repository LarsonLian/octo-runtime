# IM 接入

## 责任边界

- 负责：从本地文件读取 bf_token，通过 IM Server 注册接口取得 WS 凭据；独立连接 IM 二进制 WS，接收私聊文本，构造固定 Context v3 和发起人元数据，通过 Daemon 注入的 AdapterHostRpc 执行，并一次回发最终文本。
- 不负责：启动 provider、创建第二个 Host/Daemon/CLI、云端 Event/Run 登记、Worker SSE、聊天 SQLite、群聊、GROUP.md、卡片或 typing。
- 本地执行不依赖旧 octo-agent-access 或 Worker。远端模型和 IM Server 仍需网络；WS 发送回执只代表服务端接纳，不代表客户端已经显示。

## 配置与启动

使用已有 CLI：`octo-harness --home <绝对路径> daemon run`。Daemon 读取 `<home>/im.json`；文件不存在时不启动 IM 接入。配置格式为 `{ "bots": [ ... ] }`，每个 bot 包含：

| 字段 | 含义 |
|---|---|
| id / botId / spaceId | 本地配置名、注册返回的机器人身份、租户身份 |
| apiUrl | IM API 根地址，例如 `https://im-test.deepminer.com.cn/api` |
| tokenFile | bf_token 文件路径，相对路径以 Home 为基准；POSIX 权限必须为 0600 |
| adapterType / workdir | adapter 名称和固定绝对工作目录 |
| context | 有效的 `octo.context-envelope/v3` 固定上下文 |
| model | 可选模型 |
| allowedSenderIds | 可选私聊发送者白名单；默认只接受注册返回的 owner |

每个 Home 最多 16 个 bot，同一服务的 botId 不能重复。各 bot 独立持有 WS、加密状态和会话映射，共享一个 adapter-host。不同 Home 不会自动合并；同一 bot 应由一个 Home 管理。

## 会话与限制

会话按 space、bot 和私聊对方隔离。`/session` 返回本地 session、generation 和最近 runId；`/reset` 在前序轮次完成后清除 provider 会话句柄、增加 generation，保留本地 sessionId。每个会话串行执行，普通轮次采用 `full_access`，执行上限 120 秒。

只保存有界内存中的会话句柄与入站去重记录，不保存聊天历史。重启后会话映射和去重窗口消失，不保证进程崩溃后的补发。最终文本最大 256 KiB；每个 bot 最多 128 个会话、64 个排队轮次。发送失败不代表执行可以安全重跑。

## 验证

`test/im-runtime.test.js` 覆盖注册、加密 WS、最终文本、会话复用、/session 和 /reset。2026-10-13 使用 im-test 的 Codex 测试机器人完成真实入站 → 本地 Codex → WS 回发；服务端历史确认两次最终答复。客户端显示和真实 /reset 交互尚未取得用户确认。

整体架构见 [根 README](../../README.md)。

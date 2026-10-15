# Octo Runtime CLI

## Extra plugins

`octo-runtime extraset <name>` reads a complete `{module, enabled?, config}` JSON object from stdin and replaces `HOME/default/extra/<name>/config.json` with mode 0600. It does not echo configuration or start the plugin. Restart the daemon to apply; `extra status|load|unload [name]` controls the declarations already read at startup.

The native HTTP/Bearer/SSE demonstration and full here-string examples are documented in [Extra plugins](../../.octospec/rules/extras.md). This is a generic configuration command, not a platform-specific setup flow.

现行设计见 [Runtime 本地存在与按需在线合同](../../.octospec/rules/runtime-lifecycle.md)。当前 CLI／原生服务仍保留云端 profile 引导与连接恢复，IM 配置入口已提供；最终在线开关尚待实施；客户 SDK 无需使用该 CLI。

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../.octospec/rules/context-input.md) 与 [IPD-SE 0.3](../../.octospec/rules/context-input.md)；执行侧旧 Compiler/Pipeline 已移除。

`octo-runtime` 面向无显示器的独立设备，负责启动 daemon 和共享 AdapterHost、配置多个 IM 接入，以及 Runtime 登录、服务生命周期和本地诊断。IM 配置用法见接入指南第 1.4 节。运行时要求 Node.js 24 或更高版本。

## 最终架构期望

2026-10-14 目标：先初始化并保存稳定的本地 Runtime ID，本地 Host IPC 就绪即为启动成功。注册由独立显式命令触发，不再是安装、启动或本地调用的前置条件，不创建默认 Agent。

CLI 提供 `channel configure`，从 stdin 读取一个 Bot JSON 对象，支持 here-document、here-string 和文件重定向。输入与 SDK 的 `ImBotConfig` 一致，IM 字段位于顶层，执行设置位于 `adapter`。`im.json` 保存为顶层数组；按平台、地址和 `bot_id` 更新单项，其他项保留。无独立 `id` 或 `space_id`，`enabled` 默认 `true`。Octo 租户从 octo-auth 的 `verify-bot` 认证结果取得。

本地引擎要求绝对路径 `adapter.workdir`。OpenClaw 不填写 `workdir`，`provider_agent_id` 默认 `main`；CLI 在 daemon 启动时读取本机 `openclaw.json` 的 Gateway 连接和 token。保存后使用 `daemon run` 前台启动，或 `daemon restart` 重启已安装并启用的系统服务。完整示例见 [接入指南](../../INTEGRATION.md#14-通过-cli-配置和管理多个-im-接入)。

设备／Runtime 注册使用独立命令，候选名称为 `octo-runtime devices register`，最终命令名与参数待冻结。配置频道不隐式注册设备，注册也不隐式启用所有连接。

设备在线选择保存本地，与 IM 频道启用独立；关闭时不加载设备连接并停止已有连接，本地 Host 继续运行。access 目前仅确认设备与 Runtime 注册职责，设备 WS／heartbeat 等对外链路待最终架构评审。验收分别记录本地就绪、注册 ACK、设备连接和频道连接。详见 [IPD-SE 基线](../../.octospec/rules/runtime-lifecycle.md)。

下文保留现有 CLI 的命令及文件入口说明。`login`、profile 自动发现和 `--wait-online` 尚需按上述目标改造；它们不能作为最终默认在线行为或纯本地启动合同。目标命令尚未全部交付。

## 全局参数

```text
--home PATH       覆盖 Runtime Home
--profile NAME    选择 profile，默认 default
```

macOS/Linux 默认 Home 是 `~/.octo-runtime`，Windows 是 `%LOCALAPPDATA%\OctoRuntime`。一个 Home 运行一个 daemon，并可包含多个 profile；每个 profile 独立保存 Runtime 身份、credential、WSS 与内存重放窗口。不同 OS 用户或互不信任的身份仍必须使用不同 OS account。

## 本地初始化

```bash
octo-runtime login
```

`login` 只初始化本地 Home 配置和 machine identity，不连接 Worker。原 enrollment 和 Worker 远程连接实现已迁到生态目录外的独立预研备份仓库。原 `--server-url`、`--enroll-token-stdin` 和 `--wait-online` 不再执行云端接入。

服务安装、启动与连接启用由宿主分别明确选择。现有更新恢复入口 `login --prepare-update`、`login --recover-update --start` 只用于本地服务生命周期。

## Daemon 生命周期

```bash
octo-runtime daemon install
octo-runtime daemon uninstall
octo-runtime daemon run
octo-runtime daemon start
octo-runtime daemon stop
octo-runtime daemon restart
octo-runtime daemon status
```

- `install` 把已完成 `login` 的 Runtime Home 注册为当前用户的原生服务，也可重复执行以修复 definition drift；默认启用登录自启但不启动，可用 `--no-autostart` 禁用自启。
- `uninstall` 直接停止并从原生服务管理器中真实删除服务：systemd user unit、macOS LaunchAgent 或 Windows 当前用户计划任务。身份、credential、本地状态和日志全部保留。
- `run` 在前台运行并响应 `SIGINT`/`SIGTERM`；PID 文件保证一个 Home 只有一个 daemon。
- `run` 默认在 stderr 输出彩色、脱敏的生命周期状态；`--quiet` 关闭终端输出，`--verbose`
  显示详细 operational records 和完整启动异常堆栈。RPC/provider 敏感内容仍只进入受保护日志。
- `start` 只启动已安装且已启用的原生用户服务，不创建 detached 子进程；`--wait-online` 会继续等待所选 `runtime_id` 的 WSS Online。
- `stop`、`restart` 直接操作原生服务，不等待活动 Run 完成。
- 生命周期命令作用于整个 Home。daemon 自动发现 Home 下包含合法 `config.json` 的 profile，并由一个 supervisor 管理各自的 credential、`runtime_id`、WSS 和内存重放窗口。
- 锁屏不会结束已登录用户的服务；注销会结束 macOS LaunchAgent 和默认 Windows 用户任务。Linux 注销后是否继续取决于管理员是否启用 linger。

## 显式 IM 文件接入

CLI 读取 `<home>/im.json` 的顶层数组，文件不存在时接入列表为空。只接受当前格式，不转换旧 `bots` 包装或旧字段。`channel configure` 校验后原子保存，POSIX 文件权限为 `0600`；输出只包含保存结果，不回显凭据。最多 16 项，同一平台身份不得重复。读取时不补写默认值，也不创建工作目录。

| 字段 | 含义 |
| --- | --- |
| `type` / `bot_id` / `enabled` | 平台、Bot 身份、启用状态（默认 true） |
| `bot_name` | Octo 本地展示名称，可选，默认使用 `bot_id`；不参与身份匹配 |
| `api_url` / `bf_token` 或 `bf_token_file` | Octo API 与凭据；凭据文件相对路径按 Home 解析 |
| `app_secret` 或 `app_secret_file` / `ws_url` | 企业微信凭据与可选网关 |
| `adapter` | `adapter_type`（默认 codex）、绝对 `workdir`、可选 `model` / `effort`；OpenClaw 使用 `provider_agent_id`（默认 main），不填 workdir |
| `context` | 可选 Context v3，由 IM 业务入口逐轮提交 |
| `approval_mode` / `run_timeout_ms` | 可选执行设置，默认 full_access / 120000 毫秒 |
| `allowed_sender_ids` / `group_ids` | 可选发送者与 Octo 群准入 |
| `group_rules` / `history_limit` / `cards` / `typing` | Octo 的规则、历史与展示设置 |

文件变更在 daemon 重启后加载。SDK 宿主自行提供配置和凭据，可使用 [动态接入接口](../../packages/octo-runtime-extra-channel-gateway/README.md#动态接入本地设备新增-agent)；共享 daemon 不扫描配置文件。

Octo 插件只校验已识别字段，不拒绝未知扩展字段；CLI 原样保存扩展数据。`name` 不作为 `bot_name` 的别名。`channel configure` 按平台、API 地址和 `bot_id` 新增或替换一项，其他机器人保留；同一项按完整对象替换，不做字段合并。通用 `extraset` 则替换指定插件的整份 JSON 声明，框架不理解插件 `config` 的业务字段；配置多个机器人时，一次提交完整 `config.bots` 数组。

## Doctor

```bash
octo-runtime doctor
octo-runtime --home /path/to/work-home --profile work doctor
```

`doctor` 是服务诊断入口，当前检查 Node.js 版本、profile/identity/credential 文件、POSIX credential mode、service program 绝对路径、原生 manager、definition drift、本地 IPC 和所选 Runtime 的云端连接。所有检查通过返回 0，否则返回 1，并为失败项输出 remediation。Host 调试日志用于看执行数据，不替代 doctor。

## 本地数据与 Run 诊断

```bash
octo-runtime status
octo-runtime adapter list
octo-runtime adapter probe codex
octo-runtime agent-session list
octo-runtime agent-session get <agent-session-id>
octo-runtime agent-run list
octo-runtime agent-run get <agent-run-id>
octo-runtime agent-run wait <agent-run-id>
octo-runtime agent-run cancel <agent-run-id>
```

这些命令通过 Home 级 Unix socket 或 Windows named pipe 读取本地状态。Worker 仅管理对应远程执行，源事件窗口不能当作完整历史；本地会话及完整 trajectory 由宿主业务存储负责。

调试时在启动前设置 `OCTO_RUNTIME_DEBUG=1`，Host 日志直接追加到 `$OCTO_RUNTIME_HOME/logs/adapter-host.log`。默认关闭；该开关通过进程环境传递到 daemon 和 Host。

## Playboard: standalone local trials

For development, testing, and integration debugging only. Do not integrate production
applications by spawning this CLI subcommand.

`playboard` reads **one complete JSON object** from stdin, starts its own adapter-host,
streams one `HostFrame` per stdout line (NDJSON), then exits and closes the Host.
It uses real adapters/providers without login, enrollment, Access, Worker, a daemon,
or a Runtime database. Provider installation and authentication are still required.
It does not install providers. Provider tools can act on your workspace.

For Bash/zsh, a complete example is:

```bash
octo-runtime playboard <<< '{
  "inputs": [{ "type": "text", "text": "Reply with OK. Do not use tools." }],
  "contexts": { "schema": "octo.context-envelope/v3", "items": [] },
  "sessionId": "playboard-demo",
  "protocol_mode": "canonical"
}'
```

Or save the same JSON and run `octo-runtime playboard < request.json`.
Input can span lines; stdout is NDJSON, not a JSON array. Diagnostics go to stderr.
No extra summary is appended to stdout. Help is available with `playboard --help`.

| JSON field | Contract |
| --- | --- |
| `inputs` | Required, non-empty `ModelInputPart[]`. Text is `{ "type": "text", "text": "..." }`; images use the existing validated base64/mimeType/byteSize/sha256 contract. |
| `contexts` | Required Context v3 envelope. Empty `items` is valid. Business context retains its submitted order and is rendered by the shared Host. |
| `sessionId` | Optional local caller session identity, otherwise generated. Reusing it does not restore history or a provider session. Each invocation gets fresh run/invocation IDs. |
| `protocol_mode` | `native` (default) or `canonical`. Native preserves provider payloads; unsupported modes fail without fallback. |
| `agentSource` | `provisioned` (default), or `preset` (default for OpenClaw), subject to adapter support. |
| `providerSession` | Optional opaque provider binding, including a non-empty `sessionId`. Pass back the real binding returned in Host events to request continuation. |
| `continuityMode` | Defaults to `continue` when `providerSession` is supplied, otherwise `fresh`. Explicit `continue` requires the binding; `fresh` forbids it. The provider determines whether resume succeeds. |

Local execution defaults are codex, the current directory (for provisioned execution),
`approval_policy.mode=ask`, and `limits.run_timeout_ms=120000`. Override execution
settings in `contexts.items`, for example:

```json
[
  { "namespace": "octo.execution", "name": "adapter", "payload": { "type": "claude-code" } },
  { "namespace": "octo.execution", "name": "workspace", "payload": { "mode": "fixed", "path": "/absolute/workspace" } },
  { "namespace": "octo.execution", "name": "model", "payload": { "selection": { "id": "your-provider-model" } } },
  { "namespace": "extra.playboard", "name": "background", "payload": { "text": "Only this turn's background." } }
]
```

OpenClaw uses an existing local agent and its provider-owned workspace by default:

```bash
node apps/cli/dist/index.js playboard <<< '{"inputs":[{"type":"text","text":"回复 OK"}],"contexts":{"schema":"octo.context-envelope/v3","items":[{"namespace":"octo.execution","name":"adapter","payload":{"type":"openclaw"}}]},"protocol_mode":"canonical"}'
```

For this CLI shorthand, an omitted `provider_agent_id` resolves to `main` before
Context validation. To select another existing agent, add `"provider_agent_id":"researcher"`
to the adapter payload. Explicit invalid IDs are rejected; a missing agent is never
created or replaced with another target. The adapter reads the selected Runtime profile’s connection source and verifies the target exists. Other protocol entry points still require
an explicit OpenClaw `provider_agent_id`.

Workspace selection uses the local resolver: provisioned runs require a fixed absolute
path; random workspace allocation is not provided. Model, reasoning, limits, envs,
and MCP configuration use the existing execution protocol. Control instructions use
the existing independent control channel. Execution configuration is never injected
as business context. Empty or repeated business items are not supplemented from any
previous invocation. Provide needed background again after reset or failed resume.

This is a one-shot trial: stdin EOF finishes reading the request, **not execution**.
If the provider requests approval or user input, its interaction frame is emitted,
then the CLI cancels and fails with `PLAYBOARD_INTERACTION_REQUIRED`; it never silently
approves or waits for a reply on closed stdin. Ctrl+C cancels and cleans up the Host.
Exit codes: `0` completed, `1` validation/startup/provider/interaction failure,
`130` cancelled or interrupted, `143` SIGTERM. An interrupted or rejected stream may
end without a terminal frame; consumers must also check the process exit code/stderr.
Requests are limited to 16 MiB, including embedded images.

`--manifest /absolute/adapters.json` selects an explicit adapter manifest for adapter
experiments or fake-provider tests; the default is the bundled `config/adapters.json`,
resolved relative to the installed CLI. Playboard does not read daemon profiles or
provider bindings from Runtime Home. It tests execution, not remote scheduling,
leases, persistence, or production end-to-end delivery.

## 状态目录

Runtime 不创建 SQLite 数据库，不归档 Run 请求或事件。进程重启后旧回放窗口失效；业务历史和恢复由调用方管理。

```text
<home>/config.json
<home>/machine.json                         # shared installation grouping label
<home>/octo-daemon.pid
<home>/sockets/octo-runtime-daemon.sock       # POSIX
<home>/<profile>/config.json
<home>/<profile>/identity/runtime.json
<home>/<profile>/credentials/runtime-token.json
<home>/logs/
```

One Runtime Home runs one daemon and adapter-host. Each discovered profile has its own server-assigned `runtime_id`, credential, and WSS connection, while sharing the Home-global `machine_id` and provider concurrency limits. Profile names allow 1-128 characters. The identity file must include the exact bound profile; identities without it are unsupported and require fresh enrollment after the Worker database reset.

`octo-daemon.pid` contains only a process PID. Profile identity is stored in `identity/runtime.json`; POSIX credentials use mode `0600`. Existing `system_id`/`device_id` identities are unsupported after this breaking reset: freshly enroll profiles against the recreated Worker database. Program files do not live inside Runtime Home.

除帮助文本外，普通命令的正常结果输出 JSON。错误输出到 stderr 并返回非零。`--help` 和 `login --help` 不依赖网络或已运行 daemon。

## 模块责任边界

- 负责：提供现有 octo-runtime 命令、Home/profile 配置、服务管理和本地诊断。
- 不负责：实现 Worker/IM 协议、直接启动每个 provider。
- 协作边界：见 [根架构与包边界](../../README.md#模块责任边界)。所有执行来源共用 adapter-host IPC；模块按职责提供协议、执行或宿主能力。

### 已撤回的注册 Agent 行为

原 `--agent-identity`／`--agent-name` 及注册时创建默认 `main` Agent 的行为退出，不属于最终 CLI 合同。Runtime 注册只登记设备与 Runtime；助手、分身及其 defaults／mandatory 由业务方管理。CLI 参数、profile 字段和重连请求中的旧 Agent 创建信息须同步删除，不提供旧路径兼容。OpenClaw 的 `provider_agent_id` 仍是本轮执行选择，与本次删除 Worker Agent registry 不同。


## Runtime 的 OpenClaw 连接

`login` 注册 Runtime 后保存并探测其本地 OpenClaw 连接。缺失或不可用的 Gateway 不阻止 Runtime 注册。连接存于 `<home>/<profile>/adapters/openclaw/connection.json`；凭据存于该 profile 的 `credentials` 目录。

```sh
octo-runtime --home /path/to/harness --profile work adapter connect openclaw --openclaw-home /path/to/openclaw
octo-runtime --home /path/to/harness --profile work adapter connect openclaw --gateway-url ws://127.0.0.1:18789 --token-stdin
octo-runtime --home /path/to/harness --profile work adapter probe openclaw
```

显式参数优先；无参数时复用已保存连接，首次初始化读取 `OPENCLAW_HOME` 或成对的 `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN`，否则使用 `~/.openclaw`。`login` 也接受 `--openclaw-home` / `--gateway-url`；enrollment token 与 Gateway token 不可同时占用 stdin。

`playboard` 支持 `--home` 和 `--profile`，无须登录即可使用该 profile 的连接来源。完整概念与执行合同见 [统一合同](../../.octospec/rules/openclaw.md)。

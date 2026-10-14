# Octo Harness CLI

现行设计见 [Runtime 本地存在与按需在线合同](../../docs/runtime-local-and-online-contract.md)。当前 CLI／原生服务仍保留云端 profile 引导与连接恢复，最终频道配置和在线开关尚待实施；客户 SDK 无需使用该 CLI。

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../docs/context-llm-injection.md) 与 [IPD-SE 0.3](../../../docs/event-context-rendering-ipd-se.md)；旧链路退出仍待完成。

`octo-harness` 是当前 OS 用户的 Runtime 登录、服务生命周期和本地诊断入口。运行时要求 Node.js 24 或更高版本。

## 最终架构期望

2026-10-14 目标：先初始化并保存稳定的本地 Runtime ID，本地 Host IPC 就绪即为启动成功。注册由独立显式命令触发，不再是安装、启动或本地调用的前置条件，不创建默认 Agent。

CLI 需要提供 IM 频道配置入口，保存 channel 类型、目录／执行 Context、Bot 凭据引用及启用状态。daemon 根据配置选择模块、token 和目标服务，仅启动已启用的长连接。设备／Runtime 注册使用独立命令，候选名称为 `octo-harness devices register`，最终命令名与参数待冻结。配置频道不隐式注册设备，注册也不隐式启用所有连接。

设备在线选择保存本地，与 IM 频道启用独立；关闭时不加载设备连接并停止已有连接，本地 Host 继续运行。access 目前仅确认设备与 Runtime 注册职责，设备 WS／heartbeat 等对外链路待最终架构评审。验收分别记录本地就绪、注册 ACK、设备连接和频道连接。详见 [IPD-SE 基线](../../../docs/local-runtime-ipc-on-demand-ipd-se.md)。

下文保留现有 CLI 的命令及文件入口说明。`login`、profile 自动发现和 `--wait-online` 尚需按上述目标改造；它们不能作为最终默认在线行为或纯本地启动合同。目标命令尚未全部交付。

## 全局参数

```text
--home PATH       覆盖 Harness Home
--profile NAME    选择 profile，默认 default
```

macOS/Linux 默认 Home 是 `~/.octo-harness`，Windows 是 `%LOCALAPPDATA%\OctoHarness`。一个 Home 运行一个 daemon，并可包含多个 profile；每个 profile 独立保存 Runtime 身份、credential、WSS 与内存重放窗口。不同 OS 用户或互不信任的身份仍必须使用不同 OS account。

## 现有登录入口（待改造）

首次登录从 stdin 读取一次性 `octo_enroll_` grant：

```bash
printf '%s\n' 'octo_enroll_...' | octo-harness login \
  --server-url https://im-test.deepminer.com.cn \
  --enroll-token-stdin
```

`login` 只完成 Runtime 身份闭环：

1. Persist one Home-global `machine_id` in `machine.json`, shared by every profile.
2. Exchange an enrollment grant at `/v1/runtimes/enroll` with the selected `profile` for a server-assigned `runtime_id` and directly bound `octo_runtime_` credential; refresh capabilities at `/v1/runtime/register` with that same profile and save the returned identity.

`machine_id` is an untrusted installation grouping label, not a hardware proof or a unique Runtime key. New profiles get distinct Runtime IDs even within the same Space. Renewal uses the saved Runtime ID and credential, and cannot change the trusted server or Worker endpoint.

enrollment grant 和设备 credential 都不会进入 CLI argv、service definition 或输出。重复执行同一 profile 的 `login` 只对账身份，不重新 enrollment。服务安装与启动必须显式使用 `daemon install` 和 `daemon start`。常用开关：

```text
--agent-work-url URL    覆盖 Worker API 根地址；默认使用 SERVER_URL/agentworker/api
--runtime-name NAME     首次注册显示名
--channel stable|beta   记录安装 channel，默认 stable
```

安装器还专用以下更新模式，不建议人工日常调用：

```bash
octo-harness login --prepare-update --wait-drained
octo-harness login --recover-update --start
```

## Daemon 生命周期

```bash
octo-harness daemon install
octo-harness daemon uninstall
octo-harness daemon run
octo-harness daemon start
octo-harness daemon stop
octo-harness daemon restart
octo-harness daemon status
```

- `install` 把已完成 `login` 的 Harness Home 注册为当前用户的原生服务，也可重复执行以修复 definition drift；默认启用登录自启但不启动，可用 `--no-autostart` 禁用自启。
- `uninstall` 同步停止并从原生服务管理器中真实删除服务：systemd user unit、macOS LaunchAgent 或 Windows 当前用户计划任务。默认先 drain，`--force` 跳过 drain；身份、credential、本地状态和日志全部保留。
- `run` 在前台运行并响应 `SIGINT`/`SIGTERM`；PID 文件保证一个 Home 只有一个 daemon。
- `run` 默认在 stderr 输出彩色、脱敏的生命周期状态；`--quiet` 关闭终端输出，`--verbose`
  显示详细 operational records 和完整启动异常堆栈。RPC/provider 敏感内容仍只进入受保护日志。
- `start` 只启动已安装且已启用的原生用户服务，不创建 detached 子进程；`--wait-online` 会继续等待所选 `runtime_id` 的 WSS Online。
- `stop`、`restart` 先通过 IPC 关闭新 Run 准入并等待活动 Run 完成，再操作原生服务；`--force` 跳过 drain。
- 生命周期命令作用于整个 Home。daemon 自动发现 Home 下包含合法 `config.json` 的 profile，并由一个 supervisor 管理各自的 credential、`runtime_id`、WSS 和内存重放窗口。
- 锁屏不会结束已登录用户的服务；注销会结束 macOS LaunchAgent 和默认 Windows 用户任务。Linux 注销后是否继续取决于管理员是否启用 linger。

## 显式 IM 文件接入

本节仅描述 CLI 选择的文件入口。客户 App 经 packages/SDK 显式提供配置与凭据，自己决定 Home、账号目录及启停；共享 Daemon 不自动读取 `im.json`。IM 平台连接器不是 MCP 连接器，职责见 [Channel IM README](../../packages/octo-harness-channel-im/README.md)。

```bash
octo-harness --home <绝对路径> daemon run
```

CLI 在进程入口调用文件适配，读取 `<home>/im.json`；不存在时接入列表为空。格式为 `{ "bots": [ ... ] }`，`type` 必须显式为 octo 或 wecom，不兼容无 type 的旧配置。

| 字段                                        | CLI 文件入口含义                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| id / type / enabled                         | 稳定接入身份、IM 平台；缺省 enabled:false，不连接。                                                    |
| apiUrl / botId / spaceId                    | Octo API、Bot 与 Space 身份；企业微信不填写。                                                          |
| token 或 tokenFile                          | Octo bf_token 或凭据文件；相对文件路径由此显式文件入口按 Home 解析。                                   |
| appBot / appSecret 或 appSecretFile / wsUrl | 企业微信 Bot 与凭据；详情见多平台设计。                                                                |
| adapterType / workdir                       | 执行 defaults，与 IM 平台 type 独立；缺失时文件 loader 补默认值并原子写回。                            |
| context                                     | 可选 Context v3，执行 adapter、模型/思考强度、workspace、approval 按协议解析；材料由每轮 IM 流程构造。 |
| model / approvalMode / runTimeoutMs         | 可选执行 defaults；IM 构造 Context 时 approval 缺省 full_access，runTimeout 缺省 120 秒。              |
| allowedSenderIds / groupIds                 | 可选发送者与 Octo 父群准入；Octo 群/话题还要求真实 @Bot。                                              |
| groupRules / historyLimit / cards / typing  | Octo 规则/有限历史与呈现开关；其他平台不使用。                                                         |

文件 loader 对缺省 adapter 写入 codex（Context 已指定 adapter 时用该值）；缺省 workdir 使用 Context 固定目录，否则分配 Home 内的独立工作区，仅显式启用的自动分配目录才创建。该目录和补配置行为属于选用文件入口的宿主，不是公共 Runtime 的目录约定。凭据文件及包含明文凭据的配置文件须为 POSIX 0600；空凭据、空文件或不存在的凭据文件表示等待就绪。

当前 CLI 启动时发现一次配置，最多 16 个接入并拒绝重复身份。**没有文件 watcher 或 CLI reload 命令**，编辑/创建 im.json 不会自动更新运行中的列表。已登记的未就绪凭据在退避重试时重新读取；新增/更新/移除使用 SDK 或 Daemon 的 im.upsert/im.remove/im.status，见 [动态接入](../../packages/octo-harness-channel-im/README.md#动态接入本地设备新增-agent)。SIGHUP 仍用于关闭。

配置示例与企业微信协议见 [多平台设计](../../packages/octo-harness-channel-im/docs/multi-platform-design.md)。文件路径、账号和 WorkApp 会话设置不自动传播到其他宿主。

## Doctor

```bash
octo-harness doctor
octo-harness --home /path/to/work-home --profile work doctor
```

`doctor` 是服务诊断入口，当前检查 Node.js 版本、profile/identity/credential 文件、POSIX credential mode、service program 绝对路径、原生 manager、definition drift、本地 IPC 和所选 Runtime 的云端连接。所有检查通过返回 0，否则返回 1，并为失败项输出 remediation。Host 调试日志用于看执行数据，不替代 doctor。

## 本地数据与 Run 诊断

```bash
octo-harness status
octo-harness adapter list
octo-harness adapter probe codex
octo-harness agent-session list
octo-harness agent-session get <agent-session-id>
octo-harness agent-run list
octo-harness agent-run get <agent-run-id>
octo-harness agent-run wait <agent-run-id>
octo-harness agent-run cancel <agent-run-id>
```

这些命令通过 Home 级 Unix socket 或 Windows named pipe 读取本地状态。Worker 仅管理对应远程执行，源事件窗口不能当作完整历史；本地会话及完整 trajectory 由宿主业务存储负责。

调试时在启动前设置 `OCTO_RUNTIME_DEBUG=1`，Host 日志直接追加到 `$OCTO_HARNESS_HOME/logs/adapter-host.log`。默认关闭；该开关通过进程环境传递到 daemon 和 Host。

## Playboard: standalone local trials

For development, testing, and integration debugging only. Do not integrate production
applications by spawning this CLI subcommand.

`playboard` reads **one complete JSON object** from stdin, starts its own adapter-host,
streams one `HostFrame` per stdout line (NDJSON), then exits and closes the Host.
It uses real adapters/providers without login, enrollment, Access, Worker, a daemon,
or a Harness database. Provider installation and authentication are still required.
It does not install providers. Provider tools can act on your workspace.

For Bash/zsh, a complete example is:

```bash
octo-harness playboard <<< '{
  "inputs": [{ "type": "text", "text": "Reply with OK. Do not use tools." }],
  "contexts": { "schema": "octo.context-envelope/v3", "items": [] },
  "sessionId": "playboard-demo",
  "protocol_mode": "canonical"
}'
```

Or save the same JSON and run `octo-harness playboard < request.json`.
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
provider bindings from Harness Home. It tests execution, not remote scheduling,
leases, persistence, or production end-to-end delivery.

## 状态目录

```text
<home>/config.json
<home>/machine.json                         # shared installation grouping label
<home>/octo-daemon.pid
<home>/sockets/octo-harness-daemon.sock       # POSIX
<home>/<profile>/config.json
<home>/<profile>/identity/runtime.json
<home>/<profile>/credentials/runtime-token.json
<home>/<profile>/agent-work.db
<home>/<profile>/channel-context.db
<home>/logs/
```

One Harness Home runs one daemon and adapter-host. Each discovered profile has its own server-assigned `runtime_id`, credential, and WSS connection, while sharing the Home-global `machine_id` and provider concurrency limits. Profile names allow 1-128 characters. The identity file must include the exact bound profile; identities without it are unsupported and require fresh enrollment after the Worker database reset.

`octo-daemon.pid` contains only a process PID. Profile identity is stored in `identity/runtime.json`; POSIX credentials use mode `0600`. Existing `system_id`/`device_id` identities are unsupported after this breaking reset: freshly enroll profiles against the recreated Worker database. Program files do not live inside Harness Home.

除帮助文本外，普通命令的正常结果输出 JSON。错误输出到 stderr 并返回非零。`--help` 和 `login --help` 不依赖网络或已运行 daemon。

## 模块责任边界

- 负责：提供现有 octo-harness 命令、Home/profile 配置、服务管理和本地诊断。
- 不负责：实现 Worker/IM 协议、直接启动每个 provider。
- 协作边界：见 [根架构与包边界](../../README.md#模块责任边界)。所有执行来源共用 adapter-host IPC；模块按职责提供协议、执行或宿主能力。

### 已撤回的注册 Agent 行为

原 `--agent-identity`／`--agent-name` 及注册时创建默认 `main` Agent 的行为退出，不属于最终 CLI 合同。Runtime 注册只登记设备与 Runtime；助手、分身及其 defaults／mandatory 由业务方管理。CLI 参数、profile 字段和重连请求中的旧 Agent 创建信息须同步删除，不提供旧路径兼容。OpenClaw 的 `provider_agent_id` 仍是本轮执行选择，与本次删除 Worker Agent registry 不同。


## Runtime 的 OpenClaw 连接

`login` 注册 Runtime 后保存并探测其本地 OpenClaw 连接。缺失或不可用的 Gateway 不阻止 Runtime 注册。连接存于 `<home>/<profile>/adapters/openclaw/connection.json`；凭据存于该 profile 的 `credentials` 目录。

```sh
octo-harness --home /path/to/harness --profile work adapter connect openclaw --openclaw-home /path/to/openclaw
octo-harness --home /path/to/harness --profile work adapter connect openclaw --gateway-url ws://127.0.0.1:18789 --token-stdin
octo-harness --home /path/to/harness --profile work adapter probe openclaw
```

显式参数优先；无参数时复用已保存连接，首次初始化读取 `OPENCLAW_HOME` 或成对的 `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN`，否则使用 `~/.openclaw`。`login` 也接受 `--openclaw-home` / `--gateway-url`；enrollment token 与 Gateway token 不可同时占用 stdin。

`playboard` 支持 `--home` 和 `--profile`，无须登录即可使用该 profile 的连接来源。完整概念与执行合同见 [统一合同](../../docs/15-openclaw-external-agent-binding-design.md)。

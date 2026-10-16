# Octo Runtime CLI

`pnpm build` 固化当前源码的 Git commit。`octo-runtime`、`octo-runtime --version` 和 `octo-runtime version` 显示版本及 `commit:<12 位短 SHA>`；工作树有未提交修改时附带 `(dirty)`。安装包携带构建元数据，不依赖运行目录的 Git；无 Git 来源时显示 `commit:unknown`。

管理本地 Agent Runtime、Provider Adapter 和后台服务。直接执行 `octo-runtime` 显示用途、发行版本及命令列表；`octo-runtime --version`（或 `-v`、`version`）输出根 `package.json` 的版本。

帮助采用 `Usage`、`Available Commands`、`Flags` 与 `Global Flags` 分层格式。命令组 `octo-runtime daemon` 和 `octo-runtime adapter` 默认显示帮助；启动前台进程必须显式执行 `octo-runtime daemon run`。使用 `octo-runtime help daemon start` 或 `octo-runtime daemon start --help` 查看具体命令。

daemon 子命令顺序为 `start`、`stop`、`restart`、`status`、`install`、`uninstall`、`run`。开发调试命令 `playboard` 排在主帮助末尾，`playboard --help` 包含完整请求示例与本文件路径。

## Extra plugins

`octo-runtime extraget <name>` 向 stderr 输出一行 `Config file: <绝对路径>`，stdout 只输出保存的完整 `{module, enabled?, config}` JSON，可重定向到文件，也可作为后续 `extraset` 输入。不加载模块、不启动 daemon、不补默认字段；读取继续校验名称、权限、大小和声明结构。输出保留原配置内容，包括其中的凭据。

```sh
octo-runtime extraget channel-gateway > channel-gateway.json
octo-runtime daemon status
octo-runtime daemon status --json
```

`status` 与 `daemon status --json` 在每个已加载 Extra 的生命周期旁添加 `status`，原样保留插件的 JSON；`daemon status` 的终端摘要也展开这些 JSON。未加载插件仅显示真实生命周期；查询失败提供 `status_error: EXTRA_STATUS_FAILED`，不冒充空状态。这里的运行状态与 `extraget` 读取的持久配置分开。

`octo-runtime extraset <name>` 从 stdin 读取完整 `{module, enabled?, config}` 并以 0600 权限替换 `HOME/extras/<name>/config.json`，不回显配置或启动插件。保存后执行 `octo-runtime daemon restart` 应用变更。CLI 不再提供 `extra status/load/unload`；嵌入式宿主继续通过 SDK 管理插件生命周期。

The native HTTP/Bearer/SSE demonstration and full here-string examples are documented in [Extra plugins](../../.octospec/rules/extras.md). This is a generic configuration command, not a platform-specific setup flow.

现行设计见 [Runtime 本地存在与按需在线合同](../../.octospec/rules/runtime-lifecycle.md)。当前 CLI／原生服务仍保留云端 profile 引导与连接恢复，IM 配置入口已提供；最终在线开关尚待实施；客户 SDK 无需使用该 CLI。

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../.octospec/rules/context-input.md) 与 [IPD-SE 0.3](../../.octospec/rules/context-input.md)；执行侧旧 Compiler/Pipeline 已移除。

`octo-runtime` 面向无显示器的独立设备，负责启动 daemon 和共享 AdapterHost、配置多个 IM 接入，以及 Runtime 登录、服务生命周期和本地诊断。IM 配置用法见接入指南第 1.4 节。运行时要求 Node.js 24 或更高版本。

## 最终架构期望

2026-10-14 目标：先初始化并保存稳定的本地 Runtime ID，本地 Host IPC 就绪即为启动成功。注册由独立显式命令触发，不再是安装、启动或本地调用的前置条件，不创建默认 Agent。

CLI 统一使用 `extraset <name>` 从 stdin 接收完整插件声明 `{ module, enabled?, config }`，保存在 `<home>/extras/<name>/config.json`。框架只校验声明及 JSON 结构，业务配置由插件解释；同名插件每次整份替换。

渠道的 Bot 配置、凭据和执行设置由插件解释。多个 Bot 一次写入完整的 `config.bots` 数组。OpenClaw 连接由宿主通过通用 Adapter 配置入口明确配置，daemon 不根据 Bot 列表探测或写入 Provider 配置。示例见 [CLI 使用指南](../../CLI_USAGE_GUIDE.md#4-通过统一-extra-入口配置和管理多个-im-接入)。

设备／Runtime 注册使用独立命令，候选名称为 `octo-runtime devices register`，最终命令名与参数待冻结。配置频道不隐式注册设备，注册也不隐式启用所有连接。

设备在线选择保存本地，与 IM 频道启用独立；关闭时不加载设备连接并停止已有连接，本地 Host 继续运行。access 目前仅确认设备与 Runtime 注册职责，设备 WS／heartbeat 等对外链路待最终架构评审。验收分别记录本地就绪、注册 ACK、设备连接和频道连接。详见 [IPD-SE 基线](../../.octospec/rules/runtime-lifecycle.md)。

下文说明现有 CLI 入口。设备注册等目标命令尚未全部交付；本地安装和运行无需登录。

## 全局参数

```text
--home PATH       覆盖 Runtime Home
--profile NAME    选择 profile，默认 default
```

macOS/Linux 默认 Home 是 `~/.octo-runtime`，Windows 是 `%LOCALAPPDATA%\OctoRuntime`。一个 Home 运行一个 daemon，并可包含多个 profile；每个 profile 独立保存 Runtime 身份、credential、WSS 与内存重放窗口。不同 OS 用户或互不信任的身份仍必须使用不同 OS account。

## 本地初始化

直接执行 `octo-runtime daemon start` 后台启动，或执行 `octo-runtime daemon run` 前台运行。`start` 在原生用户服务缺失时自动安装并启用服务，无需先手动执行 `install`。这些入口使用相同的默认 Runtime Home，也支持 `--home PATH` 与 `OCTO_RUNTIME_HOME`；首次使用自动创建缺失的本地配置和 machine identity，已有配置与身份保持原样。

CLI 不提供 `login` 命令及其更新入口。登录、登记和共享属于按需接入的 Extra，不是设备本地存在、安装或执行的条件。

## Daemon 生命周期

服务管理命令默认输出即时进度与简短摘要。`start` 在安装前、后台启动前及等待 IPC 就绪时分别提示；启动后列出识别到的 Adapter、已加载 Extra 和其他 Extra 的真实阶段。Extra 的 loaded 只表示初始化完成，不代表外部连接在线。使用 `--json` 输出完整结构化结果并关闭进度，例如 `octo-runtime daemon start --json`；前台 `run` 保持已有日志输出。

```bash
octo-runtime daemon install
octo-runtime daemon uninstall
octo-runtime daemon run
octo-runtime daemon start
octo-runtime daemon stop
octo-runtime daemon restart
octo-runtime daemon status
```

- `install` 准备缺失的本地默认配置，把 Runtime Home 注册为当前用户的原生服务，也可重复执行以修复 definition drift；默认启用登录自启但不启动，可用 `--no-autostart` 禁用自启。
- `uninstall` 直接停止并从原生服务管理器中真实删除服务：systemd user unit、macOS LaunchAgent 或 Windows 当前用户计划任务。身份、credential、本地状态和日志全部保留。
- `run` 在前台运行并响应 `SIGINT`/`SIGTERM`；PID 文件保证一个 Home 只有一个 daemon。
- `run` 默认在 stderr 输出彩色、脱敏的生命周期状态；`--quiet` 关闭终端输出，`--verbose`
  显示详细 operational records 和完整启动异常堆栈。RPC/provider 敏感内容仍只进入受保护日志。
- `start` 先检查原生用户服务，未安装时自动安装并启用登录自启，再由系统服务管理器后台启动；已安装时沿用原有启动逻辑，不重装或修改自启设置。等待本地 IPC 就绪后返回。已禁用的服务仍明确报错；`--wait-online` 不再支持。
- `stop`、`restart` 直接操作原生服务，不等待活动 Run 完成。
- 生命周期命令作用于整个 Home。daemon 自动发现 Home 下包含合法 `config.json` 的 profile，并由一个 supervisor 管理各自的 credential、`runtime_id`、WSS 和内存重放窗口。
- 锁屏不会结束已登录用户的服务；注销会结束 macOS LaunchAgent 和默认 Windows 用户任务。Linux 注销后是否继续取决于管理员是否启用 linger。

## Extra 配置

`octo-runtime extraset <name> < config.json` 原子保存完整插件声明，POSIX 文件权限为 `0600`，输出不回显配置或凭据。CLI daemon 启动时统一读取 `<home>/extras/<name>/config.json`，不设置渠道专用文件入口。

`config` 是插件自己的 JSON 对象；CLI/daemon 不解释、合并或补写 Bot 字段。Octo 插件在 `config.bots` 数组中配置多个机器人，`bot_name` 的默认值也由该插件处理。重新执行 `extraset` 会替换整个插件声明，必须提交希望保留的完整数组；重启 daemon 后加载文件变更。SDK 宿主显式提供 Extra 声明，不扫描配置文件。

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
```

这些命令通过 Home 级 Unix socket 或 Windows named pipe 读取本地状态。Worker 仅管理对应远程执行，源事件窗口不能当作完整历史；本地会话及完整 trajectory 由宿主业务存储负责。

调试时在启动前设置 `OCTO_RUNTIME_DEBUG=1`，Host 诊断写入 `$OCTO_RUNTIME_HOME/logs/adapter-host-YYYYMMDDTHH.log`（UTC）。默认关闭；该开关通过进程环境传递到 daemon 和 Host。RPC 日志只记录方法、身份、事件类型和大小，不保存输入 Context、图片或工具凭据。

Runtime 自管日志统一保留当前小时和前两个小时，每类别最多 3 个文件；单文件最多 100 MiB，满后丢弃本小时后续日志，下一小时恢复。启动、切小时及运行中每 60 秒清理过期桶。CLI 后台服务由 launcher 排空输出，分别写 `service-out-YYYYMMDDTHH.log` 和 `service-err-YYYYMMDDTHH.log`，SDK 子进程在账号 logs 下写 `embedded-runtime-YYYYMMDDTHH.log`。前台 `daemon run` 仍输出到终端。旧固定日志停止追加但不自动删除，系统日志及 Provider 原生文件不由此策略管理。升级后已有原生服务定义需显式执行 `daemon install` 更新接线，再重启；普通 `daemon start` 不自动修改服务定义。

## Playboard: standalone local trials

For development, testing, and integration debugging only. Do not integrate production
applications by spawning this CLI subcommand.

`playboard` 从 stdin 读取一个完整 JSON，通过统一启动入口拉起临时 daemon，
经 Unix Socket / Windows Named Pipe 执行并输出 NDJSON，结束后回收本次 daemon、Host 和临时状态。
无需登录、enrollment、Access、Worker 或预先启动 daemon。已有常驻 daemon 不参与本次执行。
临时执行复用所选 Home/profile 的 Provider 装配，不加载已配置 Extra，不同步渠道工具凭据。
Provider 安装、认证以及 OpenClaw Gateway 等外部服务仍须预先就绪。
既有 Home、profile、身份和 Provider 连接配置不随临时执行销毁。
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
created or replaced with another target. daemon 的统一启动编排刷新所选 profile 的连接；Adapter 只读取装配后的配置并验证目标。Other protocol entry points still require
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
Requests are limited to 32 MiB of UTF-8 JSON, including embedded images and Context.

`--manifest /absolute/adapters.json` selects an explicit adapter manifest for adapter
experiments or fake-provider tests; the default is the CLI-owned `apps/cli/src/default_adapters.json` (built as `apps/cli/dist/default_adapters.json`),
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

daemon 服务管理命令默认输出终端摘要，显式 `--json` 输出 JSON；其他普通控制命令仍输出 JSON。错误输出到 stderr 并返回非零。`--help` 和 `daemon --help` 不依赖网络或已运行 daemon。

## 模块责任边界

- 负责：提供现有 octo-runtime 命令、Home/profile 配置、服务管理和本地诊断。
- 不负责：实现 Worker/IM 协议、直接启动每个 provider。
- 协作边界：见 [根架构与包边界](../../README.md#模块责任边界)。所有执行来源共用 adapter-host IPC；模块按职责提供协议、执行或宿主能力。

### 已撤回的注册 Agent 行为

原 `--agent-identity`／`--agent-name` 及注册时创建默认 `main` Agent 的行为退出，不属于最终 CLI 合同。Runtime 注册只登记设备与 Runtime；助手、分身及其 defaults／mandatory 由业务方管理。CLI 参数、profile 字段和重连请求中的旧 Agent 创建信息须同步删除。OpenClaw 的 `provider_agent_id` 仍是本轮执行选择，与本次删除 Worker Agent registry 不同。


## Runtime 的 OpenClaw 连接

CLI daemon 启动时准备并探测本地 OpenClaw 连接。缺失或不可用的 Gateway 不阻止本地 Host 就绪。连接存于 `<home>/<profile>/adapters/openclaw/connection.json`；凭据存于该 profile 的 `credentials` 目录。

```sh
octo-runtime --home /path/to/harness --profile work adapter probe openclaw
```

CLI 不再提供 `adapter connect`。启动时复用已保存连接，首次初始化读取 `OPENCLAW_HOME` 或成对的 `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN`，否则使用 `~/.openclaw`。宿主通过 SDK 显式管理连接配置。

`playboard` 支持 `--home` 和 `--profile`，无须登录即可使用该 profile 的连接来源。完整概念与执行合同见 [统一合同](../../.octospec/rules/openclaw.md)。

# Octo Runtime

架构与开发约束见 [基础架构规则](.octospec/rules/architecture.md) 和 [OKF 工程知识目录](.octospec/index.md)。本项目使用中文维护内部工程说明。

业务标签与功能入口由宿主管理。本地 Runtime 已删除自有 Adapter capabilities、executionFeatures、执行计划 required_capabilities 和 ExecutionTarget / AbilityProvider 预留合同，不提供替代能力表；执行元数据、协议支持、审批和原生 Provider 协商的边界见 [Adapter 元数据规则](.octospec/rules/adapter-metadata.md)。

函数式业务扩展见 [Extra 插件设计与使用](.octospec/rules/extras.md)。`octo-runtime extraset <name>` 从 stdin 保存完整 JSON 声明；daemon 重启后自动加载。本地项目、会话与聊天页面使用 [octo-runtime-extra-webui](packages/octo-runtime-extra-webui/README.md)，默认端口 `13888`。

第三方 TypeScript 插件使用发行包公开入口 `@mininglamp-oss/octo-runtime/extra` 和 `/protocol` 获取完整 Extra/执行协议类型与校验工具，无需源码或独立安装私有 packages；见[仓库外开发指南](.octospec/guides/extra-configuration.md)。CLI 外部 Adapter 追加清单和 `/adapter` 公开入口仍属[待实施目标](.octospec/tasks/adapter-composition-ownership/brief.md)。

Octo Runtime 是 provider-neutral 的本地 Agent Runtime。本地接入使用 `HostApp → daemon 包的 SDK → IPC → Host → Adapter`。本地 Runtime ID 在初始化时生成并保存；Host socket 就绪即为本地启动成功。云端注册和对外连接由宿主显式控制，不是本地运行的前置条件。

架构评审指出，原项目名称容易被理解为自研 ReAct 的 Agent 框架，与项目实际作用和价值不符。项目现统一命名为 **Octo Runtime**，包使用 `octo-runtime-*`，CLI 使用 `octo-runtime`。独立 CLI 默认 Home 为 `~/.octo-runtime`；Octo Work 保持产品名称，默认 Home 改为 `~/.octo-runtime-work`，本次本机改造将已有数据整目录移动到新位置。改造范围与验证记录见 [命名改造方案](.octospec/journal/shared/architecture-evolution.md)。本地改名不表示新 npm 包或线上安装路由已经发布。

`octo-runtime-embedded` 独立包已移除，其本地生命周期与 IPC API 收入 `octo-runtime-daemon`。daemon 包不依赖 worker-access 或 channel-gateway；客户可以只部署 daemon 及其本地执行依赖。标准产品由 HostApp 另行携带可选连接包，通过 Extra 声明显式装配。当前 SDK 的本地控制进程仍使用 daemon server；下面记录的最终对外进程职责和在线 toggle 按各自里程碑验收，不能从本次包合并推断已经全部实现。

## 使用场景与指南

仅需接入 Octo IM 的 Electron 项目（建议 OctoBuddy 采用）看 [Channel Gateway 接入指南](SDK_CHANNEL_GATEWAY_GUIDE.md)；自行装配或直接调用 Agent 看 [完整原生接入指南](SDK_NATIVE_INTEGRATION_FULL_GUIDE.md)。

**Electron、Tauri 2 桌面程序严禁通过 CLI 接入，必须通过 [SDK 原生接入指南](SDK_NATIVE_INTEGRATION_FULL_GUIDE.md)接入。** 客户系统融合使用 daemon SDK；[CLI 使用指南](CLI_USAGE_GUIDE.md)仅面向云端设备的定制接入、部署和运维。CLI 默认包含全部 Adapter、Extra，以及系统管理、开启自启等服务能力；默认包含不等于安装后全部启用。 宿主应用调用 SDK，经 IPC 由 Host 调用对应 Adapter；相比把 `octo-runtime` CLI／CMD 可执行程序作为业务调用入口，这种方式更适合持续会话、交互审批和应用内运行管理。

- **接口明确**：通过类型化请求、结构化事件和错误处理执行结果，减少命令拼接、参数转义、终端输出解析和退出码映射的集成代码。
- **生命周期可控**：宿主统一安排启动、停止、取消和交互答复，把执行状态接入自己的 UI 与业务流程，便于处理应用退出和执行中断。
- **复用客户配置体系**：宿主沿用已有数据库、配置平台或自定义 store，按 SDK 契约传入配置，便于与客户的身份、权限和租户管理流程衔接。
- **测试与诊断更直接**：围绕请求、事件和终态验证业务行为，便于将运行 ID、错误和执行事件关联到客户系统的日志与监控。
- **便于定制和维护**：把 SDK 与 Adapter 依赖纳入客户应用的版本管理和发布流程，减少对全局 CLI、shell 环境和人工操作步骤的依赖。

SDK 接入不表示所有执行都在宿主进程内完成；daemon、Host 和 Provider 仍可能使用独立子进程，部分 Adapter 仍依赖 Provider CLI。Runtime 及运行依赖的安装方案由 HostApp 决定。云端设备的 CLI 使用和客户应用的 SDK 接入分别维护，选型入口见 [INTEGRATION.md](INTEGRATION.md)。

**接入优先级：以稳定性为优先，推荐通过 SDK 经 IPC 调用独立 Executor Kernel，尤其是 Electron 等长期运行的宿主。** 新 Executor Kernel 及其 IPC、监督能力由 #47 后续实施；当前保留原独立 worker 和 NDJSON 路径。公开 `@mininglamp-oss/octo-runtime/executor-core` 允许宿主显式选择进程内嵌入，作为 SDK 简易接入方案；该方式由宿主管理生命周期，与宿主共享进程故障域，不具备独立执行进程的故障隔离。开放直接调用入口不改变隔离执行的推荐优先级。

## 设计原则与实施状态

### 配置来源由宿主决定：SDK 的灵活性

**SDK 接收符合接口契约的配置对象，配置从哪里读取、如何保存、何时更新，完全由宿主开发者决定。** 宿主可以使用内存、本地文件、SQLite、其他数据库、自定义 store 或远程配置平台，也可以组合多个来源。SDK 接入不要求宿主使用指定配置文件、固定文件名、目录或存储产品。

宿主负责读取配置，构造完整 Extra 声明 `{ name, module, config }`。IM 插件在 `config.bots` 数组中管理多个 Bot；宿主通过初始 `extras` 声明或 `configureExtra(descriptor)` 提交完整快照。SDK 校验声明和 JSON 结构，插件校验自己的业务字段，执行层继续校验执行权限。

**CLI 的配置文件约定属于 CLI 入口，不是 SDK 的接入要求。** `extraset <name>` 保存完整 `{ module, enabled?, config }` 到 `<home>/extras/<name>/config.json`；每次整份替换，重启 daemon 后加载。CLI/daemon 不解释或合并 Bot 字段。SDK 宿主从自己的 store 构造同样的声明对象，无需创建此文件。

配置来源自由与 SDK 的内部运行状态持久化是两层职责。SDK／模块仍可在选定 Home 下管理 Runtime 身份、设备凭据、PID/socket、日志等状态；这些内部文件不要求宿主把自己的模块配置也存到同一位置。详细边界见 [接入指南：配置来源与 SDK 契约](SDK_NATIVE_INTEGRATION_FULL_GUIDE.md#22-加载和重载-extra)。

### 本地运行与按需在线

本地身份、IPC 就绪、Provider 可用、外部连接和执行完成分别判断，依据见 [生命周期合同](.octospec/rules/runtime-lifecycle.md)。云端登记不决定本地存在。

`octo-runtime-daemon` 是对外交互子模块的装配层。宿主指定是否启用模块、凭据来源及目标服务，daemon 按配置动态加载模块并管理连接；各入口复用同一个 Host。纯本地启动不激活对外模块；当前 SDK 的本地控制进程仍由 daemon 包 server 承载。导入 SDK 或接入 package 本身不激活 WS，也不发起注册。

当前仓库没有 Worker 远程接入包，也不提供 `login` 命令。本地安装和运行自动准备缺失的 Home 配置。Octo 与 WeCom 由可选 Extra 包实现；设备共享访问的最终方案仍待确定，旧提议和撤回理由见 [架构演进](.octospec/journal/shared/architecture-evolution.md)。

业务方决定五元组和本轮 Context，应用 defaults 并检查 mandatory。SDK、daemon、注册模块、通用连接层和 Host 不读取 Agent 业务配置。启动、注册和本地调用没有 Agent prepare／ensure／默认创建流程。详见 [需求与验收基线](.octospec/rules/runtime-lifecycle.md)。

## 纯执行实体

Runtime 不保存业务 Agent、Session 或 Run 历史，不依赖本地 SQLite。执行状态和事件回放使用有界内存；配置、凭据和进程清理元数据保留 JSON 文件。Provider 自身的存储不在此约束范围内。设计与验收见 [纯执行实体方案](.octospec/rules/stateless-execution.md)。

## Context 方案设计约束

Event 发起方必须完成 awareness 采集、材料选择、指引编写和 Context 构造，并随 Event 保存同一份协议快照。后续 Run 与 Host 沿用其内容和顺序，重投不得重新采集业务状态。

每轮模型上下文完全由业务发起方决定：selection、项目背景、任务状态或 extra 均非框架必填项。业务方可以首次发送必要背景，续聊无变化时传空，有变化时仅发送本轮需要的项，也可以显式重复发送。必要的 adapter 等执行配置仍按执行合同及 defaults/mandatory 校验，不注入 LLM 上下文块。

底层只转发、渲染本轮数据，不按 `sessionId`、run 序号或 hash 缓存、补齐、合并、去重或省略模型上下文。两个不同 Event 显式发送相同 item 时均须传递；原 Event 幂等重投仍复用原快照。`sessionId` 存在不保证 resume 成功；reset、新建 Provider 会话或恢复失败后，业务方负责重新提供所需背景，底层返回真实结果，不自动补背景。

接入扩展必须校验并转发模型上下文，不得追加场景指引、预取任务材料或调用模型摘要。执行配置解析、身份与授权校验、工作区和图片准备、租约、会话及取消仍由对应执行模块负责。

Host 必须通过单一纯函数，将可注入 item 按固定开始/结束标记及 `contexts` / `context-item` 外层标记拼接。item 内部使用换行纯文本 `指引: ...`、`数据: ...`，不添加子标签、不做 XML 实体转义，也不要求严格 XML。执行配置不注入模型上下文块；合法 `extra.*` item 的指引和 payload 完整注入，不增加逐业务 Compiler、Resolver 或字段投影配置。

Host renderer 只匹配白名单 pattern：`extra.*/*`、`octo.content/inline`、`octo.content/references`。renderer 不校验业务字段、不查处理器、不检查场景材料、不解引用、不压缩。接纳边界仍处理协议格式和执行权限；必要 adapter 等执行配置独立解析。Compiler/Pipeline、材料预取与摘要、扩展字段投影及编译回执已删除。

详细设计见 [Event Context 与 Host 固定渲染：IPD-SE 基线](.octospec/rules/context-input.md)，当前注入规则见 [LLM 注入约束](.octospec/rules/context-input.md)。Run 7 / Context v3 保持不变；传输字段沿用 `context` / `effective_context`，其中 `items` 是本轮列表，渲染文本使用 `contexts` 外层标记。

## 基础架构

当前入口共享同一执行内核，完整边界见 [架构规则](.octospec/rules/architecture.md)。

```mermaid
flowchart LR
    APP["HostApp：业务策略与本地配置"] --> SDK["daemon 包：本地生命周期 SDK"]
    SDK -->|"本地 IPC"| HOST["统一 Host"]
    HOST --> AD["Provider Adapters"]
    APP -->|"显式外部接入配置"| D["daemon：模块 / token / 目标服务装配"]
    D -->|"按需加载"| IM["Octo / WeCom Extra"]
    IM <-->|"IM WS"| SERVER["IM 服务"]
    IM -->|"共享 Host 执行入口"| HOST
```

Host IPC 承载 invoke、取消、审批／问答答复和执行事件。daemon 使用 Host 提供的执行入口；业务来源不同不产生第二套 Provider 执行器。Context v3 的内容和顺序由业务发起方确定，通用连接层只校验和转发。关闭某个对外模块不得停止仍供本地 IPC 使用的 Host。

## 模块责任边界

| 模块 | 负责 | 不负责 |
|---|---|---|
| [CLI](apps/cli/README.md) | 现有命令入口、Home/profile、服务启动停止、诊断 | IM 协议、provider 执行实现 |
| [Daemon 启动器](apps/daemon/README.md) | 配置解析、启动与信号转发 | Worker WS 业务实现 |
| [Daemon 包](packages/octo-runtime-daemon/README.md) | 本地生命周期 SDK、IPC 与共享 Host；按宿主配置动态装配可选连接模块 | 决定宿主启用哪些模块、依赖 worker-access、处理业务 Context、另建 Host 执行器 |
| [WeCom Channel](packages/octo-runtime-extra-channel-wecom/README.md) | 企业微信连接、原生 stream 回复和独立生命周期 | Octo IM 协议、跨平台 connector 分发 |
| [IM 接入](packages/octo-runtime-extra-channel-gateway/README.md) | bf_token 注册、IM WS、私聊会话、/session、/reset、最终文本回发 | 直接调用 provider、独立 Daemon、聊天 SQLite 的隐式引入 |
| [Adapter Host](packages/octo-runtime-adapter-host/README.md) | 过渡期独立 worker、NDJSON RPC 与源窗口，委托同一 Core | 第二套执行实现、消息来源、群聊规则、Worker 注册 |
| [Executor Core](packages/octo-runtime-executor-core/README.md) | AgentExecutor、输入准备、执行与交互、取消和清理；支持显式 direct | IPC、监督、回放、IM/Loop 业务模型 |
| [Protocol](packages/octo-runtime-protocol/README.md) | InvokeRequest、CanonicalEvent、Context 和校验合同 | 网络连接、进程和业务存储 |
| [Cross Service](packages/octo-runtime-cross-service/README.md) | OS 用户级服务管理 | Run 调度、连接协议 |
| [Adapters / SDK / ACP](packages/README.md) | provider 协议转换、进程与 transport 工具 | Worker/IM 连接和业务决策 |

当前一个 SDK 账号的多个 profile 共享 Host；是否激活对外模块由 HostApp 决定。本地控制进程与对外专用进程的进一步拆分另行验收。新入口复用现有 CLI、Home 和服务管理，不按 Codex 会话或工作目录另起一套默认运行时。当前 app-owned Home 可按 appId 隔离，不能把不同 Home 宣称为已自动合并的全局单实例。

当前 Run 固定为 `schema_version=7`，Context 固定为 `octo.context-envelope/v3`，不增加旧协议回退。技能、插件及 MCP 程序的安装与更新由 HostApp 管理；本轮 MCP 连接配置通过 `octo.execution/mcp` 传入，由 adapter 转换，见 [Run MCP 合同](.octospec/rules/mcp.md)。凭据不进入模型输入。旧 Channel context、聊天 SQLite 和相关业务实现已移出；参考快照位于同级 `octo-channel-design-reference/`，不参与构建。源执行事件使用有界内存窗口，不等待 durable ACK。

Codex 保留原生既有 MCP，由 Provider 自行加载；本轮仅覆盖新增连接与必要的环境变量白名单。HostApp 提供的 MCP 名称若与任一原生连接同名（包括 disabled 条目），会在创建或恢复会话及发送输入前返回 `MCP_SERVER_NAME_CONFLICT`，须由 HostApp 选择唯一名称。Runtime 不回写用户 Home 配置。

## 代码结构

```text
apps/
  cli/                             现有运维 CLI
  daemon/                          启动与配置入口
packages/
  octo-runtime-daemon/              本地生命周期 SDK、IPC、可选模块装配
  octo-runtime-extra-channel-gateway/  Octo IM 专用连接、会话与结果回发
  octo-runtime-extra-channel-wecom/    企业微信专用连接、会话与 stream 回复
  octo-runtime-adapter-host/        过渡 worker + NDJSON RPC / 源窗口
  octo-runtime-executor-core/       唯一 AgentExecutor 与执行配置解析
  octo-runtime-protocol/            统一执行和 Context 合同
  octo-runtime-adapter-*/           provider adapters 与共享 SDK
  octo-runtime-acp-client/          ACP transport
  octo-runtime-cross-service/       原生用户服务管理
```

每个模块的责任边界见对应 README；完整包索引见 [packages](packages/README.md)，可执行入口见 [apps](apps/README.md)。

## 安装与本地初始化

独立 CLI 通过 npm 安装，要求 Node.js 24.x：

```bash
npm install -g @mininglamp-oss/octo-runtime
octo-runtime --help
```

安装完成后，按需运行 `octo-runtime daemon run` 前台启动，或通过 `octo-runtime daemon install` 配置本机用户服务。npm 安装不执行云端登记，也不要求设备在线；登录、登记和共享由可选业务 Extra 负责。程序更新保留已有 Home、身份与配置。

HostApp 集成时自行决定安装方案与版本。源码开发、全局 link 和发行步骤见 [部署说明](DEPLOYMENTS.md)，本地服务操作见 [CLI](apps/cli/README.md)。

## 源码开发与验证

要求 Node.js 24.x。真实 provider 还要求对应 CLI 已安装并完成认证。

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

默认测试使用 fake provider，不调用真实模型；纯执行实体守卫验证不创建数据库。实机验证脚本 `scripts/verify-stateless-live.mjs` 使用 im-test 登录态、IM 连接和真实 Codex。

新增或修改代码后，使用 Prettier 格式化本次改动的文件，再检查格式。例如：

```bash
pnpm format 'packages/octo-runtime-extra-channel-gateway/src/**/*.ts' test/im-runtime.test.js
pnpm format:check 'packages/octo-runtime-extra-channel-gateway/src/**/*.ts' test/im-runtime.test.js
```

`format` 和 `format:check` 均需传入文件或 glob；格式化不替代类型检查、ESLint 和测试。

## ZCode GUI Adapter

`zcode-gui` adapter 不连接或注入已运行的 Electron GUI，而是直接启动 ZCode Desktop 随附的
`zcode.cjs app-server --stdio`。从 [ZCode 官方安装页](https://zcode.z.ai/cn/docs/install)
下载并安装桌面应用，随后完成一次 ZCode CLI 登录和模型配置：

```bash
# macOS 默认安装位置
node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs --version
node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs login

# PATH 上已安装 zcode 时
zcode --version
zcode login
```

adapter 按 `ZCODE_BIN`、PATH、平台默认桌面安装目录的顺序发现 CLI。非标准位置需要把绝对路径
写入 daemon service 的环境，而不只是当前交互 shell：

```bash
export ZCODE_BIN=/absolute/path/to/zcode.cjs
pnpm cli adapter probe zcode-gui
```

ZCode CLI 的模型 provider 配置位于 `~/.zcode/cli/config.json`，应由 `zcode login` 维护，
不要从 GUI 配置手工复制或提交 API key。Agent revision 使用 `adapter_type: "zcode-gui"`，
并可配置：

```json
{
  "permissionMode": "build",
  "autoApprove": false,
  "providerOptions": {
    "appServerRequestTimeoutMs": 30000
  }
}
```

默认工具授权 fail-closed。只有显式设置 `autoApprove: true`、
`dangerouslyBypassPermissions: true` 或 `permissionMode: "yolo"` 才会自动允许 ZCode 工具请求。
adapter 不感知 `octo-auth`；Human/Runtime 身份与 AgentRun 授权由 Agent Worker 完成，daemon 只消费
既有 WSS Runtime 协议下发的已授权命令。完整协议、进程与安全边界见
[ZCode GUI Adapter](packages/octo-runtime-adapter-zcode-gui/README.md)。

## 启动 Runtime

源码调试直接启动 daemon：

```bash
pnpm cli -- --home "$PWD/.tmp/runtime-home" daemon run
```

The local SDK initializes a stable identity for each profile without cloud enrollment. Profiles share the Home-level `machine_id`, an untrusted installation grouping label rather than a credential. One Home runs one daemon and adapter-host. Mutually untrusted users must use separate OS accounts. See [Runtime and machine identity](.octospec/rules/runtime-lifecycle.md) and [current local boundaries](.octospec/rules/runtime-lifecycle.md). The former Worker access package has been removed.

本地运维命令：

```bash
pnpm cli status
pnpm cli adapter list
pnpm cli adapter probe codex
pnpm cli agent-run get RUN_ID
```

启动前设置 `OCTO_RUNTIME_DEBUG=1`，Host 日志会直接追加到 `$OCTO_RUNTIME_HOME/logs/adapter-host.log`（Home 默认 `~/.octo-runtime`）。默认关闭；没有内存观测队列、Provider I/O 采集或 Inspect 服务。

## 会话恢复

Runtime 永远不生成业务 `session_key`。上游业务服务按统一规则生成：

- IM 群：`v1/<platform>/<endpoint_id>/group/<group_id>`
- IM 私聊：`v1/<platform>/<endpoint_id>/dm/<user_id>`
- Loop Task：`v1/task/<task_id>`
- AutoPilot 单次节点：`v1/execution/<execution_id>/node/<node_instance_id>`
- AutoPilot 长期节点：`v1/plan/<plan_id>/node/<node_id>`
- Webhook subject：`v1/hook/<endpoint_id>/subject/<subject_id>`
- Buddy conversation：`v1/workspace/<workspace_id>/conversation/<conversation_id>`

Provider 返回的 Codex thread ID、Claude session UUID 或 OpenCode session ID 存在 Worker 的 `AgentSession.provider_session` 中。下一次 `run.start` 将它放入 `InvokeRequest.providerSession.sessionId`；该字段对 Worker 与 Runtime 都是 opaque。`/reset` 由 Worker 增加 session generation/provider epoch 并清空 provider session，下一轮 provider 创建新的 thread/session。

## 进一步阅读

- [Event Context 与 Host 固定渲染：IPD-SE 设计基线](.octospec/rules/context-input.md)
- [业务会话、执行 Session 与本地 Reset：IPD-SE 实施与验证](.octospec/rules/session-reset.md)
- [Architecture](.octospec/rules/architecture.md)
- [Module And Transport Flow](.octospec/rules/local-execution.md)
- [Prompt And Workdir](.octospec/rules/context-input.md)
- [Provider Adapters](.octospec/guides/providers.md)
- [Runtime 与 OpenClaw 连接统一合同](.octospec/rules/openclaw.md)
- [Transport And Multi-node](.octospec/rules/local-execution.md)
- [Local Runtime Boundaries](.octospec/rules/runtime-lifecycle.md)

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。Copyright 2026 Mininglamp Technology。
第三方依赖及引入的资源保留各自许可证与版权声明。

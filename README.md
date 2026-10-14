# Octo Runtime

函数式业务扩展见 [Extra 插件设计与使用](docs/extra-plugins.md)。`octo-runtime extraset <name>` 从 stdin 保存完整 JSON 声明；daemon 重启后自动加载。原生 HTTP → Host → SSE 演示包为 [octo-runtime-extra-sse-demo](packages/octo-runtime-extra-sse-demo/README.md)。

Octo Runtime 是 provider-neutral 的本地 Agent Runtime。本地接入使用 `HostApp → daemon 包的 SDK → IPC → Host → Adapter`。本地 Runtime ID 在初始化时生成并保存；Host socket 就绪即为本地启动成功。云端注册和对外连接由宿主显式控制，不是本地运行的前置条件。

架构评审指出，原项目名称容易被理解为自研 ReAct 的 Agent 框架，与项目实际作用和价值不符。项目现统一命名为 **Octo Runtime**，包使用 `octo-runtime-*`，CLI 使用 `octo-runtime`。独立 CLI 默认 Home 为 `~/.octo-runtime`；Octo Work 保持产品名称，默认 Home 改为 `~/.octo-runtime-work`，本次本机改造将已有数据整目录移动到新位置。改造范围与验证记录见 [命名改造方案](../docs/octo-runtime-rename-ipd-se.md)。本地改名不表示新 npm 包或线上安装路由已经发布。

`octo-runtime-embedded` 独立包已移除，其本地生命周期与 IPC API 收入 `octo-runtime-daemon`。daemon 包不依赖 worker-access 或 channel-gateway；客户可以只部署 daemon 及其本地执行依赖。标准产品由 HostApp 另行携带可选连接包，通过模块配置显式启动。当前 SDK 的本地控制进程仍使用 daemon server；下面记录的最终对外进程职责和在线 toggle 按各自里程碑验收，不能从本次包合并推断已经全部实现。

## 设计原则与实施状态

### 配置来源由宿主决定：SDK 的灵活性

**SDK 接收符合接口契约的配置对象，配置从哪里读取、如何保存、何时更新，完全由宿主开发者决定。** 宿主可以使用内存、本地文件、SQLite、其他数据库、自定义 store 或远程配置平台，也可以组合多个来源。SDK 接入不要求宿主使用指定配置文件、固定文件名、目录或存储产品。

宿主负责读取、解析和按自身规则合并配置，再通过 SDK 设置模块。例如，IM 配置可以通过 `startModule("channel-gateway", { bots })` 传入，也可以在模块启动后通过 `requestModule("channel-gateway", "upsert", { config })` 应用。这里的 `config` 是配置对象；跨进程序列化不意味着宿主必须提供 JSON 文件。SDK 和模块仍按各自契约校验配置结构、字段语义及执行权限。

**CLI 的配置文件约定属于 CLI 入口，不是 SDK 的接入要求。** CLI 可以选择把 IM 配置保存到 `<home>/im.json`，启动时解析后调用模块；桌面 App 或其他宿主可以从自己的 store 或配置平台取得同类对象，通过 SDK 应用。更换配置来源不需要改变模块的配置契约。

配置来源自由与 SDK 的内部运行状态持久化是两层职责。SDK／模块仍可在选定 Home 下管理 Runtime 身份、设备凭据、PID/socket、日志等状态；这些内部文件不要求宿主把自己的模块配置也存到同一位置。详细边界见 [接入指南：配置来源与 SDK 契约](INTEGRATION.md#02-配置来源与-sdk-契约)。

### 本地运行与按需在线

2026-10-14：统一原则及事实判定见 [Runtime 本地存在与按需在线合同](docs/runtime-local-and-online-contract.md)。设备存在、本地初始化、本地就绪、注册、允许在线、实际连接及执行完成分别判断。云端登记不决定本地存在；access 最终链路仍待评审。

`octo-runtime-daemon` 是对外交互子模块的装配层。宿主指定是否启用模块、凭据来源及目标服务，daemon 按配置动态加载模块并管理连接；各入口复用同一个 Host。纯本地启动不激活对外模块；当前 SDK 的本地控制进程仍由 daemon 包 server 承载。导入 SDK 或接入 package 本身不激活 WS，也不发起注册。

设备／Runtime 注册由显式操作触发，access 的已确认职责仅为注册。设备持续在线所需的 WS、heartbeat、关闭及失效合同仍待评审；`worker-access` 预研已移到生态目录外独立仓库，仅作备份；当前 CLI 和 Work App 不再加载它。

待实施的 Work App 设备管理要求：提供本地持久化的“允许当前设备在线”toggle。关闭时不加载设备连接模块，已有设备连接停止；本地 Host 继续执行。重启按已保存的用户选择恢复配置，登录或 Host 启动不能自行开启。设备连接和 IM channel-adapter 分别启用，注册 ACK、设备在线、频道在线和本地就绪分别报告。

CLI 要提供显式 IM 频道配置入口，保存 channel 类型、目录／执行 Context、Bot 凭据引用与启用状态，再由 daemon 启动已启用频道。设备／Runtime 注册是独立命令，候选名称为 `octo-runtime devices register`；最终参数待冻结。上述命令是目标入口，不表示当前命令树已全部交付。频道配置不隐式注册设备，注册不隐式开启全部连接。

业务方决定五元组和本轮 Context，应用 defaults 并检查 mandatory。SDK、daemon、注册模块、通用连接层和 Host 不读取 Agent 业务配置。启动、注册和本地调用没有 Agent prepare／ensure／默认创建流程。详见 [需求与验收基线](../docs/local-runtime-ipc-on-demand-ipd-se.md)。

## 纯执行实体

Runtime 不保存业务 Agent、Session 或 Run 历史，不依赖本地 SQLite。执行状态和事件回放使用有界内存；配置、凭据和进程清理元数据保留 JSON 文件。Provider 自身的存储不在此约束范围内。设计与验收见 [纯执行实体方案](docs/15-stateless-executor-design.md)。

## Context 方案设计约束

Event 发起方必须完成 awareness 采集、材料选择、指引编写和 Context 构造，并随 Event 保存同一份协议快照。后续 Run 与 Host 沿用其内容和顺序，重投不得重新采集业务状态。

每轮模型上下文完全由业务发起方决定：selection、项目背景、任务状态或 extra 均非框架必填项。业务方可以首次发送必要背景，续聊无变化时传空，有变化时仅发送本轮需要的项，也可以显式重复发送。必要的 adapter 等执行配置仍按执行合同及 defaults/mandatory 校验，不注入 LLM 上下文块。

底层只转发、渲染本轮数据，不按 `sessionId`、run 序号或 hash 缓存、补齐、合并、去重或省略模型上下文。两个不同 Event 显式发送相同 item 时均须传递；原 Event 幂等重投仍复用原快照。`sessionId` 存在不保证 resume 成功；reset、新建 Provider 会话或恢复失败后，业务方负责重新提供所需背景，底层返回真实结果，不自动补背景。

接入扩展必须校验并转发模型上下文，不得追加场景指引、预取任务材料或调用模型摘要。执行配置解析、身份与授权校验、工作区和图片准备、租约、会话及取消仍由对应执行模块负责。

Host 必须通过单一纯函数，将可注入 item 按固定开始/结束标记及 `contexts` / `context-item` 外层标记拼接。item 内部使用换行纯文本 `指引: ...`、`数据: ...`，不添加子标签、不做 XML 实体转义，也不要求严格 XML。执行配置不注入模型上下文块；合法 `extra.*` item 的指引和 payload 完整注入，不增加逐业务 Compiler、Resolver 或字段投影配置。

Host renderer 只匹配白名单 pattern：`extra.*/*`、`octo.content/inline`、`octo.content/references`。renderer 不校验业务字段、不查处理器、不检查场景材料、不解引用、不压缩。接纳边界仍处理协议格式和执行权限；必要 adapter 等执行配置独立解析。Compiler/Pipeline、材料预取与摘要、扩展字段投影及编译回执已删除，不保留旧路径或兼容升级。

详细设计见 [Event Context 与 Host 固定渲染：IPD-SE 基线](../docs/event-context-rendering-ipd-se.md)，当前注入规则见 [LLM 注入约束](docs/context-llm-injection.md)。Run 7 / Context v3 保持不变；传输字段沿用 `context` / `effective_context`，其中 `items` 是本轮列表，渲染文本使用 `contexts` 外层标记。

## 基础架构

以下为目标拓扑；注册与设备连接的最终 access 合同待架构评审。

```mermaid
flowchart LR
    APP["HostApp：业务策略与本地配置"] --> SDK["daemon 包：本地生命周期 SDK"]
    SDK -->|"本地 IPC"| HOST["统一 Host"]
    HOST --> AD["Provider Adapters"]
    APP -->|"显式外部接入配置"| D["daemon：模块 / token / 目标服务装配"]
    D -->|"按需加载"| IM["channel-adapter"]
    IM <-->|"IM WS"| SERVER["IM 服务"]
    IM -->|"共享 Host 执行入口"| HOST
    D -->|"显式注册"| REGISTER["设备 + Runtime 注册模块"]
    REGISTER --> WORKER["注册服务"]
    D -.->|"本地在线 toggle 控制；合同待评审"| DEVICE["设备对外连接模块"]
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
| [Adapter Host](packages/octo-runtime-adapter-host/README.md) | 统一 IPC、invocation 生命周期、调用和取消、标准事件 | 消息来源、群聊规则、Worker 注册 |
| [Core](packages/octo-runtime-core/README.md) | 执行配置解析与校验 | IM/Loop 业务模型、WS 接入 |
| [Protocol](packages/octo-runtime-protocol/README.md) | InvokeRequest、CanonicalEvent、Context 和校验合同 | 网络连接、进程和业务存储 |
| [Cross Service](packages/octo-runtime-cross-service/README.md) | OS 用户级服务管理 | Run 调度、连接协议 |
| [Adapters / SDK / ACP](packages/README.md) | provider 协议转换、进程与 transport 工具 | Worker/IM 连接和业务决策 |

当前一个 SDK 账号的多个 profile 共享 Host；是否激活对外模块由 HostApp 决定。本地控制进程与对外专用进程的进一步拆分另行验收。新入口复用现有 CLI、Home 和服务管理，不按 Codex 会话或工作目录另起一套默认运行时。当前 app-owned Home 可按 appId 隔离，不能把不同 Home 宣称为已自动合并的全局单实例。

当前 Run 固定为 `schema_version=7`，Context 固定为 `octo.context-envelope/v3`，不增加旧协议回退。技能、插件及 MCP 程序的安装与更新由 HostApp 管理；本轮 MCP 连接配置通过 `octo.execution/mcp` 传入，由 adapter 转换，见 [Run MCP 合同](docs/25-run-mcp-context.md)。凭据不进入模型输入。旧 Channel context、聊天 SQLite 和相关业务实现已移出；参考快照位于同级 `octo-channel-design-reference/`，不参与构建。源执行事件使用有界内存窗口，不等待 durable ACK。

## 代码结构

```text
apps/
  cli/                             现有运维 CLI
  daemon/                          启动与配置入口
  adapter-host/                    Host 进程入口
packages/
  octo-runtime-daemon/              本地生命周期 SDK、IPC、可选模块装配
  octo-runtime-extra-channel-gateway/  Octo IM 专用连接、会话与结果回发
  octo-runtime-extra-channel-wecom/    企业微信专用连接、会话与 stream 回复
  octo-runtime-adapter-host/        共享执行 Host + NDJSON RPC
  octo-runtime-core/                执行配置解析
  octo-runtime-protocol/            统一执行和 Context 合同
  octo-runtime-adapter-*/           provider adapters 与共享 SDK
  octo-runtime-acp-client/          ACP transport
  octo-runtime-cross-service/       原生用户服务管理
```

每个模块的责任边界见对应 README；完整包索引见 [packages](packages/README.md)，可执行入口见 [apps](apps/README.md)。

## 安装与本地初始化

HostApp 决定安装方案。旧 Worker enrollment 安装脚本已迁入生态目录外的 `octo-runtime-worker-access/archive/installers`，不属于当前发行物。源码构建或全局 link 后，执行 `octo-runtime login` 初始化本地 Home，再按需要运行 `daemon install` 或 `daemon run`。详见 [安装说明](installers/README.md)。

## 源码开发与验证

要求 Node.js 24+。真实 provider 还要求对应 CLI 已安装并完成认证。

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

源码调试初始化本地 Home，再启动 daemon：

```bash
pnpm cli -- --home "$PWD/.tmp/runtime-home" login
pnpm daemon -- --home "$PWD/.tmp/runtime-home"
```

The local SDK initializes a stable identity for each profile without cloud enrollment. Profiles share the Home-level `machine_id`, an untrusted installation grouping label rather than a credential. One Home runs one daemon and adapter-host. Mutually untrusted users must use separate OS accounts. See [Runtime and machine identity](docs/runtime-machine-identity-spec.md) and [current local boundaries](docs/runtime-local-and-online-contract.md). The former Worker access package has been removed.

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

- [Event Context 与 Host 固定渲染：IPD-SE 设计基线](../docs/event-context-rendering-ipd-se.md)
- [业务会话、执行 Session 与本地 Reset：IPD-SE 实施与验证](docs/session-ownership-reset-ipd-se.md)
- [Architecture](docs/01-architecture.md)
- [Module And Transport Flow](docs/02-module-and-transport-flow.md)
- [Prompt And Workdir](docs/04-prompt-and-workdir.md)
- [Provider Adapters](docs/05-provider-adapters.md)
- [Runtime 与 OpenClaw 连接统一合同](docs/15-openclaw-external-agent-binding-design.md)
- [Transport And Multi-node](docs/09-transport-and-multinode.md)
- [Local Runtime Boundaries](docs/runtime-local-and-online-contract.md)

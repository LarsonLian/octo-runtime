---
type: Task
title: 删除 executionFeatures 自建能力机制开发计划
description: 按真实消费者拆分 Runtime、Adapter、桌面和 Worker 的改造顺序、验收与开发准备度评分。
tags: [architecture, adapter, protocol, testing]
timestamp: 2026-10-16T00:00:00Z
---

# 目标与状态

依据[宿主归属决定](../../journal/shared/2026-10-16-adapter-forwarding-ownership.md)及[现行规则](../../rules/adapter-metadata.md)，删除 `executionFeatures` / `execution_features` 自建标签及其驱动的发现、匹配和准入。宿主管理所用 Adapter 的功能；Adapter 对明确输入做原生适配和转发，返回真实结果。

状态为 completed（源码与当前可自动验证范围）。计划核对基线为 Runtime `5f7c825` 与当时生态工作树；实施从 Runtime `ce9df82` 开始，按用户要求每个 Feature 独立提交并推送。最终 Runtime `439a800`、Work App `c7d084c`、Worker `8a7d330`；完整提交、隔离 tree、检查和真实验收边界见[交付记录](delivery.md)。未发布服务。

用户后续授权全自动完成全部清理及关联缺陷，要求独立评估至少 95 分才实施。[自动执行计划](autonomous-plan.md)已补齐 F2/F3/F5、增加 F8/F9，并明确逐提交隔离验证；[独立复评](feasibility-review.md)均分 97.125、最低 96，实施门槛已通过。初始评分保留为计划制定时的历史记录，后续进展按 Feature 更新。

| Feature | 实施状态 | 证据 |
| --- | --- | --- |
| F4 删除 computer-use 标签专用探测 | completed | [实现与验证记录](../../journal/shared/2026-10-16-remove-computer-use-probe.md) |
| F1/F2/F3/F5/F6/F7 | completed | 类型、消费者、执行合同、watchdog、发行包及自动验收闭环完成，见[记录](delivery.md) |
| F8/F9/F10/F11/F12 | completed | MCP、错误分类、两次提交基线修复及正式环境文档同步；均经独立评估后实施 |

下文评分、待决项及 im-test 目标保留初始计划历史语义。后续修订与独立评估以[自动计划](autonomous-plan.md)为准；用户最新决定使用正式 `im` 域名并仅完成可自动验证部分，实际结果以[交付记录](delivery.md)为准。

## 责任与范围

| 检查 | 本计划约定 |
| --- | --- |
| 业务目标 | 宿主不依赖 Runtime 标签才能调用自己交付的 Adapter，消除声明与实现重复维护 |
| 决定权 | CLI、desktop 及其他 SDK 宿主管功能使用和界面；Adapter 执行具体合同；Worker 校验登记数据及权限 |
| 显式输入 | Adapter、输出模式、审批、图片、Provider session 和本轮 Context，不增加能力选择输入 |
| 合同内动作 | 格式、权限、身份校验，原生映射、真实失败、回答、取消、超时和资源清理 |
| 越界动作 | 标签匹配、自动改选引擎、扫描 Home 构造功能目录、静默丢参、扩大权限或建立替代能力表 |
| 受影响范围 | CLI/Playboard、SDK、12 个默认 Provider Adapter、Work App、本仓 Extra、Worker 登记消费合同 |

Run=7、Context=v3、Adapter transport=2 及审批协议独立保持。不删除 `protocolSupport`、`agentSources`、`mcp`、`workspace` 等其他合同，不重新设计 Runtime 身份或 Extra 归属。通信所需的 Provider 原生握手仍在 Adapter 内处理。保留 Home、身份、profile、配置、认证和运行状态；无删库、重建或历史数据清洗。geely 独立项目不在本次修改范围。

## 实际消费者

| 位置 | 当前作用 | 必须处理的影响 |
| --- | --- | --- |
| SDK metadata、ACP definition、Host descriptor / runner / serve | 类型、加载检查、发现和日志 | 无字段的 Adapter 必须可加载，不再生产或要求标签 |
| Host `#prepare` / `respondInteraction` | 审批、图片、回答标签检查 | 回到具体执行合同，保留调用身份、模式和实际 responder 校验 |
| `InvocationWatchdog` | 活动标签决定 canonical 输出是否刷新进度 | 不能让停滞执行无限存活或误杀正常执行 |
| Codex 创建过程 | 读配置后声明 `tool.computer_use` | 删除标签专用探测，保留真实 Home 和 MCP 使用 |
| Work App `adapterQualification` / `selectDeviceAdapter` | 标签筛选审批选项和可用引擎 | 直接删数组会使引擎列表变空，须落实宿主产品策略 |
| Worker `RuntimeAdapters` | `execution_features` 必填及元素检查 | 无字段数据被旧消费者拒绝，消费者须先更新 |

Runtime 入口为 `packages/octo-runtime-adapter-{sdk,host,acp,codex}/src` 和 `packages/octo-runtime-protocol/src/permissions.ts`。Work App 入口为 `src/renderer/src/lib/execution-context.ts`、`src/main/index.ts`、`src/main/agent-work-client.ts`、`src/shared/contracts.ts`。Worker 入口为 `internal/domain/runtime_capabilities.go`。源码存在依赖，不代表已有真实部署或接入验收。

## Feature 与评分

每项满分 100，表示当前开发准备度，不是成功概率或完成率。五项各 20 分：目标与归属、输入输出及异常合同、修改位置及依赖、回归保护、可复现验收。分数为本轮源码核对后的工程判断。

| Feature | 目标/归属 | 合同 | 路径/依赖 | 回归保护 | 验收 | 总分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| F1 删除自建字段和发现投影 | 20 | 20 | 20 | 20 | 20 | 100 |
| F2 审批、图片、交互回归具体合同 | 20 | 20 | 18 | 18 | 18 | 94 |
| F3 watchdog 脱离活动标签 | 20 | 18 | 17 | 17 | 16 | 88 |
| F4 删除 computer-use 标签专用探测 | 20 | 20 | 20 | 19 | 19 | 98 |
| F5 桌面使用宿主产品策略 | 20 | 18 | 18 | 18 | 18 | 92 |
| F6 Worker 接受无标签发现数据 | 20 | 20 | 20 | 19 | 17 | 96 |
| F7 构建、发行和真实环境闭环 | 20 | 20 | 18 | 18 | 16 | 92 |

等权平均约 94 分。F1 满分表示直接清理步骤明确，仍须等待依赖完成。F3、F5 的缺口先补齐，再做最终字段删除；分数变化须有新证据，不能为追求满分改评分口径。

### F1 删除自建字段和发现投影：100/100

- 修改 SDK `AdapterMetadata`、ACP `AcpAdapterDefinition`、Host descriptor、`runner.ts` 结构检查和 `serve.ts` 日志；删除所有默认 Adapter 静态数组及 imports。
- 删除协议 `executionFeatures` 常量、`adapterApprovalModes`、Node/browser 导出及发行类型透出；删除 `WATCHDOG_CAPABILITY` / `ACTIVITY_CAPABILITY` 声明和发现注入。watchdog 实现由 F3 保留。
- `list()` / `describe()`、CLI、daemon RPC 和 SDK 不返回字段，不生成空数组占位，不新增能力 struct、布尔表或注册中心。
- 验收：JSON loader、直接 import 的 SDK Host、CLI 和离线发行包均可加载无字段 Adapter；生产代码无符号消费，发现结果无字段。明确的历史说明和旧字段用例允许保留。
- 依赖 F2/F3/F5/F6；类型、默认实现和直接消费者在同一可构建变更中提交，不能留下半套导出。

### F2 审批、图片、交互回归具体合同：94/100

- 对 12 个默认 Adapter 列出审批三种模式、图片及 canonical/native 回答的当前原生参数或明确错误，用固定行为测试验收；测试案例不成为生产能力目录。
- 删除 Host 的标签判断，保留模式、调用身份和实际 responder 路由。限制放到 Adapter 现有命令构造、Driver 或共享 ACP 执行边界，不增加通用能力校验框架。
- 复用 ACP 的 assisted 拒绝及原生 image/MCP 检查，Codex/Claude/CodeBuddy 审批映射，OpenClaw/Antigravity/ZCode 现有拒绝；补齐此前仅靠 Host 图片标签保护的路径。在相关 Provider 操作前校验；握手才能确认的限制在握手后、发送输入前校验。
- 验收：合法输入到达 Provider，不支持图片不能静默变纯文本，不支持审批不能提升 full_access；回答仍核对活动 invocation、pending ID、期限、模式和授权，取消不变。
- 扣分及补齐：尚缺逐 Adapter 的图片拒绝位置和错误时机对照表；补齐该表及对应 fake Provider 用例后重新评分。

### F3 watchdog 脱离活动标签：88/100

- 修改 Host watchdog 创建位置和 `watchdog.ts`，保留 `AdapterInvocationContext.reportActivity` 的真实进度；不得改成静态 `supportsActivity` 字段或按 Adapter 名字判断。
- 先用现有 fake clock 对照有原生活动、仅 canonical、原生活动延迟三条轨迹，记录首帧、模型/工具静默、审批暂停和 run deadline。重复 usage、transport response、retry notice 及消费者拉取均不能当作有效模型进度。
- 方向为按本次执行的实际活动和事件维护进度，取消 Adapter 级标签开关。首次原生活动前 canonical 进度的处理时点，须用上述轨迹确定并写入合同。
- 验收：精确断言截止时刻和唯一终态；停滞仍超时，真实进度不误杀，审批暂停、总时限、取消和清理预算继续有效；不增加第二条执行流或无限状态。
- 扣分及补齐：尚未证明活动源切换可保持现有超时语义。这是首项技术验证；完成前不得只删 `nativeActivity` 参数或标记满分。

### F4 删除 computer-use 标签专用探测：98/100

- 删除 Codex 创建时 `detectComputerUseProvisioningSync` 调用和 `tool.computer_use` 声明；复核同步/异步 helper、解析类型及专用依赖，确认无消费者后一起删除，更新对应 README/test。
- 保留真实 `CODEX_HOME`、原生 MCP 加载、请求传递和审批；不修改、删除或重新 provisioning 用户配置。
- 验收：import/创建 Adapter 不再为展示功能读 `config.toml`，配置缺失或不可读不影响普通创建，实际 Codex/MCP 调用不变。
- 扣分及补齐：还需复核全部宿主及发行导出的 helper 引用，不能以本仓无消费者代替外部引用检查。

### F5 桌面使用宿主产品策略：92/100

- 删除 `RuntimeAdapter.executionFeatures`、main 映射、HTTP DTO 解析和 fixtures；修改 `execution-context.ts`、Composer、IM Channel 设置、Agent 执行设置和 QA 脚本的标签消费。
- 在现有 Work App 产品/组合代码内明确所交付 Adapter 的选项与审批策略，收敛到现有 `adapterQualification` 入口。该策略不回传 Runtime、不形成跨产品功能注册中心、不探测 Provider Home。
- 保持自动选择 `codex > claude-code > codebuddy > openclaw`，保留显式选择和 Agent mandatory，输入区仍只有一个模型/引擎入口；凭据只在 main，kit 继续经 Port。
- 验收：无字段发现仍可选引擎并提交，审批选项符合本产品交付实现，未知 Adapter 不按名称猜测或默认开放全部审批；切租户不复用旧配置。真实 renderer CDP 对 im-test 验证。
- 扣分及补齐：未知/第三方、远程不同版本 Adapter 的宿主策略尚未明确。本计划不擅自决定隐藏、禁用或全放开；固定内置版本部分可先开发，未知类型规则须在 F1 收尾前定稿。

### F6 Worker 接受无标签发现数据：96/100

- 删除 `internal/domain/runtime_capabilities.go` 的 `ExecutionFeatures` 字段及必填、长度、元素检查；保留 provider_type、available、来源、路径、身份和权限检查，追踪登记/查询、OpenAPI 和样例。
- 新消费者可忽略已有 JSON 的旧可选字段，但不匹配、不回填、不伪造能力；不重命名 capabilities 顶层容器，不清洗数据库，不增加能力门槛。
- 验收：新无字段请求有效，携带旧可选字段的数据按其余合同解析，错误身份/来源/路径/权限仍失败；检查真实 HTTP/WS 消费点。
- 如果实际接入使用此登记合同，先更新 Worker 消费者，再更新生产无字段数据的 Runtime/宿主。当前本地 SDK 无 Worker 注册工厂，不为验收新建工厂，也不能把内置发现当作远程注册证据。服务端只限 Worker。
- 扣分及补齐：尚未核定 im-test 已部署版本和登记链路，须先查真实部署；不部署 Channel、Loop 或 MCP Access。

### F7 构建、发行和真实环境闭环：92/100

- 将标签快照测试改为输入/原生参数/明确错误的行为断言，保留无字段发现和加载断言，更新 fixtures、SDK/Adapter README、当前 OKF 和样例；历史记录保留原时间语义。
- Runtime 执行 `pnpm typecheck`（含 build）、`pnpm lint`、`pnpm lint:names` 和全量测试，按现有脚本构建发行包，在隔离前缀验证 CLI/SDK 加载。禁止与依赖 dist 的桌面测试并行执行 clean/build。
- Work App 按仓库命令完成类型、vitest、test 构建；Worker 完成 `go test ./...`、build 和 OpenAPI 生成检查。按实际合同影响同步构建并重启受影响本地进程，保留所有既有状态。
- 真实环境固定 im-test，先确认地址。CLI/SDK 和桌面实际 daemon 分别验证文本、图片路径、受控审批和取消，CDP 核对引擎选择、无字段发现及 renderer 错误。外部消息只按现行授权使用隔离 QA 通道。
- 只有实际安装、认证且可执行的 Provider 记真实验收，其余列出 fake Provider 证据及未验证项。Worker 登记合同验收独立记录，不以本地执行代替。
- 扣分及补齐：Provider 就绪、测试身份、Worker 部署基线仍需实查，不能预先承诺所有真实链路通过。

## 实施顺序

1. 补齐 F2 行为表、F3 假时钟对照、F5 未知 Adapter 策略、F6 部署基线。已有信息能独立推进的部分继续执行，不为常规实现重复申请授权。
2. 先实施 F6 和 F5 消费者调整，能处理无字段结果并停止依赖标签；可忽略旧额外字段，但不再用于功能判断。
3. F4 无执行消费者，已先独立完成。完成 F2/F3 后，与 F1 的类型、声明删除形成可构建的 Runtime 提交。禁止推送会造成桌面空列表、Worker 拒绝登记或超时失效的中间态。
4. 完成 F7，三个仓库分别记录源码 SHA、构建、重启和实测证据后提交推送。消费者先于生产者发布；不触发未授权部署或数据重建。

## 完成标准

- 三个仓库的生产链路无该字段声明/消费，无替代能力表；保留的历史说明和旧字段用例有明确解释。
- 有效调用不失效，不支持的图片和审批不被静默接受；会话、交互、取消、超时及错误继续符合合同。
- 构建、回归、发行、真实 renderer 和 im-test 结果分别可追溯，缺项明确列出，不将计划评分写成验收分数。

计划制定阶段只检查了 OKF 格式、索引、链接和 diff。后续实施验证按 Feature 记录，不能将初始评分当作已验收。实际读取规则见 [context.yaml](context.yaml)。

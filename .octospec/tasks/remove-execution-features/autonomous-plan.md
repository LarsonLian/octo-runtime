---
type: Plan
title: executionFeatures 全量清理与关联缺陷自动修复计划
description: 在独立评估达到 95 分后，按 Feature 提交消费者迁移、执行合同、watchdog、Codex MCP 与错误分类修复。
tags: [architecture, adapter, testing, delivery]
timestamp: 2026-10-16T00:00:00Z
---

# 目标与实施门槛

用户要求全自动完成剩余清理，新发现的问题也评估修复；每个 Feature 验证后独立 commit、push。实施前先提交本计划给未参与设计的独立智能体，按下述标准评分。整体及每个待实施 Feature 均须达到 95/100；任一低于门槛，先修订计划并复评，不启动产品代码修改。

分数表示方案可执行性，不是完成率或成功概率。评分维度为目标与责任、具体实现、依赖与发布顺序、失败/安全行为、测试与交付，每项 20 分。评估人须列出源码证据、扣分理由和阻断项，不能为了达到门槛给分。评分记录写入本目录 `feasibility-review.md`。

计划建立时，F4 已由 `69341da` 提交并推送；本计划补齐[原计划](brief.md)中待决的 F2/F3/F5 方案，加入实际发现的 F8/F9。以下保留实施前的方案与门槛。

2026-10-16 最终状态：F1 至 F12 的源码修复与可自动执行的验收已完成，产品提交均已推送；具体提交、受测 tree、正式环境验证和验收边界见[交付记录](delivery.md)。远端 Worker 服务未部署。

## 责任与范围

2026-10-16 后续用户明确将本任务联调改为正式域名 `https://im.deepminer.com.cn`，并要求写入 Work App 文档。该决定覆盖本文早先的 im-test 联调目标；已有 im-test 请求仅保留历史证据，后续验证使用正式域名。用户同时选择仅完成可自动验证部分，无需等待独立 QA 登录。

- 宿主选择和交付 Adapter，决定功能入口。Runtime 不再维护 `executionFeatures`、`execution_features`、替代能力 struct、布尔支持表或跨产品注册中心。
- Adapter 适配明确输入并如实失败；必要的原生协议握手、格式、权限、执行身份、审批、取消和超时仍在各自边界处理。保留 `protocolSupport`、`agentSources`、MCP 和工作目录合同。
- Run=7、Context=v3、Adapter transport=2 保持独立；保留所有既有 Home、身份、profile、认证、SQLite 和运行配置。不删库、不重建、不写用户 Codex 配置、不安装新 Provider。
- 范围仅为 Runtime、Work App 和 Worker；geely 独立副本、并行 WebUI/个人工作区/服务拆分等工作不纳入。发现其他问题先记录实际影响；与本次链路直接相关且可安全修复的缺陷，补计划并通过同样评估后实施。

## 基线与并行修改

| 仓库 | 已核对基线 | 提交策略 |
| --- | --- | --- |
| Runtime | `69341da`，main；其他任务正在新增 WebUI/评估文档 | 仅提交本任务文件及共享文件中本任务的增量 |
| Work App | `8ba4332`，main；ahead 3，存在大量未提交修改 | 读取当前实现并保留其他工作；对混合文件按本任务变更单独暂存，检查 staged diff |
| Worker | `67de2b5`，main；origin/main=`79ac458`，本地领先 1 | 不接管未提交的服务拆分；能力字段修改单独暂存；保留已有提交 |

不清理其他任务的 index、日志、工作区或进程。每项提交前检查暂存内容；存在新并行变更时重新读取再合并。推送不 force；遇到远端前进先核对变更和安全集成。

### 独立提交的隔离验证

每项暂存后将该仓完整 index tree 导出到新建临时目录，形成 HEAD 加本任务 staged patch 的快照；不能直接在脏工作树上通过就提交。混合文件只包含本任务增量，例如 Worker 的 AgentSource 未提交迁移不能被误带，也不能成为新提交的隐含依赖。

需要跨仓依赖时，临时父目录按生态仓名建立对应源码快照，依赖仓使用本任务已提交 SHA（初次使用上表 HEAD）。在临时生态中执行锁文件规定的依赖安装，禁用安装脚本后显式执行所需 build/test；workspace 和 `link:../octo-runtime` 必须解析到临时生态，不能将主工作树的 node_modules/workspace 源链接当作提交验证。仅共享外部包缓存、Go 构建缓存，不共享可变内部 dist 或源码。临时目录只清理本任务自行创建的内容。

若最小 patch 在 HEAD 中无法独立构建，先调整为基于 HEAD 可成立的实现。确需前置代码时，列出确切依赖及最小变更，按同一独立评估门槛确认后先单独提交；不得将无关并行修改整批带入。记录隔离快照 tree/SHA 和命令结果，commit 后确认 `HEAD^{tree}` 等于已验证的 tree。F7 再用三仓最终提交快照完成联合检查。

## Feature 与顺序

| 顺序 | Feature | 具体产物与验收 |
| --- | --- | --- |
| 1 | F6 Worker 消费者 | 删除 DTO 字段及必填/长度检查，补无字段与旧额外字段用例，保留其他校验 |
| 1.5 | F10 桌面提交基线 | 修复隔离 HEAD 中已退役 ScenarioRequest 引用及问答翻译遗漏，建立 F5 可构建基线 |
| 按新增指令 | F11 正式环境与文档 | Work App AGENTS/README 与三份地址配置统一正式根服务；无凭据、无远端写入 |
| 最终提交基线缺口 | F12 测试桩合同同步 | 已提交的本机项目 API 与无标签 SDK 对应测试桩同步，恢复隔离基线完整验证 |
| 2 | F5 桌面产品策略 | 停止依赖标签，明确本产品交付类型的审批选项及未知类型处理，删除映射和 fixtures 字段 |
| 3 | F2 执行合同 | Host 删除标签判断，具体 Adapter 明确拒绝无法传递的图片/审批，保留真实 responder 及身份校验 |
| 4 | F3 watchdog | 按本次实际原生活动切换进度来源，修复审批计时与 MCP 工具进度遗漏 |
| 5 | F8 Codex MCP | 修复有效配置回灌导致原生类型错误，验证不改写真实 Home；同名覆盖不能静默深合并 |
| 6 | F9 错误分类 | 配置字段名含 timeout 不再误报超时，保留真实超时/网络重置分类 |
| 7 | F1 最终字段删除 | 删除类型、常量、12 个默认数组、发现/加载/日志投影及所有生产消费者 |
| 8 | F7 交付闭环 | 三仓构建测试、发行包、进程重启、真实 renderer/Provider/线上测试结果及文档收尾 |

每项完成后提交，不等全部做完才合并为一个提交；跨仓消费者先提交，最后删除生产字段。源码提交与实际远端部署是不同事实，不把本机测试写成云端版本已更新。本任务不主动发布 Worker 服务。

本任务交付目标是三仓源码、可构建提交、离线发行包和本地/线上测试接口证据，不包含远端服务部署。若已部署 Worker 仍拒绝无字段登记，则阻断对该 Worker 的生产者升级和注册切换：新产物仅在隔离验收使用，记录“远端待发布”，不得宣布生态部署或远端登记完成，也不得为满足验收修改真实 Runtime 登记数据。当前 SDK 无 Worker 接入工厂，不为此新造接入链路；HTTP/WS 具体消费合同仍由隔离提交测试覆盖。

## F6：Worker 接受无标签数据

修改 `internal/domain/runtime_capabilities.go` 的 `RuntimeAdapter` 和 `RuntimeAdapters`，只移除标签字段及对应约束。保留 provider_type 唯一性、available 显式布尔、可用时 path 必填、来源及元数据长度校验。未知旧可选字段按 JSON 既有规则忽略，不读取、不匹配、不回填；不迁移已有数据库 JSON。

新增/扩展 domain 测试：无字段可用/不可用 provider、旧额外字段、重复 provider、无效来源、缺少 available、可用但无 path；HTTP/WS 登记合同的现有测试继续运行。执行 `go test ./...`、`go build ./cmd/server ./cmd/migrate` 和现有 OpenAPI 检查。对混合文件只提交本次删除和测试，不将新增 AgentSource 等服务拆分差异混入。

### F6 隔离构建发现的提交依赖

`67de2b5` 的完整提交仍有旧服务消费者，被工作树中的并行服务删除隐藏。隔离构建确认 `agent_readiness_svc.go` 与 `runtime_limits.go` 直接读取已删字段；`run_svc.go` 仍以标签筛选候选，`agent_run_svc.go` 仍按图片标签拒绝输入。该发现使原 F6 尚不能提交，以下增量须先独立复评达到 95 分再实施。

- `runtimeSupportsAdapter` 直接校验 Run 合同及可用 Adapter，删除带 feature 参数的 helper；来源判断继续校验真实 `agent_sources`。
- `run_svc.go` 删除 RequiredExecutionFeatures 循环；`agent_run_svc.go` 删除图片标签预筛选及仅为该筛选存在的 `input_modality.go`。图片格式、大小、资源权限、授权候选及 Adapter 实际编码检查继续由原有边界承担。
- watchdog 仅校验数值和策略参数，删除静态标签门槛及其错误码分支；保留调用点的参数验证，不把可选策略识别伪装成已应用证据。改测无标签时可派发，非法预算仍在 claim 前拒绝。
- 与 Runtime 已提交的执行计划白名单同步：从 Worker 的 ResolvedExecutionPlan、JSON 校验、上下文生成及 executionProfile 删除 `required_capabilities`、`required_execution_features`、`provider_compatibility`，移除 react/approval/interaction/existing-target 的自动追加。continuity 哈希保留其余身份、会话、模型、审批、工作区及实际关键配置项，删除已无协议来源的 compatibility 占位，不修改会话数据或进行迁移。
- 同步执行计划 fixtures 和 OpenAPI，只删除对应三个字段；旧字段作为未知执行计划字段明确拒绝，与 Runtime 一致。Runtime 发现中的旧可选 `execution_features` 仍按前述规则忽略，两者合同不同。补候选授权、无标签派发、图片前置格式与旧计划字段拒绝回归。
- 被工作树删除的旧服务文件只在隔离快照中修改，并将受测 blob 暂存到本仓 index；不恢复这些工作树文件，不提交服务拆分的删除。完整测试/构建通过且受测 tree 与提交 tree 相等后才推送。

## F5：宿主决定可用选项

### F10：隔离提交基线的新增缺陷

桌面 `8ba4332` 与 Runtime `56f201f` 的固定快照安装和 Runtime build 均通过，桌面 typecheck 实测失败：仍引用 Runtime 已删除的 ScenarioRequest/assertScenarioRequest，且既有问答组件缺少五个翻译键。此项先独立复评达到 95 分，再于 F5 前单独实施提交。

移除 main conversation service 的失效 import/校验、shared SendInput 与 access-kit 的两处 scenario 可选声明，以及 access-kit client/preflight 的透传。文档 selection builder 只返回原有 context，useDocumentReview 不再附加场景；保持业务方显式组织本轮 Context、选区大小/格式、执行配置与权限校验。更新 object-selection 测试验证仅 context 及原有边界。只采纳混合文件中对应退役引用的最小删除，不带入本地项目、分页或插件等并行改动。

ApprovalCards 的五个翻译键实际误放在 `chat.activity.question`，将已有中英文对象移至 `chat.question`，保持文案和问答交互。全量测试另发现四个用例指定未声明的 jsdom；将 `local-context-attachment`、`object-source-button`、`object-context-transfer`、`run-context-receipt` 的环境注释与仓库已声明的 happy-dom 对齐，运行这些实际测试确认兼容，不新增依赖。Electron 在 ignore-scripts 安装后的初始化属于验收准备，显式运行已声明依赖的安装脚本后重测，不作为源码缺陷。运行隔离 typecheck、相关选区/问答/翻译测试、全量测试和 build:test；若再发现基线缺口，先记录实际错误并复评，不恢复 Runtime 已退役的协议来绕过检查。

保留现有 `adapterQualification` 作为 Work App 私有产品入口，参数只接收 type，不接收 Runtime 标签。以本产品已交付的执行实现确定选项：Codex、Claude、CodeBuddy 三种审批；ACP 系列、OpenCode、OpenClaw、ZCode 为 ask/full_access；Antigravity 为 full_access。模型入口沿用当前产品的类型选择，不扩大支持。

未知/第三方类型：仍可出现在设备发现中，但不自动选为聊天引擎、不默认开放审批，在本产品现有 unsupported 状态显示；只有宿主明确集成该类型后才开放。本规则只在 Work App 生效，不写入 Runtime，不变成通用能力表。远端同名类型以既有执行合同调用；具体版本不支持输入时必须由 Adapter 返回真实错误，不能以 providerVersion 字符串猜支持范围。

保留自动优先级 `codex > claude-code > codebuddy > openclaw`、用户显式选择和 Agent mandatory。不得在无法满足现有审批时静默切换为 full_access。调整 `execution-context.ts`、Composer、AgentExecutionSettings、ImChannelsSettings；移除 main/HTTP DTO/shared contracts 的字段、QA 标签筛选和测试 fixtures。测试无字段发现、已知/未知类型、禁用/不可用、显式选择、mandatory、审批协调及切租户守卫。

## F2：具体执行边界

| Adapter | 保持的审批行为 | 图片处理 |
| --- | --- | --- |
| Codex | ask/assisted/full_access 原生参数与原有回答桥 | 保持有序 image blocks |
| Claude / CodeBuddy | default/auto/bypass 原生映射 | 当前只传文本，执行前明确拒绝图片 |
| Hermes / Kimi / MCode / Qoder / QoderCN | ask 等待、assisted 拒绝、full_access 按当前请求自动应答 | 原生 ACP 握手确认 image 后映射，否则在创建 session/发送输入前拒绝 |
| OpenCode | ask ACP，assisted 拒绝，full_access CLI | 本次统一明确拒绝，保持此前 Host 不接受图片的实际范围 |
| OpenClaw / ZCode | ask/full_access 原生处理，assisted 拒绝 | 解析连接/创建客户端前明确拒绝图片 |
| Antigravity | 仅 full_access，其他模式明确拒绝 | 保留现有执行前拒绝 |

使用既有 `hasImageInput`，同时覆盖 recovery-only 图片。Claude command builder、CodeBuddy invoke、OpenCode builder/invoke、OpenClaw invoke、ZCode builder/公开 Driver 保护直接调用路径；不新增通用能力校验框架。

Host 只删除 `executionFeatures` 驱动的审批/图片/回答准入；继续校验输出模式、来源、冻结身份和非 full_access 的实际 responder 方法。回答继续核对活动 invocation、pending ID、期限、模式、重复/在途和授权范围，不复制新 pending 注册中心。行为测试替换标签快照，断言不支持时无 Provider/连接/输入副作用；运行 native-host、ACP/OpenClaw 审批和多模态回归。

## F3：按本轮观察维护超时

删除静态 `nativeActivity` 构造参数和 Host 标签消费；watchdog 内部状态记录本 invocation 是否已收到合法 `turn_started/turn_progress`。此前真实 canonical 进度可刷新，rpc_response/retry 不切换。收到首条合法原生事实后单向改用原生进度；切换动作和迟到 turn_started 不额外延长模型预算。canonical 继续维护工具、审批和终态，不重复用文本刷新原生进度。

canonical fallback 限于非空正文、模型步骤及工具执行变化；session、usage、notice、execution.update 和空占位不算进度。原生活动先校验 kind/method 再更新状态。等待审批时优先保持 waiting_approval；多审批最后一个结束才恢复。审批期间新建工具只扣除与暂停区间重叠的时间，不延长总 run deadline。Codex 当前 thread/turn 的 MCP progress 必须报告真实工具进度，不能被原生优先逻辑遗漏。

fake clock 精确验收：first=100 时 session/usage 不阻止 t100 超时；idle=100 时 canonical t0/80/160 导致 t260 超时；canonical t0/80 后迟到 native start t150 仍于 t180 超时；native start t0 后 canonical t90 不延时，真实 native progress t90 则到 t190；独立工具 a 的进度不延长 b；审批暂停和重叠区间准确；总时限固定；terminal 后 timer 清空，取消不替换已接纳终态，慢消费者不阻塞自主 timer。

## F8：Codex MCP 配置回传

只读原生复现已确认：合法 TOML 中未设置的 `tool_timeout_sec` 经 `config/read` 返回 null，完整 mcp_servers 回灌 thread/start 会转换成无效空串。真实 Home 的 node_repl 同样返回该字段 null。不得修写用户磁盘配置或建立 shadow Home。

目标为仅向 thread/start/resume 传本轮必要 overrides 和环境白名单，避免回灌本机 server 的完整 read model；原生既有配置由 Codex 自己加载。保持 run env 白名单、MCP headers 秘密引用及初始化后、输入前的错误处理。

原生隔离验证已确认同名 server overrides 是深合并，尤其 stdio/HTTP 互换会残留另一 transport 字段。本次对与原生配置同名的任何本轮 server 明确返回 `MCP_SERVER_NAME_CONFLICT`，包括同类型和 disabled 条目；在 thread/start/resume 和 prompt 前失败。宿主须为本轮连接选择唯一名称，不静默合并、不替宿主改名，也不宣称已完整替换原生配置。`config/read` 仅用于原生名称冲突检查及 stdio 的必要 env_vars 合并；本地 HTTP/disabled 条目不扩大白名单。无冲突追加和真实 Home 的既有 MCP 必须继续可用。该限制写入 MCP 规则和 README，不改公共请求形态。

测试覆盖 null/可选字段、原生配置保留、环境白名单、同名冲突、headers 不出 argv、thread 新建/resume、失败前未发送 prompt。真实 Codex 使用真实 Home 注入只读 MCP 工具，请求固定 im-test URL并返回随机校验值；检查配置摘要前后一致，仅报告类型/摘要是否一致，不输出凭据或配置正文。

## F9：配置错误与超时分开

修改 `packages/octo-runtime-protocol/src/failure.ts` 的泛化匹配：真实网络/超时错误保留，配置解析错误中的字段名 `tool_timeout_sec`/`startup_timeout_sec` 不触发超时。用错误 code、来源及明确 timeout 表达判定，不只查任意子串。不改 native 原生错误、不隐藏诊断。补配置解析、真正 timed out/ETIMEDOUT/ECONNRESET、既有 provider 状态码优先级的回归，保证无秘密进入公开错误。

## F1/F7：删除与交付

### F12：最终桌面基线的测试桩缺口

最终 Runtime `439a800` 已通过全量1009项，Work App 固定提交更新到并行任务的 `6d88e87` 后，全量出现4项失败且 tsc 报缺少 listLocalProjects/createLocalProject。这是该提交将项目改为本机 SQLite 后，tests/contracts.test.ts 的方法枚举/PreloadApi stub，以及 tests/new-conversation-context.test.ts 的 bridge mock 仍使用旧项目入口，不能由主工作树中尚未提交的其他改动补齐。

本项须独立评估至少95分后实施：只同步上述两个测试文件，将枚举与 typed stub 补齐两个已提交的 PreloadApi 方法，项目选择用例通过 listLocalProjects 返回现有项目fixtures；保留旧 agentAccess mock 中仍被其他测试使用的执行配置和绑定，不改产品代码、不降低断言、不上传项目、不增加云端回退。连同 F1 对 tests/im-channel-service.test.ts 的 capabilities/executionFeatures 两个失效 SDK fixture 字段删除，作为一次“测试桩与已提交合同同步”提交。测试只覆盖已有功能，新的错误先归因再复评。执行相关三文件、完整 typecheck:all/test:all 及 build:prod；严格核对提交tree等于受测快照，保留并行测试修改。

### F11：用户指定正式环境

仅将 Work App `.env`、`.env.test`、`.env.prod` 中已跟踪的非敏感地址配置统一到 `https://im.deepminer.com.cn`，Worker/Loop/Channel 留空按根服务派生；保留启动环境变量显式覆盖。README 的运行时配置段和末尾调试要求同步，新建 AGENTS.md 明确本项目覆盖上级旧 im-test 要求。依该项目最新说明，仅同步 package.json 的 dev/build 两条命令为显式 `--mode prod`，不将并行依赖或产品文档差异混入。独立复评后单独提交，核对 dotenv 四个键及 main config 解析单测，并执行 build:prod。临时 QA 也以正式地址重启。仅验证当前任务获授权的操作，不新增远端部署、发消息或重建身份；登录缺失不阻断自动可验部分。

F1 在上述消费者和行为已迁移后删除 SDK/ACP 类型、协议 constants/helper 与 browser/Node 导出、Host descriptor/runner/serve、默认 Adapter 数组及发现 watchdog 注入。CLI/SDK/daemon/Extra 的有效调用不能依赖空数组占位。生产代码搜索无自建符号；历史说明和明确旧字段兼容用例独立保留。更新当前规则、README、样例与测试，不机械修改原生 Provider capabilities。

按以下次序执行验证，禁止 Runtime clean/build 与依赖其 dist 的桌面检查并行：

1. Runtime `pnpm typecheck`、`pnpm lint`、`pnpm lint:names`、全量 Node 测试；已有 release pack 脚本生成发行包，在临时前缀检查 CLI 和 SDK 无字段加载。
2. Work App `pnpm typecheck`、`pnpm test`、`pnpm build:prod`；Worker 完成上文检查。并行工作引入的失败先定位归属，不能随意回滚或夹带修改。
3. 使用正式域名 `https://im.deepminer.com.cn` 联调：根站和 Worker health/ready 只读检查分别记录。真实 Provider 文本、图片路径、受控审批、取消及 MCP 分别记录证据；未安装 Provider 用 fake 覆盖，不能写成真实验收。
4. 重启本任务影响的本地 Host/daemon/桌面实例以加载新产物，保留身份和配置。优先复用/重启隔离 QA 实例；独立 CDP 端口、userData 和 `OCTO_WORK_HOME_ROOT` 避免影响并行实例。真实 renderer 确认 `getConfig().serverUrl` 为正式域名后检查无字段发现、默认引擎、审批选择和当前可自动验证部分；不等待用户登录，不发送外部消息。
5. Worker 登记以真实 HTTP/WS 合同测试和当前线上只读可达性分别记录。若线上仍是旧消费者，不声称已部署新代码，不以本地 SDK 执行代替登记验收；发布由实际接入方按消费者先行顺序进行。

每项提交记录改动、检查、SHA 和遗留项；最终汇总三仓提交及推送状态。没有完成的真实链路明确列出，不以评估高分替代验收。

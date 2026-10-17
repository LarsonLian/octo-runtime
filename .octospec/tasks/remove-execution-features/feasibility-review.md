---
type: Review
title: executionFeatures 清理计划独立可行性评估
description: 独立审查自动修复计划与实际源码，按五项维度评分并记录实施门槛。
tags: [architecture, adapter, testing, delivery]
timestamp: 2026-10-16T00:00:00Z
---

# 首次评估

评估对象为 [autonomous-plan.md](autonomous-plan.md)。评估人是未参与该计划设计的独立智能体，仅执行只读调查并编写本报告，未修改产品代码。分数衡量方案可执行性，不表示实现完成或真实环境验收通过。

结论：等权平均 95.75/100，但 F5、F6、F7 各为 94，未满足“整体和每项均至少 95”的门槛。暂不开始产品实现；主代理补齐下述提交验证约束后，由本评估人复评，无需再次请求用户批准。

| Feature | 目标与责任 /20 | 具体实现 /20 | 依赖与发布 /20 | 失败与安全 /20 | 测试与交付 /20 | 总分 | 达标 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| F6 Worker 消费者 | 20 | 20 | 17 | 20 | 17 | 94 | 否 |
| F5 桌面产品策略 | 20 | 20 | 17 | 20 | 17 | 94 | 否 |
| F2 执行合同 | 20 | 19 | 20 | 20 | 18 | 97 | 是 |
| F3 watchdog | 20 | 19 | 20 | 19 | 18 | 96 | 是 |
| F8 Codex MCP | 20 | 19 | 20 | 19 | 18 | 96 | 是 |
| F9 错误分类 | 20 | 19 | 20 | 20 | 18 | 97 | 是 |
| F1 字段最终删除 | 20 | 20 | 20 | 20 | 18 | 98 | 是 |
| F7 交付闭环 | 20 | 19 | 17 | 20 | 18 | 94 | 否 |

## 必须补齐的计划约束

1. 不仅检查 staged diff，也验证每个待提交内容本身。在临时目录从该仓库固定 HEAD 构建快照，施加本任务准备提交的 patch，确保不依赖其他未提交修改或未跟踪文件；只复制必要的依赖产物或配置，真实凭据不进入快照和提交。混合文件应按 HEAD 加本任务改动构造暂存版本，验证索引内容确实等于受测快照。禁止将其他任务整体文件暂存后宣称仅提交本任务。
2. 如果快照缺少产品前置代码或基线本身失败，明确区分既有失败与本任务引入的失败。已有必要前置提交可保留并列出 SHA；依赖其他未提交工作时，先在本任务内改为基于已提交合同的实现，或等待前置工作形成独立提交后重新确定基线、再验证。不得把并行服务拆分或 UI 重构作为隐含前置后推送不完整提交。F6 新测试尤其不能依赖 Worker 脏树中的 AgentSource 搬迁。
3. F7 明确区分三种结果：源码提交可独立构建、当前隔离实例真实执行、远端已部署消费者接收无字段登记。第三项若当前链路不存在，记录“不适用”及实际调用关系；若存在但仍是旧消费者，记录“未完成/发布依赖”及确认方式，不把 health 200 或 HTTP/WS fixture 通过当作远端接收证据，也不得宣称整条登记链路已验收。Runtime 生产部署必须以消费者先行条件为门槛。本任务可提交源码，不自行扩展为 Worker 部署。

## 逐项证据与扣分

### F6：94

`octo-agent-worker/internal/domain/runtime_capabilities.go:49` 定义标签字段，后续 `RuntimeAdapters` 将其作为必填；删除字段及相关检查、保留其他格式和来源约束的方案可直接执行。JSON 既有解析忽略未知字段，旧字段不会进入新 DTO，也不需要数据库改写。已有 `internal/domain/runtime_capabilities_test.go:44` 可扩展。

实际 `git diff` 表明同一文件另有未提交 AgentSource 定义新增，这是服务拆分为了补偿其他文件删除而产生的差异。计划虽说不纳入这些差异，却只承诺在当前工作树执行测试，没有证明单独提交及新增测试在固定 HEAD 上成立。依赖与测试各扣 3 分。完成隔离提交验证方案后可复评。

### F5：94

`octo-work-app/src/renderer/src/lib/execution-context.ts:7` 的 `adapterQualification` 直接从标签导出审批选项，`selectDeviceAdapter` 也按标签筛选。计划已明确已知类型、未知/第三方类型、不同远端版本的处理，且禁止静默升为 full_access；产品策略留在宿主，与 Runtime 禁止替代能力目录的约束一致。

实际桌面工作树有大量 UI、IPC、依赖及配置的未提交修改，Composer、main index、shared contracts 均是混合文件。只测当前工作树无法证明字段删除提交对现有 HEAD 可构建，或确定构建所需依赖是否已入库。依赖与测试各扣 3 分。其他责任和安全项不因该交付缺口重复扣分。

### F2：97

`packages/octo-runtime-adapter-host/src/index.ts:201` 起存在审批、图片、回答标签准入；保留 responder 方法和执行身份检查的边界正确。共享 ACP 已有 assisted 拒绝，OpenClaw、ZCode、Antigravity 有各自限制；Claude/CodeBuddy 当前命令映射不传图片，计划的显式拒绝防止移除 Host 检查后静默丢失图片。计划覆盖 direct builder、公开 Driver、recovery-only 图片和无 Provider 副作用路径，没有增加新的功能表。

具体实现扣 1 分：拒绝前副作用需按各入口实际 await/命令构造位置确认。测试扣 2 分：逐 Adapter 路径尚未执行行为断言；这属于实施时可验证的不确定性，不是未决产品决策。

### F3：96

`packages/octo-runtime-adapter-host/src/watchdog.ts:80` 构造函数接收静态 nativeActivity，当前 activity 在 kind/method 校验前更新工具，canonical fallback 会把过多事件当进度；审批结束对所有工具整体平移时间，存在重叠计时风险。计划明确先校验、按 invocation 单向切换、迟到 start 不续期、工具独立计时、审批暂停与总时限分离，列出精确 fake-clock 截止点，足以指导实现。

`packages/octo-runtime-adapter-codex/src/app-server.ts:1907` 的原生活动报告未覆盖 `item/mcpToolCall/progress`，而 canonical 路径存在相应分支；计划将其纳入修复，避免原生优先时工具真实进度丢失。

具体实现和安全各扣 1 分：动态切换与审批重叠仍需实现证明；测试扣 2 分：现有轨迹未执行。迟到 start 用例应显式设置足够大的 first-frame budget，避免先被首帧时限结束，测试才能检验预定模型预算语义。

### F8：96

`packages/octo-runtime-adapter-codex/src/app-server.ts:203` 读取有效配置后合并并回灌完整 mcp_servers，而 `environment.ts:21` 原本只需 stdio 的 env_vars。改为 delta 可直接消除将 read model 的 null 字段作为 write model 回传的问题，并保留用户 Home。

计划已对任何同名原生 server 明确拒绝，包含 disabled 和同 transport，且要求在 thread/start/resume/prompt 前失败；避免依赖原生深合并来完成替换。该行为需与 `.octospec/rules/mcp.md` 当前“合并本轮 server”的描述同步，计划已覆盖。每轮新 overrides 与原生加载分别处理，无需新增协议字段。

具体实现和安全各扣 1 分：需验证 config/read 名称冲突与 stdio 白名单合并的实际 write 参数。测试扣 2 分：真实 Home、resume 和调用随机校验值的证据仍待实施，不以既有故障复现代替修复验收。

### F9：97

`packages/octo-runtime-protocol/src/failure.ts:630` 和 `:660` 使用任意 timeout 子串，足以将配置字段误当超时。计划改为 code、来源和明确表达，且保留显式 RPC/watchdog code 与 provider HTTP 状态码顺序，修改范围准确。

具体实现扣 1 分：需验证词边界与错误 code 的规则不会遗漏真实错误。测试扣 2 分：待运行 provider/adapter 两域的配置、ETIMEDOUT、ECONNRESET 和状态码用例。

### F1：98

SDK/ACP 类型、Host descriptor/runner/serve、协议导出和默认数组均有实际消费者；先完成 F2/F3/F5/F6，再一次性移除声明与直接消费，顺序可执行。保留协议字段、原生 capabilities 和 agentSources，没有扩大为全协议清理。

测试扣 2 分：生产搜索、公共导出和离线发行包加载仍待实际执行；实施时尤其应区分历史记录、旧字段兼容用例与生产依赖。

### F7：94

计划将 Runtime 构建与依赖 dist 的桌面检查串行执行，明确使用 im-test、隔离 QA、真实 renderer、Home 保留和真实 Provider/fake 区分。Work App 当前代码确有 `OCTO_WORK_REMOTE_DEBUGGING_PORT` 配置入口；隔离 CDP 可执行。

依赖扣 3 分：没有将待提交快照的独立构建纳入交付前提。具体实现扣 1 分：线上 Worker health 仅证明可达，远端是否接受无字段登记须保持独立状态，不能被最终“全量完成”合并描述。测试扣 2 分：隔离真实链路尚未执行，Provider/凭据状态只能在执行时确认。实际环境失败应记录失败证据并评估修复，不得用评分或本地 fixture 替代。

## 复评入口

主代理仅修订计划，加入提交快照检查、前置依赖处理与登记状态标准后通知独立评估人复核。修订在报告复评达到所有 Feature 至少 95 之前不得用于产品实现。

# 修订后复评

复评重新读取 `autonomous-plan.md`，确认新增“独立提交的隔离验证”及远端发布边界。首轮报告和 94 分记录保留；本节为当前实施门槛结论。

新增约束已明确从完整 index tree 导出本任务提交快照，临时生态依赖固定已提交 SHA，锁文件安装不链接回主工作树，禁止共享可变内部 dist；验证后以 `HEAD^{tree}` 核对受测内容。缺少前置代码时优先改为基于 HEAD 的实现，确需最小前置变更则另经同一门槛评估并独立提交。因此不再将脏工作树测试视为独立提交的充分证据。

计划同时区分源码交付、隔离真实执行和远端部署/登记；旧消费者拒绝无字段登记时阻断对该消费者的生产者切换，允许隔离验收，不修改真实登记数据，不擅自部署 Worker。不存在 SDK 注册工厂时不为验收新建链路，真实 HTTP/WS 合同测试与线上可达性分别记载。该说明消除首轮 F7 发布状态不明确的扣分。

| Feature | 目标与责任 /20 | 具体实现 /20 | 依赖与发布 /20 | 失败与安全 /20 | 测试与交付 /20 | 总分 | 达标 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| F6 Worker 消费者 | 20 | 20 | 20 | 20 | 18 | 98 | 是 |
| F5 桌面产品策略 | 20 | 20 | 20 | 20 | 18 | 98 | 是 |
| F2 执行合同 | 20 | 19 | 20 | 20 | 18 | 97 | 是 |
| F3 watchdog | 20 | 19 | 20 | 19 | 18 | 96 | 是 |
| F8 Codex MCP | 20 | 19 | 20 | 19 | 18 | 96 | 是 |
| F9 错误分类 | 20 | 19 | 20 | 20 | 18 | 97 | 是 |
| F1 字段最终删除 | 20 | 20 | 20 | 20 | 18 | 98 | 是 |
| F7 交付闭环 | 20 | 19 | 20 | 20 | 18 | 97 | 是 |

等权平均 **97.125/100**，每项均至少 95，**可以开始按 Feature 实施、验证和独立提交**。这不是产品代码审查通过，也不是部署或验收完成。

F5/F6 的依赖项由 17 升至 20，依据是明确的提交快照、跨仓依赖和前置变更处理合同；测试项由 17 升至 18，依据是隔离验证消除脏树掩盖缺依赖的风险。仍扣 2 分保留实际构建/回归尚未执行的不确定性。F7 依赖项由 17 升至 20，依据同上及生产切换门槛；其余扣分和 F2/F3/F8/F9/F1 的扣分保持首轮说明，不因文档修订虚增实施证据。

执行时必须检查初始暂存区归属，确保导出的 index tree 只含本任务准备提交的增量；若已有他人暂存内容，使用本任务独立 index 构造快照，不能把他人内容作为“完整 index tree”一并提交。每项真实测试失败或新发现缺陷继续记录和评估，未完成的真实链路仍按计划列为未完成，不以本报告分数替代。

# F6 隐藏消费者增量评估

独立审查 `autonomous-plan.md` 新增的“F6 隔离构建发现的提交依赖”，并只读检查隔离快照 `/var/folders/76/39mbswr923z8ykj89093khl00000gp/T/octo-features-ejzjaB/octo-agent-worker`。本次不是对已完成产品修改的代码评审；扩展实现尚未开始。

评分：目标与责任 20、具体实现 19、依赖与发布 19、失败与安全 19、测试与交付 19，合计 **96/100，可以实施该 F6 增量**。其余 Feature 保持前次复评结果。没有必须先由用户决定的产品分歧，仍须依计划验证后才提交。

## 独立证据

- `internal/service/agent_readiness_svc.go:32` 的 helper 直接读取 RuntimeAdapter.ExecutionFeatures；`runtimeSupportsAdapter` 当前只是它的空 feature 包装。将其改成校验 Run 合同、已知 Adapter 和真实 available 的直接判断，保留 `runtimeSupportsAgentSource`，是删除字段后的必要依赖修复。
- `internal/service/run_svc.go:325` 逐个检查 RequiredExecutionFeatures；其前后分别保留租户/owner/online、Adapter、来源和 watchdog 参数检查。删除标签循环不应影响这些独立约束，计划已明确。
- `internal/service/agent_run_svc.go:165` 先调用 InputImageParts 做格式/大小校验，`:236` 后才按 input.image 标签预筛选。移除后者及 `input_modality.go` 不要求移除前者。授权候选在 `runtime_selection_svc.go` 按 actor、space、owner 和 teamspace membership 建立，必须继续保留，计划对此已有回归要求。
- `internal/service/runtime_limits.go:60` 的额外门槛读取 executionFeatures；`validateRuntimeLimits` 有独立的字段、整数范围和 observe/enforce 校验。只删门槛、保留调用点的数值/策略校验，能够同时解决编译问题和过期准入逻辑，不能将校验成功当作远端已应用策略的证据。
- `internal/domain/context.go:127`、`:144`、`:152` 仍定义三个过期字段，context 解析自动追加审批/interaction 标签，`runtime_selection_svc.go:73` 自动追加 react/existing-target。Runtime 当前提交的 `assertResolvedExecutionPlan` 白名单与 schema 均不接受这些字段。同步 Worker 类型、校验、生成、profile、fixtures 和 OpenAPI 是与当前合同一致的修复，不是新增执行协议。
- `internal/service/context_svc.go:20` 仍将 ProviderCompatibility 放入 continuity 身份哈希，而 `internal/repository/work_repo.go:93` 根据哈希变更决定 Provider binding/epoch。计划保留存储字段和全部真实身份、模型、审批、工作区及关键执行配置，避免把字段清理扩为会话数据清洗。原哈希的 provider 使用 omitempty；原值为空时删除该占位应保持同一 JSON 及哈希，适合作为定向回归断言。
- 主工作树中的相关服务文件由并行任务删除，隔离快照仍包含它们。仅在快照编辑并把受测 blob 更新到本任务 index，可以提交最小修复而不恢复主工作树文件或夹带服务拆分删除。提交 tree 与受测 tree 的一致性仍是必要条件。

## 扣分与实施检查

具体实现扣 1 分：间接消费者和 fixtures 的完整性需要全量搜索、编译和测试最终确认，不能仅以直接字段引用消失结束。依赖与发布扣 1 分：本次修复覆盖已提交旧服务路径，真实环境尚未部署该消费者，发布顺序约束继续有效。

失败与安全扣 1 分：三字段按未知执行计划字段拒绝后，含旧字段的历史冻结请求可能不能被新解码器读取；计划明确拒绝旧合同且不做迁移，实施记录须如实注明这一发布风险。不得为消除失败而删除历史请求、重建数据库或清空 Provider 会话。旧 Runtime 发现额外字段被忽略与旧执行计划字段被拒绝是两个不同合同，测试不得混同。

测试与交付扣 1 分：增量回归尚未运行。实施至少确认无标签可派发、错误租户/owner/source 仍失败、图片前置格式仍拒绝、非法预算在 claim 前失败、旧计划三个字段分别拒绝，以及无 compatibility 值时 continuity 哈希与原算法一致。继续执行完整隔离测试/构建与 OpenAPI 检查；仓库中 ExecutionTarget 等非直接依赖不因本次增量评估获得额外清理授权。

以上均为已定义边界内可验证的实施风险，不构成低于 95 的未决方案阻断。本结论不授权远端部署、数据库迁移或修改既有 Runtime 身份与配置。

# F10 桌面提交基线增量评估

独立读取新增 F10 计划、`/tmp/octo-execution-features-app-baseline-typecheck.log`，并核对固定桌面快照 `/var/folders/76/39mbswr923z8ykj89093khl00000gp/T/octo-features-IXULIK/octo-work-app` 的实际源码和语言包。此次仍仅写报告，未修改桌面产品源码。

评分：目标与责任 20、具体实现 19、依赖与发布 20、失败与安全 20、测试与交付 18，总计 **97/100，可以在 F5 前独立实施并提交 F10**。其他 Feature 保持既有评估结果。

## 证据与边界

typecheck 日志中的 ScenarioRequest/assertScenarioRequest 缺失均对应实际旧引用：`src/main/agent-conversation-service.ts:5` 与 `:120`、`src/shared/contracts.ts:869`、access-kit 两处输入合同，以及 `docSelectionBuilder.ts` 的 import/构造。access-kit client/preflight 和 `useDocumentReview.ts` 还有类型错误修复后仍须删除的透传路径。计划已经覆盖这条完整生产调用链，没有选择恢复 Runtime 已删除的协议。

`docSelectionBuilder.ts` 当前把文本构造成显式 inline Context，再附带 scenario。删除后者仍能保留 document_id、选区原文、来源、32 KiB UTF-8 上限和 Context 协议校验。`useDocumentReview` 的执行配置、preflight、身份检查、重试与 clientRequestId 可继续沿用；不能借本次清理把材料构造移入 Host 或重新引入场景自动注入。main 的 assertContextEnvelope、禁止不可信 octo.control、owner/租户作用域和实际执行合同也须保持。计划明确保留这些边界。

`ApprovalCards.tsx:117` 起实际引用 `chat.question.title`、`additional`、`answer`、`cancel`、`submit` 五个键。独立解析两份 JSON，`zh_CN`、`en_US` 均不存在 chat.question。补对应中英文文案可直接修复类型错误与原始 key 回显；无需变动回答收集、密码输入、过期/断线禁用、审批 pending 或提交行为。现有 approval-cards、approval-submission 和 i18n 测试可复用。

固定快照的 Runtime 已构建，桌面 typecheck 真实失败，因此这是有证据的 F5 前置缺陷，而不是为夹带其他工作扩大范围。只提交混合文件里的退役引用和五个键，继续采用受测 index tree 快照；不得夹带主工作树中的分页、插件、项目或配置改动。

## 扣分与执行要求

具体实现扣 1 分：计划首段称“六个翻译键”，后续明确枚举五个，实际也只有五个，主代理应将首段改成五个，避免交付记录前后冲突。另有 `scripts/test-object-mentions-live.mjs` 读取旧响应的 context.scenario 作为诊断，实施时按既有 F7 QA 清理范围处理，不把诊断字段保留误写成生产协议仍可用。

测试与交付扣 2 分：尚未运行修复后的隔离类型/全量测试与 build:test，也未取得 UI 真实 renderer 证据。按原计划 F7 对 im-test 的 CDP 要求，在交付记录核实五个文案可用、选区仍作为本轮 Context 传入、没有恢复 scenario 透传；不能仅以 typecheck 通过宣称真实执行已完成。翻译只改文本时不必另造与实现镜像的新测试，但现有问答/翻译用例必须通过。

除上述可直接纠正的笔误和实施验证外，没有需要先补产品决定的阻断项。F10 的通过不扩展为删除业务自有同名 scenario 概念、重建会话存储或恢复旧协议的授权。

## F10 文案路径与测试环境修订复评

更正前节表述：两份语言包缺的是组件要求的 `chat.question` 路径，并非五条文案物理缺失。独立解析固定快照确认，原值均位于 `chat.activity.question`：中文为“需要你的回答 / 补充或其他回答 / 你的回答 / 取消回答 / 提交回答”，英文为对应完整五项。源码搜索未找到使用旧嵌套路径的消费者。将整个已有 question 对象移到 chat 直属，保持原文案，比另建重复对象更小且正确；前节“均不存在 chat.question”的路径判断仍成立。

独立检查测试日志及源码，package.json 仅声明 happy-dom，四份测试首行却指定 jsdom，日志显示全部因 ERR_MODULE_NOT_FOUND 未启动。`local-context-attachment`、`object-source-button`、`object-context-transfer`、`run-context-receipt` 只使用 React act、标准 DOM、事件、location 和 bridge mocks，未见依赖 jsdom 专有 API。将四行环境注释改成仓库其他 UI 测试使用的 happy-dom，不增依赖、不跳过断言，方案可执行；不能在未运行前宣称其行为测试已通过。

Electron 二进制缺失来自 ignore-scripts 安装，显式执行锁定 Electron 依赖的安装脚本属于隔离环境准备，无需改产品代码或扩大 Runtime 安装决策权限。

本次两项修订维持 F10 **97/100**，仍达到实施门槛。维度为目标与责任 20、具体实现 19、依赖与发布 20、失败与安全 20、测试与交付 18。具体实现保留 1 分针对 DOM 环境差异待实际用例验证，测试与交付保留 2 分针对完整验证尚未完成；移除旧笔误不被用来虚增完成证据。主代理继续执行四份实际用例、全量检查和既定真实 renderer 验证；失败时保持断言并定位差异，不以换环境掩盖错误。

# F11 正式环境与文档评估

依据主代理转达的用户最新明确指令，后续联调使用 `https://im.deepminer.com.cn` 并更新 Work App 文档，登录相关只完成当前可自动验证部分。计划开头已记录该决定覆盖此前 im-test 目标；此前报告中的 im-test 内容保留为当时要求和历史证据，不继续约束新验证，也不改写为正式环境已验证。

评分：目标与责任 20、具体实现 20、依赖与发布 20、失败与安全 20、测试与交付 18，合计 **98/100，可实施并独立提交 F11，无阻断项**。

独立检查 Work App diff，`.env`、`.env.test`、`.env.prod` 仅包含 server_url、octo_worker_url、octo_loop_url、octo_channel_url 四个非敏感地址键及注释。统一正式根服务并清空三个覆盖，符合 main config 现有派生逻辑；显式启动环境变量仍优先。README 地址/运行命令/调试段和新 AGENTS.md 已解释正式环境目标、build:test 模式与服务环境的区别及现有身份和数据保留。README 同时含其他并行产品改动，本提交只暂存本任务环境段；package.json 中依赖新增等无关差异也不得混入。

测试与交付扣 2 分：计划中的 dotenv 四键检查、main config 单测、隔离 build:prod 和实际重启配置核对仍需取得本次结果。不能以当前脏树新增的配置用例通过代替独立提交快照验证。若提交中的 AGENTS.md 要求默认 dev/build 显式采用 prod mode，应同步核对待提交 scripts；仅工作树里的命令修改不能视为已提交行为，必要时只纳入对应两行的本任务增量。

新授权允许正式地址联调，不额外授权服务部署、外部消息、修改他人数据、安装 Provider 或重建 Home/Runtime 身份/数据库。登录不足时继续完成无需登录的检查，记录受限项，不将未执行链路宣称通过。本评估不要求用户再次确认已明确的环境选择。

# F12 已提交合同的测试桩同步评估

独立读取 F12 计划、`/tmp/octo-features-f7-app-typecheck.log` 与 `tests.log`，并核对 Work App `6d88e87` 的隔离快照和实际测试 diff。评分为目标与责任 20、具体实现 20、依赖与发布 20、失败与安全 20、测试与交付 18，合计 **98/100，可以实施 F12，无阻断项**。

`src/shared/contracts.ts` 已定义 localProjectsList/localProjectsCreate 两个通道及 listLocalProjects/createLocalProject 两个 PreloadApi 方法；preload 与 main 各有对应接线。`tests/contracts.test.ts` 的 methodNames 与 typed stub 均遗漏这两个方法，日志分别报告 186 对 188 的枚举计数差异和 TS2739。补齐方法枚举及桩对象即可保持 1:1 守卫；不能修改预期计数公式、删通道或取消类型检查来避开失败。

`usePersonalWorkProjects.ts` 已通过 `octoWork.listLocalProjects(owner)` 查询个人项目，而 `tests/new-conversation-context.test.ts` 仍只在 agentAccess.listWorkProjects 返回现有 A/B fixtures，导致项目列表和重试后的名称断言三项失败。把个人项目 fixtures 同步到已提交的新 bridge 方法，与产品实际调用关系一致；继续保留 agentAccess.listWorkspaceBindings、执行配置和 preflight mocks，原有项目选择、清空、文本/图片保留及失败重试断言均不减少。已有 personal-work-projects 测试也使用相同新入口，支持这是测试桩过期而非需要云端回退的产品缺陷。

隔离快照当前仅有 `tests/im-channel-service.test.ts` 一处修改，删除模拟 Adapter 中的 capabilities/executionFeatures 空数组，保留 type、available、agentSources；与 F1 已删除的 SDK 合同相符，不改变测试动作和断言。这三个测试文件合并为一次测试桩同步提交具有一致范围；须只提交本任务增量，不能直接纳入主工作树其他测试重写。

测试与交付扣 2 分：同步后的三文件定向测试、完整 typecheck:all/test:all 和 build:prod 尚未完成。最终提交 tree 应与受测快照一致；若仍失败，应重新归因并按用户门槛评估新增修复，不靠放宽断言宣布通过。该通过只覆盖测试桩，不授权产品逻辑、远端数据或其他并行功能修改。

# Antigravity 接入改造：IPD-SE 需求与设计基线

文档编号：`AGY-SE-BL-01`。版本：`0.2`。日期：2026-10-10（Asia/Shanghai）。

状态：已在 Harness 与 Work App 当前分支实施代码改造。自动验证结果见第 10 节；真实账户调用和 Electron 线上测试环境闭环尚未通过，不能据此认定产品验收完成。本文的“必须”是验收要求，不自动表示相应能力已完成实机验证。

本文面向 Harness、Work App 的开发与测试人员。参照华为 IPD-SE 的需求分解、系统分配、基线管理和验证闭环思路，采用“业务目标 → 用户需求 → 系统需求 → 模块设计 → 验收证据”的追踪链。文中的 DCP/TR 是本项目拟采用的评审门禁，不声称已经完成华为正式流程或评审。

## 1. 新增目标与范围

### 1.1 业务目标

让用户在现有 Octo 执行体系中，使用已经安装并配置的 Antigravity CLI 调用其可用模型。用户能够在 `octo-harness-work-app` 的设置与聊天入口选择 Antigravity，并观察回答、工具执行、会话续接与终态。

Antigravity 是执行引擎，Gemini 是用户希望使用的模型系列。引擎标识统一为 `antigravity`，展示名称统一为 `Antigravity`，可执行程序为 `agy`。不得把 Antigravity 登记为 Gemini CLI，也不得以其他引擎的名称或图标代替。

### 1.2 用户输入与范围边界

- 已知条件：用户说明 CLI 已完成安装与配置，日常使用别名 `agy-yolo="agy --dangerously-skip-permissions --mode accept-edits"`。
- 实现参考：本机 `/Users/lvsijia/github.com/multica-ai/multica` 的 Antigravity backend。
- Logo：采用用户指定的 [LobeHub Antigravity](https://lobehub.com/icons/antigravity) 彩色渐变 A 形版本，与用户截图保持一致；棋盘格是透明背景预览，不属于 Logo。
- 本次交付：Markdown 改造文档及当前分支代码。用户已授权直接改造并允许破坏性更新；最新指示是先完成代码，暂缓账户排查与实机联调。
- 已实施范围：Harness adapter、加载与依赖打包、共享图标、Work App 设置、聊天选择、规范事件转换与相应测试。
- 本轮不规划独立 Gemini CLI adapter、Antigravity IDE 自动化、第三方模型网关接入或新执行协议。MCP、附件、技能、子代理等扩展仅在有真实接线与证据时声明支持，不因 CLI 存在对应功能就默认具备。

## 2. 已检查的输入基线

### 2.1 代码与环境快照

| 对象 | 检查结果 | 证据与适用边界 |
| --- | --- | --- |
| Harness | HEAD `b0d2faaedf63919c5b1c8760357f685148fb5770`；检查时工作区干净 | 本文新增前的代码起点；不是远端最新分支承诺 |
| Work App | HEAD `bfe1fe39c31e47085aa11004dffe458b4b003d99`；检查时工作区干净 | 相邻目录 `octo-harness-work-app` |
| multica | HEAD `1d94166dc2d33b3720e21f90853f8ba333714185`；检查时工作区干净 | 仅作实现参考，不修改该仓库 |
| 本机 CLI | `/Users/lvsijia/.local/bin/agy`；`agy --version` 返回 `1.3.3` | 已执行版本与帮助查询；不等于登录、额度和模型执行已通过 |
| CLI 参数 | 帮助列出 print、stream-json、conversation、model、effort、mode、log-file | `--mode` 可取 `accept-edits` / `plan`；具体执行效果待真实调用验证 |
| CLI 超时 | 本机帮助说明 `--print-timeout` 默认 `0s`，`0` 等待到本轮完成 | 与 multica 中针对旧版的“五分钟默认、24 小时替代无上限”假设不同 |
| 模型目录 | 已尝试 `agy models`，观察超过 60 秒仍停留在 `Fetching available models...`，随后终止探测 | 本次没有取得可用模型 ID；原因未定位，不判定为“未登录”或“没有模型” |
| 图标来源 | 用户指定展示页首次抓取返回 404；已取得 LobeHub 官方仓库彩色 SVG | 来源与校验值见第 10 节；应用使用内联素材，不在线加载 CDN |

实施开始前已重新核对上述 HEAD 与本地差异，起点未改变；CLI 为 1.3.3。后续若起点改变，先审查差异，再更新本文；不得用本次快照覆盖并行工作。

### 2.2 改造前系统事实与约束

| 编号 | 已核实事实 | 改造含义 |
| --- | --- | --- |
| B01 | [adapter 清单](../config/adapters.json) 当前登记 11 个类型，没有 `antigravity` | 必须新增包与清单项，并同步根包、Host 依赖及部署产物 |
| B02 | [SDK](../packages/octo-harness-adapter-sdk/src/index.ts) 提供 `metadata`、`probe`、`invoke`；没有统一的模型目录查询方法 | 不得在方案中假定已有 `listModels` 接口；动态模型目录需单独设计传输合同 |
| B03 | [Host](../packages/octo-harness-adapter-host/src/index.ts) 按 `executionFeatures` 检查审批模式；非 `full_access` 要求交互响应接线 | 仅支持无提示 CLI 执行时，不能声明 `ask` / `assisted` 已可用 |
| B04 | [协议](../packages/octo-harness-protocol/src/context.ts) 为 Run `schema_version=7`、Context `octo.context-envelope/v3` | 沿用当前协议和统一编译产物；不新增旧版本识别、转换、双写或版本协商 |
| B05 | [daemon 本地 SDK 构建](../packages/octo-harness-daemon/scripts/copy-manifest.mjs) 复制 Harness 清单；[App 打包脚本](../../octo-harness-work-app/scripts/prepare-embedded-runtime.mjs) 从相邻 Harness 准备运行时 | 源码新增成功不等于桌面内置 Runtime 已更新；必须构建、重启并验证本地执行，仅启用云端接入时另验注册 |
| B06 | [共享图标包](../packages/octo-harness-adapter-icons/README.md) 输出内联 SVG；[App 图标解析](../../octo-harness-work-app/src/renderer/src/lib/provider-icons.ts) 消费该包 | Logo 只维护一个来源，不在 App 重复拷贝一份 |
| B07 | [模型设置](../../octo-harness-work-app/src/renderer/src/settings/ModelSettings.tsx) 按 Runtime 上报的 adapter 生成引擎面板 | 不能只向静态列表加名称；必须确保实际发现、可用状态与设置面板贯通 |
| B08 | [模型配置](../../octo-harness-work-app/src/shared/model-settings.ts) 支持每个 Runtime / 引擎的原生模型 ID 与默认模型；[能力判断](../../octo-harness-work-app/src/renderer/src/lib/execution-context.ts) 目前仅向 Codex、Claude Code 开放 model / effort | 必须补模型资格与调用链测试；effort 是否开放取决于实测，不与模型选择捆绑承诺 |
| B09 | 默认引擎优先级为 `codex > claude-code > codebuddy > openclaw`，单一可用引擎另有回退逻辑 | 增加 Antigravity 显式选择，不改变既有优先级；保留单引擎逻辑并验证权限选择 |

现有 [Adapter 开发指南](08-adapter-authoring.md) 与 [执行体验基线](adapter-experience-refactor-baseline.md) 继续适用。旧方案、历史样例或注释若与当前 Run 7 / Context v3 合同不同，以当前代码合同及上级 `AGENTS.md` 为准。

## 3. 需求分解与模块分配

以下系统要求已纳入本次代码改造范围。代码完成状态与实机资格状态分别记录，不以用户授权代替测试证据。

| 用户需求 | 系统要求 | 承担模块 | 验收 |
| --- | --- | --- | --- |
| UR01 复用本机已安装的 Antigravity | SR01 发现真实 `agy` 路径与版本；通过无交互子进程执行一轮请求 | 新 adapter、Host | AC01、AC02 |
| UR02 使用自己的 Gemini 模型及日常执行方式 | SR02 支持原生模型 ID 或 Provider 默认；在 `full_access` 下传递 skip-permissions 与 accept-edits | adapter、配置编译链、App 设置 | AC03、AC04 |
| UR03 能观察完整执行结果 | SR03 映射公开文本、工具、usage、会话和唯一根终态，正确处理失败与取消 | adapter、既有 Host / Worker 投影 | AC05–AC08 |
| UR04 测试应用和设置可用 | SR04 在设置与聊天选择中展示真实可用状态；保存、重启、切换会话后正确恢复配置 | Work App、embedded runtime | AC09、AC10 |
| UR05 使用指定品牌标识 | SR05 共享包提供 LobeHub 彩色 Logo，所有 Antigravity 入口一致 | 图标包、App 图标消费与测试 | AC11 |
| UR06 不破坏现有引擎 | SR06 保持现有协议、默认优先级、mandatory 约束和已支持引擎行为 | Harness、Work App 回归 | AC12 |

## 4. Adapter 设计与 multica 参考取舍

### 4.1 包与执行边界

新增包 `@mininglamp-oss/octo-harness-adapter-antigravity`，目录 `packages/octo-harness-adapter-antigravity/`，导出 `antigravityAdapter` 与 `createAntigravityAdapter`。清单 `type`、`metadata.type`、App 选择值统一为 `antigravity`。

采用独立 CLI adapter，通过 `agy` 的 `stream-json` 输出转换为现有 CanonicalEvent。multica 的 Go backend 用于核对原生语义和回归场景，不将其内部消息结构直接搬入 Octo 协议，也不将 `agy` 当作 ACP 服务。

启动时必须使用程序路径与参数数组，不经过 shell 解释。`agy-yolo` 是用户的 shell 别名，不作为后台可执行文件名。允许通过既有 factory/options 机制指定命令路径，验收时检查 Electron 启动环境能否找到 `/Users/lvsijia/.local/bin/agy`；该个人路径不得硬编码为所有用户的默认路径。

### 4.2 参数、权限与上下文

| 项目 | 本次实现行为 | 必须验证的边界 |
| --- | --- | --- |
| 调用形态 | stdin 单轮消息；固定 `--input-format stream-json --output-format stream-json`；取得 result 后关闭本次进程 | 不启动依赖 TTY 的交互模式 |
| 权限 | 首期仅声明 `full_access`；该模式采用 `--dangerously-skip-permissions --mode accept-edits` | `accept-edits` 是 CLI 执行模式，不等于 Octo 的 `assisted`；不支持的审批模式在启动前拒绝，不自动升级权限 |
| 模型 | 显式模型值作为一个 `--model` 参数传递；Provider 默认时省略该参数 | 不把展示名、Gemini 泛称或网关模型 ID 猜测为原生模型 ID；带空格值仍是一个参数 |
| 推理强度 | adapter 可原样传递合法 effort；Work App 不开放推理强度控件，待实机资格验证 | adapter 拒绝未知值；UI 不声明模型已支持 effort |
| 工作目录 | 使用编译后工作目录作为 `cwd`，不追加 `--add-dir` | 不改变已校验的工作目录或扩大到其他目录 |
| 会话 | 从结构化 `conversation_id` 产生 `session.update`；续接使用 `--conversation <id>` | 不使用 `--continue` 续接“最近一次”会话，以免不同用户或会话串线 |
| 超时 | 固定 `--print-timeout 0`；既有 Harness watchdog 管理执行预算；取消复用 SDK 的 POSIX 进程组 TERM，1 秒后升级 KILL | 不照搬 multica 的 24 小时替代值；Windows 后代回收尚无实机资格证据 |
| 自定义参数 | 对输出格式、prompt、conversation、model、权限、日志及超时等受管参数进行冲突校验 | 用户扩展不能覆盖平台 mandatory、改变输出协议或绕过会话隔离 |

`invoke` 消费统一编译产物，不重新解释原始 ContextItem。multica 通过工作目录中的 `AGENTS.md` 传递运行指令；本 adapter 不创建或覆盖该文件，也不改写全局 CLI 配置。

已依据 [Antigravity 官方 headless 文档](https://antigravity.google/docs/cli/headless/) 固定 stdin 合同：`{ "event": "user", "message": { "content": ... } }`。CLI 无独立 system-prompt 参数，因此把控制指令和用户输入作为两个带标签的 text block 放入同一 user 消息；这属于明确的 user-channel 指令降级，不提供原生 system role 的隔离保证。`provider.input` 记录实际输入载体；自动测试验证消息结构及用户文件保留，真实账户调用仍待验证。每次调用拥有独立 normalizer 和临时日志目录，完成、失败与取消均清理目录。

共享 `InvokeRequest` 已删除动态 MCP、skills 和 skillRoots 字段，旧字段在协议边界直接拒绝。本地工具由原生 Runtime 管理；Adapter 不安装或注入工具。图片输入仍在启动前明确拒绝。程序版本低于 1.3.3、未知版本或未经资格验证的预发布版本标记为不可用。

### 4.3 事件转换与结束判定

| 原生事实 | Octo 行为要求 |
| --- | --- |
| `init` / 后续事件的 `conversation_id` | 发布 `session.update`，由既有会话机制持久化；不把会话 ID 塞进根终态代替会话事件 |
| `step_update` 的 `agent_response` / `text_delta` | 以本次 invocation 与 step 身份生成稳定消息 ID；按 create → delta → update 处理；不同段不合并成一个全局对象 |
| 工具 step 的 ACTIVE / DONE | ACTIVE 创建或保持工具活动；DONE 才产生工具终态。仅收到 DONE 时补齐创建；重复 DONE 不重复工具结果 |
| `tool_info.parameters/output/error` | 保留公开输入输出与错误，按现有工具合同归一化；不追加到最终回答正文；同一步的工具 ID 不因状态变化而改变 |
| `result.response` 与文本增量 | 按真实 step / 消息边界核对完整快照，缺少增量时补正文，已有正文时避免重复追加；需样例验证 result 是否覆盖单段或多段 |
| step usage / result usage | 核实本机版本的累计口径；若沿用 multica 观察到的跨会话累计 result，优先按本轮 DONE step 去重汇总，不能重算前轮用量；不把 thinking 再叠加到已包含它的 output |
| 原生成功、错误、超时、取消、非零退出、输出截断 | 映射现有终态与错误字段；每次 invocation 只有一个根终态，完成清理后再由 Host 向上游收口；退出码 0 不单独证明业务成功 |
| 没有原生公开思考 / 通道标识 | 不按文本措辞猜测 thinking、commentary 或 final；公开性未知的 reasoning 不进入公共存储或界面 |

取消必须响应 `request.signal`，终止本次启动的子进程及其后代，并清理流与临时文件。不能只调用 SDK 的直接子进程终止后就声明资源回收完成。

### 4.4 参考实现中可复用与不可直接照搬的部分

multica 的主要参考入口为 `server/pkg/agent/antigravity.go`、`models.go`、`antigravity_test.go`、`antigravity_tools_test.go` 与 `antigravity_integration_test.go`，版本固定为第 2 节记录的 commit。

- 复用设计思路：结构化输出解析、工具 step 去重、原生模型 ID 解析、会话捕获、子进程回收、退出码与 Provider 错误联合判断。
- 作为回归样例：空 stdout、重复 step、只收到工具 DONE、部分回答后网络失败、完成后的尾随网络错误、恢复会话后 usage 累计。
- 不直接照搬：旧版默认超时假设、全局强制 skip-permissions、纯文本兼容与 transcript 恢复分支。首期以已验证的 `agy 1.3.3` 结构化合同为目标，不为历史 CLI 增加兼容层。
- 日志或 transcript 补读仅在当前版本真实复现缺口后再决定。若启用，必须限制为本次会话和本轮输入后的记录，验证文件边界、隐私和去重，禁止把旧轮次回答当作本次成功。
- multica 对特定尾随网络错误保留成功的规则不能泛化为“有回答即成功”。只有当前版本提供完整终态证据且通过对应回归后才采用例外。

## 5. Work App 与设置改造

### 5.1 设置与模型选择

1. Runtime 发现结果包含 `antigravity`、命令路径、版本、可用状态与失败原因。程序不存在、探测失败、模型目录未取得和实际调用失败必须区分；版本探测成功不标成“登录已验证”。
2. 设置页通过既有 Runtime adapter 列表显示 Antigravity。保留当前未安装引擎的过滤规则，不以静态占位卡伪装已发现。
3. 扩展 `ENGINE_TYPES` 及所有实际消费该常量的校验和样例；更新 `adapterQualification`，在通过资格测试后开放模型选择。
4. 首期复用已有 `nativeModelIds`、`defaultModel` 与 Provider 默认方式。用户可录入经过 CLI 核实的原生 ID；不预置本次未取得的模型列表。自动发现目录不在本次实现范围。
5. 配置沿用 Runtime / 引擎的持久化键；聊天会话保存显式选择。设置保存成功表示已持久化，不表示 CLI 已接受该模型；最终调用回执必须单独验证。
6. Antigravity 使用其本机认证。设置隐藏网关开关和继承网关模型范围控件，固定 `useGateway=false` 与原生自定义范围；模型列表不混入网关目录，不要求重复填写 API Key。
7. 聊天输入区继续只有一个模型 / 引擎入口。保留用户显式选择、Agent mandatory 约束和默认优先级。仅有 Antigravity 可用时，沿用单引擎选择逻辑，但不得因此自动把审批模式升级为 `full_access`。

若需要新增查询接口，沿用唯一 `window.octoWork` 桥与 Provider / Port 注入规则；kit 不得直接读取宿主全局。首期复用原生 ID 设置不要求新建第二套模型配置中心。

### 5.2 图标与交互展示

在共享图标包新增 `src/icons/antigravity.svg`，登记 `scripts/generate-icons.mjs` 的 `ICONS` 表，运行生成流程更新 `src/generated.ts`。不得手改生成文件。

素材采用 [LobeHub 官方彩色 SVG](https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/antigravity-color.svg)。落地时记录来源 commit 或包版本、文件校验值及许可证归属。保留原有渐变、比例与透明背景；不标为 `monochrome`，不使用主题文字色覆盖品牌渐变。

设置、引擎选择器、Runtime 列表及其他已有引擎标识入口通过共享包取得相同图标。在浅色与深色主题检查缩放、裁切、可访问名称以及离线可显示性。

执行中与完成后沿用现有 Transcript、工具与活动展示。验收必须覆盖首次启动、工具运行、失败、取消、历史重新打开和重连快照，不能仅检查设置页出现 Logo。

## 6. 文件级改造分配

以下路径以 Harness 根目录为基准；adapter、图标及相关测试已经新增。通用加载、图标消费和内置运行时打包流程按既有接口复用。

| 改造对象 | 计划修改点 | 完成判据 |
| --- | --- | --- |
| 新 adapter | `packages/octo-harness-adapter-antigravity/` | package、metadata、probe、命令构建、normalizer、清理、README 完整 |
| 加载与依赖 | `config/adapters.json`、根 `package.json`、`packages/octo-harness-adapter-host/package.json`、锁文件 | 独立安装与 embedded 产物可解析新模块，无模块缺失 |
| 共享图标 | `packages/octo-harness-adapter-icons/src/icons/`、生成脚本、生成结果、README | type 与品牌名称一致，可离线渲染彩色 SVG |
| App 设置 | `../octo-harness-work-app/src/shared/model-settings.ts`、`src/renderer/src/settings/ModelSettings.tsx` | 配置可保存、恢复，状态和未支持能力表达正确 |
| App 选择与执行 | App `src/renderer/src/lib/execution-context.ts`、`surfaces/ModelPicker.tsx`、`surfaces/Composer.tsx` | 模型、引擎和权限进入当前 Context v3 编译链，mandatory 不被绕过 |
| App 图标 | App `src/renderer/src/lib/provider-icons.ts` 及现有调用点 | 优先复用共享映射，仅在存在必要别名时修改消费代码 |
| 构建与内置运行时 | embedded 构建与 App `scripts/prepare-embedded-runtime.mjs` 对应流程 | 产物清单、依赖与 Runtime 上报一致；不预设必须修改通用打包脚本 |
| 测试与说明 | Harness 新 adapter 样例、现有契约测试；App 模型、图标与执行选择测试 | 需求、修改点、测试结果可按编号追踪 |

Worker 首期复用既有注册与投影合同；若联调发现引擎白名单或字段消费限制，再列入受影响范围，不预先承诺完全无需改动。

## 7. 验收矩阵

下表保留产品验收标准。代码及自动验证覆盖范围见第 10 节；未完成实机验证的项目不得填写产品验收通过。

| 编号 | 输入或操作 | 通过条件与证据 |
| --- | --- | --- |
| AC01 发现与打包 | 缺失命令、指定路径、本机 1.3.3；开发与打包后的 Runtime 各检查一次 | 路径、版本、可用性正确；缺失时给出原因且不影响其他 adapter；记录产物和注册结果 |
| AC02 首次调用 | 通过 App 选择 Antigravity，发送简单只读问题 | 实际启动 `agy`；既有事件校验通过；显示有效回答与唯一根终态；记录 Run ID 和脱敏事件 |
| AC03 权限 | `full_access`、`ask`、`assisted`，以及与 mandatory 冲突的输入 | full_access 参数正确；未实现的模式启动前拒绝；不静默升级；保存参数构建与 UI 测试证据 |
| AC04 模型 | Provider 默认、有效原生 ID、无效 ID、带空格 ID、目录查询失败 | 参数与设置一致；无效或无有效输出时不得空白成功；目录失败不伪装无模型；记录真实模型选择证据 |
| AC05 文本与工具 | 多段文本、ACTIVE→DONE、重复 DONE、只有 DONE、工具错误、最终快照 | 对象身份稳定、无重复、不提前结束；工具错误可见且不混入回答；实时与历史结果一致 |
| AC06 会话与 usage | 同一 Octo 会话连续两轮；两个独立会话交错调用 | 续接指定 conversation；不串线；usage 不重复统计前轮；缺失 usage 不伪造为零消耗 |
| AC07 终态与取消 | 非零退出、结构化错误、空输出、截断输出、超时、取消、取消后迟到事件 | 错误原因明确；一个根终态；进程树与临时文件清理；界面不重新进入忙碌 |
| AC08 内容与上下文 | 指令、用户材料、已有 AGENTS.md、公开性未知的 reasoning | 载体符合批准设计；用户文件不被覆盖；私有 reasoning 不进入公开事件 / DOM / 复制内容 |
| AC09 设置与持久化 | 保存模型、重启 App、切换 Runtime、会话与 Space | 配置按现有作用域恢复；无跨 Runtime / 会话 / 租户污染；选择与请求相符 |
| AC10 真实应用闭环 | 重新构建并重启受影响进程；对测试环境进行 CDP 验证 | 真实 renderer 能选择、提交、展示工具、取消并打开历史；记录 Worker 实际 URL，不能用本地 Worker 冒充线上测试环境 |
| AC11 Logo | 浅色、深色、离线及各引擎入口截图 | 用户指定的彩色 A 形标识，无棋盘格底图、无裁切；不回退为通用终端图标 |
| AC12 回归 | 现有引擎、默认选择、mandatory、协议校验、嵌入式构建 | 既有测试通过；Run 7 / Context v3 保持；默认优先级未变；原有行为没有新增失败 |

自动测试使用假 CLI 与固定事件样例，避免依赖账号、额度和网络。真实执行单独进行；涉及工具写入时在隔离工作目录验证，不把本仓库作为无约束改写目标。

建议验证入口：

- Harness：`pnpm typecheck`、`pnpm test`、`pnpm lint`。聚焦测试包括 `test/adapters.test.js`、`test/adapter-permission-modes.test.js`、`test/adapter-tool-lifecycle.test.js`、`test/adapter-icons.test.js`、`test/host.test.js`、`test/host-message-identity.test.js`、`test/embedded-sdk.test.js`，并增加 Antigravity 原生样例。
- Work App：`pnpm typecheck`、`pnpm test`、`pnpm build:test`；若修改 kit，再执行相应 kit 检查。重点扩展 `tests/execution-context.test.ts`、`tests/model-picker-settings.test.ts`、`tests/model-settings-service.test.ts`、`tests/provider-icons.test.ts` 和 Runtime 打包测试。
- UI / 接口联调：按上级 `AGENTS.md` 使用真实 Electron renderer 的 CDP，连接 `https://im-test.deepminer.com.cn/` 对应测试链路；记录实际 Runtime、Worker 地址、CLI 版本与 Run ID。重新构建 / 链接不能代替旧进程重启。

测试记录逐项填写“通过 / 失败 / 未执行 / 不适用”、命令、环境、证据文件和缺陷。没有取得结果的检查不得填写通过。

## 8. 评审门禁与基线检查

| 门禁 | 冻结对象 | 检查与退出条件 |
| --- | --- | --- |
| 需求决策 DCP | 目标、首期范围、SR01–SR06 | 已按用户授权实施 full_access 与手工原生模型 ID；这不代表完成正式 DCP 评审 |
| 需求 / 架构 TR | 功能基线与模块分配 | 明确 adapter 身份、Run 7 / Context v3、各模块输入输出；需求均有承担模块和验收编号 |
| 详细设计 TR | 分配基线 | 解决输入载体、终态判定、usage 口径、取消回收和模型设置语义；提交原生样例与测试设计 |
| 集成验证 TR | 实现与测试基线 | Harness / App 构建与测试通过；每项失败可定位；embedded 产物与源码一致 |
| 验收决策 DCP | 产品基线 | AC01–AC12 有结论与证据，真实测试环境闭环完成；未支持能力明确，不以仅文档或仅 UI 通过代替交付 |

实施前基线检查：重新核对 HEAD 与本地差异、CLI 路径 / 版本、模型目录、依赖锁文件、现有测试结果、测试环境地址。现存失败先记录，再区分本次引入的问题；不能无证据宣称基线测试全部通过。

集成后基线检查：核对包、清单、图标生成结果、App 依赖解析及 embedded 产物；重启受影响进程并检查 Runtime 重新注册；用同一批固定样例比较改造前后已有引擎行为。

基线变更管理：需求或 CLI 合同变化时，记录变更原因、影响的 SR / AC、代码与产物版本以及重测范围，再更新文档版本。不另造旧协议兼容路径。若回退实现，恢复成套代码与构建产物并停止使用新引擎入口；不删除会话、历史记录或用户文件。

## 9. 设计决策与待验证事项

| 编号 | 事项 | 当前结论及关闭依据 |
| --- | --- | --- |
| Q01 | 首期权限 | 已实现仅 `full_access`，与用户 yolo 用法一致；ask / assisted 明确拒绝 |
| Q02 | 实际可用模型 ID，以及 `agy models` 长时间未返回的原因 | 用成功的目录结果与实际模型调用关闭；本次不预填 Gemini 型号 |
| Q03 | 模型目录方式 | 已实现手工原生模型 ID 与 Provider 默认；未实现自动目录发现 |
| Q04 | 输入载体 | 已采用官方 stdin user 消息和两个带标签 text block；假 CLI 测试通过，真实模型接受情况待验证 |
| Q05 | 原生事件及 effort 资格 | 固定样例测试已覆盖转换行为；本机真实事件和 effort 模型支持范围仍待验证 |
| Q06 | 版本、超时与取消 | 最低 1.3.3，print-timeout 为 0，POSIX 进程组取消；Windows 后代回收待实机验证 |

首次文档检查只完成源码、帮助与素材定位。实施阶段已完成代码改造、自动测试、类型检查和构建检查，结果见下一节。本机真实调用探测未取得有效回答后已终止；不能把探测日志中的启动期 `You are not logged into Antigravity` 单独当作账户未登录的结论，因为用户正在运行的正常交互进程也出现该诊断。adapter 只把明确的 `exiting agent loop due to error` 判定为日志终止错误。

按用户最新指示，本轮先完成代码，暂缓真实账户排查和 Electron 线上闭环。没有重启用户的 Ghostty / Antigravity 会话，也没有修改其登录配置。

## 10. 实施与自动验证记录

### 10.1 代码基线变更

Harness 新增 Antigravity 包、清单登记、根包与 Host 依赖及锁文件。新增 adapter 实现版本探测、stdin 载体、原生模型参数、会话续接、公开文本和工具转换、用量去重、终态、取消与临时日志清理。原有引擎登记顺序保留，新引擎追加到清单。

Work App 新增引擎类型与模型资格；设置只显示原生模型配置；Composer 只使用当前 Runtime 的 Antigravity 原生模型列表。默认优先级仍为 `codex > claude-code > codebuddy > openclaw`。未修改 Run 7 / Context v3、Worker 协议或唯一 preload 桥。

共享图标包增加彩色 Logo，通过既有生成脚本产出映射。来源为 LobeHub `packages/static-svg/icons/antigravity-color.svg`，本次定位 commit `c385b2b8d1f9e19aa86e628d4e23c91ee1111a47`，代码许可证 MIT。素材 SHA-256：`0b911f0ba819e5a4f4c1d59f28a6ead23f65cfdc86b0a41b380a9fc09498e383`。品牌权利仍归原权利人；棋盘格不包含在素材内。

### 10.2 检查结果

下列结果来自 2026-10-10 的本机检查。日志为临时证据文件，不进入仓库；可按检查入口重新运行。

| 检查项 | 结果 | 证据与边界 |
| --- | --- | --- |
| Harness 改造前自动测试 | 878 通过，5 跳过，0 失败 | 原始基线共 883 项 |
| Harness 构建与全量自动测试 | 896 通过，5 跳过，0 失败；workspace 构建通过 | `pnpm test` / `node --test test/*.test.js packages/octo-harness-protocol/test/*.test.js`；`/tmp/octo-agy-harness-tests-final.log` |
| Harness 类型检查 | 通过 | 构建后执行 `pnpm exec tsc -p tsconfig.json --noEmit`；`/tmp/octo-agy-harness-types.log` |
| 新增代码 lint | 通过 | `pnpm exec eslint packages/octo-harness-adapter-antigravity/src/index.ts packages/octo-harness-adapter-icons/src/generated.ts`；`/tmp/octo-agy-lint-scoped.log` |
| Harness 全量 lint | 未通过，20 个错误均位于本次未修改文件 | `pnpm lint`；`/tmp/octo-agy-lint.log`；不能宣称三门全部通过，既有文件问题另行处理 |
| Work App 类型检查 | 通过 | `pnpm typecheck`；`/tmp/octo-agy-app-types.log` |
| Work App 全量自动测试 | 1373 通过，1 跳过，0 失败 | `pnpm test`；`/tmp/octo-agy-app-tests-final.log`；含原生模型保存与 Composer 提交测试 |
| Work App 测试环境构建 | 通过 | `pnpm build:test`；`/tmp/octo-agy-app-build.log`；没有据此声明运行中 Electron 已加载新 Runtime |
| 内置运行时独立依赖打包 | 通过 | 使用现有 `pnpm --ignore-scripts --config.inject-workspace-packages=true --filter @mininglamp-oss/octo-harness-embedded deploy --prod <临时目录>`；`/tmp/octo-agy-deploy.log` |
| 打包后模块解析与本机 CLI 探测 | 通过 | 从打包后的 Host 实际模块目录解析新 adapter；返回 `antigravity`、`available=true`、`/Users/lvsijia/.local/bin/agy`、`1.3.3`；`/tmp/octo-agy-deploy-probe.log`；只证明加载与版本 |
| 设置界面静态检查与差异检查 | 通过 | Impeccable detector 无发现；两仓库 `git diff --check` 无错误；不代替真实 renderer 截图 |
| 真实 CLI、Electron / im-test 闭环 | 未完成 | 用户要求先完成代码；首次真实调用未得到有效模型结果，本轮没有有效 Run ID 或线上终态证据 |

### 10.3 需求追踪与产品验收缺口

| 验收编号 | 自动验证覆盖 | 剩余产品验收 |
| --- | --- | --- |
| AC01 | 缺失命令、清单、独立包解析、本机版本探测 | 真实 Electron 内置 Runtime 重启与重新注册 |
| AC02 | 假 CLI 的规范事件与成功终态 | 真实模型首次调用及有效 Run ID |
| AC03、AC04 | 权限拒绝、受管参数冲突、模型原样传参；Composer 传出显式 full_access 和原生模型 | CLI 实际接受有效模型、拒绝无效模型 |
| AC05、AC06 | 分段文本、快照修正、工具 ACTIVE / DONE 去重、显式会话、当前轮用量 | 真实工具流、交错会话及历史恢复 |
| AC07、AC08 | 空输出、非法 JSON、错误结果与日志、非零退出、TERM-resistant 父子进程回收、临时文件清理、未知 reasoning 抑制、AGENTS.md 保留 | 实际网络失败、超时、Windows 进程树回收及上下文接受情况 |
| AC09 | 设置保存、原生模型隔离、既有会话选择与持久化回归 | 重启 App 与切换真实 Runtime / Space |
| AC10 | 测试环境构建 | CDP 驱动真实 Electron 对接 im-test 的完整闭环 |
| AC11 | 彩色 SVG、内联 data URL、无在线素材依赖 | 浅色、深色、离线及各入口实机截图 |
| AC12 | Harness / Work App 全量自动回归、类型检查及构建 | 全仓库 lint 既有错误关闭；实机回归 |

本轮代码具备继续联调的基础；产品验收门禁保持未关闭。未支持 ask / assisted、自动模型目录、动态 MCP、动态技能和图片输入；effort 的 App 控件等待真实模型资格验证。

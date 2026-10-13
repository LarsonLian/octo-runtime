# Harness 统一 Context 处理实施基线

> 2026-10-13：后续目标改为发起方构造 Event Context、接入层转发、Host 固定渲染。新约束、代码退出清单和验收见 [Event Context IPD-SE 0.2](../../docs/event-context-rendering-ipd-se.md)。本文为历史 Pipeline 实施记录，不作为新增编译阶段的依据；新方案尚未实施。

本文保留 v1 实施历史；当前 v2 合同与验证状态见 [Context v2 验证记录](context-simplification-validation.md)，不再以本文旧类型清单作为在线协议。

日期：2026-10-08（Asia/Shanghai）。版本：`0.3`。状态：统一入口、阶段预算、材料恢复与 Codex 原生应用证据已实现。其他 Adapter 仍按各自已验证的能力拒绝不支持的资源类型。

共享语义以 [跨项目总基线](../../docs/62-octo-context-compiler-se-baseline.md) 为准。本文覆盖 Protocol、daemon、core、Adapter Host 和各 Adapter。

## 1. 现状与统一入口

| 当前定位 | 已有职责 | 目标处理器 |
| --- | --- | --- |
| `packages/octo-harness-protocol/src/context.ts` | 校验、merge、canonical/hash、类型预算 | 公共目录与纯合同工具 |
| `packages/octo-harness-core/src/context.ts` | 本地模式仅接受 execution/security 子集 | 本地管线配置；不隐式开放云端资源类型 |
| `packages/octo-harness-daemon/src/run-context.ts` | 冻结计划检查、材料和控制编译 | verify 与 Compiler 起点 |
| `daemon/src/input-images.ts` | Artifact 租约读取，临时图片 source | 图片 Materializer，保持 input.parts |
| `daemon/src/task-materials.ts` | 注册任务 MCP 读取及材料摘要 | prepare-time 任务资源处理器 |
| `daemon/src/channel-context-store.ts` | 频道快照与连续性缓存 | continuity 处理器，保留原 cursor/epoch 规则 |
| `daemon/src/agent-work-runtime.ts` | 准备编排与 InvokeRequest 映射 | 统一管线调用者，不重复拼接事实和指令 |
| `packages/octo-harness-adapter-*` | Provider 原生输入映射 | applied/loaded 与兼容性证据消费者 |

源码路径中的 `daemon/src` 均相对于 `packages/octo-harness-daemon/`。Pipeline 与 Compiler 位于现有 daemon 模块中，Protocol 只提供纯合同与校验。

## 2. Protocol 与处理器注册

Protocol 必须发布类型目录和共享准备/编译元数据合同。目录包含数据语义，不包含 fetch、解包、工具执行或凭据实现。TypeScript 与 Worker Go 必须消费同源 fixtures。

daemon 按目录注册 verify/prepare/compile 处理器。编排器必须检查依赖、缺失处理器、输出冲突与消费记录。目录顺序不等于执行顺序；并行准备不能改变模型投递顺序。

本地 core 当前只支持 execution/security。目标管线必须声明该支持子集；不支持的资源类型仍拒绝。本地能力后续扩展也必须有授权 Port 和合同，不能绕过云端模型来执行任意资源操作。

## 3. 准备、回执与清理

Runtime 收到命令后，必须先验证冻结 Context/plan、Runtime 目标、lease/fence、Adapter 能力和必需处理器。验证通过后才能读取图片、取任务材料、准备频道快照、下载包或创建目录。

每个 Materializer 使用当前执行绑定和取消信号。临时凭据按既有安全物化接口注入；不得从资源正文构造认证 header 或可执行命令。

prepare 输出必须包含稳定资源标识、实际版本/digest、授权 scope、路径映射和类型消费结果。路径与二进制内容属于 Runtime 资源视图；持久 Context 保持引用。Compiler 只读准备产物，不负责网络访问。

模型启动前必须封存回执并取得权威确认。响应未知时查询或幂等重交，不能先启动。相同准备身份返回不同路径或摘要时拒绝；取消后的晚到结果不得覆盖已终止状态。

恢复同一 attempt 时，必须复用已封存资源或读取同版本并校验。新的 attempt 按资源一致性规则准备，不能因重连获取不同 latest 却沿用旧内容 hash。

包根目录、cwd、Run 资源视图和插件持久数据分开管理。下载校验摘要；解包拒绝路径穿越与不允许的符号链接。失败清理只删除本次临时资源，不能修改共享个人 Provider 配置或删除用户目录。

random workspace 仅声明 `{ "mode": "random" }`，不得携带 scope 或 path。Runtime 在 AgentSession 首次运行时创建工作区，后续运行复用该目录；不同 AgentSession 使用独立目录。已绑定目录丢失时拒绝续接，不创建空目录替代。目录分配必须幂等并回传实际路径。输入的策略快照不回写为本机路径；协议允许随机策略的执行计划暂不包含具体 workdir。当前 Runtime 先准备实际目录并取得 Worker 回执确认，再映射 Provider 的 workdir；不得直接使用冻结计划中的空 workdir 启动。

## 4. Compiler 与 Adapter 输出

Compiler 必须通过一个入口生成 CompiledContext，并映射现有 InvokeRequest。引用选区、任务材料、频道事实和当前用户输入分别保留来源边界；图片保留数量和相对顺序。

可信指令装配将 Revision、可信配置和平台贡献接入统一入口。切换后旧 `mapExecutionEnvelope` 不再第二次加入同一贡献；指令顺序与来源必须可追溯。

工具范围、模型、强度、cwd、审批和限额继续使用结构化字段。Prompt 不能代替 MCP 挂载、包下载、文件授权或 Provider 模型设置。Compiler 成功不代表 Adapter 已应用。

Adapter 对必需映射不支持时必须在 invoke 前拒绝。Adapter 报告 applied 和 loaded；实际 invoked 仅来自可观测事件，无法判断时为未知。严格资源范围无法验证时拒绝严格模式，不能只通过提示词宣称范围受控。

bootstrap/delta/inherit/recovery 与 fresh Provider Session 保留原语义。每轮 invocation 都应用冻结运行配置。资源、编译版本、工具范围或实际工作区变化必须进入版本化兼容判断；恢复输入不得重新加入已撤权材料。

## 5. 工作包与验收

| 工作包 | 交付 | 总基线验收 |
| --- | --- | --- |
| CP-P01-H | 类型目录、版本、fixtures 与合同导出 | CP-A01、03、19 |
| CP-H01 | 编排器、现有四类准备处理器、回执和消费检查 | CP-A02、08、09、10、13、14、16 |
| CP-H02 | InvokeRequest 映射、逐 Adapter 应用与连续性 | CP-A11、12、15、17 |
| CP-X01-H | 插件/技能/连接器、random workspace 与严格范围 | CP-A04、09、10、15、20 |

必须覆盖取消中下载、错 digest、解包穿越、回执响应丢失、重复准备、旧 fence 和图片混合输入。测试要观察 Provider 启动次数和实际配置；只比较生成字符串不足以证明应用。

逐 Adapter 记录版本与资格。真实 Runtime 连接 im-test + octo-auth，验证任务取数、图片读取、频道恢复和回执持久化。未部署的 Adapter 或处理器不能在能力目录宣称可用。

## 6. 当前运行合同

当前运行合同为 schema 4，选路快照为 v2，Context 信封仍为 v1；旧 binding 模式不保留兼容分支。公共回执新增必填 `compiled_hash`，公开投影新增必填应用状态、调用状态和已加载技能。三个项目必须同步升级。目录只声明语义；执行能力仍取决于 Resolver 和 Adapter。core 本地模式继续明确接受 execution/security 子集。

## 7. 本轮 Protocol 增补与验证

本轮新增 `context-catalog.ts` 与 `context-configuration.ts`，并从 schema 生成公开 ContextConfiguration 类型。公开 API 为 `CONTEXT_TYPE_CATALOG`、`contextTypeDefinition`、`assertContextProcessorCoverage`、`assertContextConfiguration` 和 `resolveContextConfiguration`。

配置解析保留 replace 类型的默认覆盖；资源 selection 使用 include/exclude 集合操作；mandatory 限制设备范围、资源版本、组件范围与 invoke；requirements 合并强制和请求能力。解析结果经公共 canonical 规则输出，输入对象不被修改。

共享 configuration fixtures 位于 Protocol schema 目录，并复制到 Worker domain/testdata。两端测试必须消费同一内容，不能各自维护不同预期。原有 Context fixtures 已扩充新类型、非法候选、非法 random 组合、资源重复与 include/exclude 冲突；旧 binding 样例改为拒绝。

`daemon/src/context-pipeline.ts` 提供有副作用的 ContextPipeline 和纯 ContextCompiler。Runtime 按输入图片、能力包、任务材料、频道连续性的顺序准备，检查取消，汇总准备证据，编译事实与可信指令，最后向 Worker 封存回执。任何前置失败或封存拒绝均不能返回可调用的结果。Revision 和平台指令经明确可信来源进入编译器；已编译贡献不再由 InvokeRequest 映射重复加入。

回执合同为 `ContextPreparationReceipt`，包含 compiler/catalog 版本、Context hash、`compiled_hash`、run/lease/fence、实际目录、能力包、材料版本和连续性引用。编译摘要覆盖编译版本、实际产物、可信贡献顺序、工作区、资源与材料证据；实际路径会影响本轮应用身份。摘要不是跨机器归一化的模型正文摘要。

准备阶段注册表为 `input -> capabilities -> materials -> continuity`。稳定拓扑排序在副作用前拒绝缺失阶段、重复阶段、未知依赖和依赖环。每个阶段及 seal 默认预算为 30,000 毫秒，从进入阶段开始计时，阶段内部重试计入同一预算。达到阈值后中止子信号并拒绝结果；即使 Port 未及时响应取消，晚到结果也不能封存或启动模型。该预算不替代各资源的字节、解包或编译输入限制。

类型消费记录明确处理键、prepare/compile 阶段及处理器。编排器校验每阶段覆盖和重复消费。Compiler 是纯函数；网络读取、下载、授权和封存由 Pipeline Port 承担。

任务材料首次读取执行 `expected_version` 检查，并将正文、版本、handler epoch 和 digest 写入 Runtime SQLite。恢复相同 Run 时先建立当前授权连接，再通过 `task_authorize_material_snapshot` 验证当前 Run/任务绑定与 handler epoch；只复用已保存正文，不获取新 latest。Context hash 冲突、正文被修改或授权撤销均拒绝。终态确认清理该 Run 快照；孤立快照按七天清理，活动 Run 受保护。

Codex Adapter 在原生技能发现与启用成功、且 `turn/start` 获得确认后发送 `context.applied`。证据绑定编译摘要和当前 lease/fence，记录原生 Provider Session 与加载技能。Provider 启动失败或技能缺失时不得发送应用成功。此证据不证明技能或工具实际调用，公开 `invocation_status` 保持 `unknown`。

完整 Harness 提交快照构建通过。提交快照完整测试共 806 项：802 通过，4 跳过，0 失败。新增用例覆盖阶段环、超时晚到、编译摘要稳定性、SQLite 关闭后恢复与撤权、原生技能和启动确认。同源应用证据 fixtures 在 TypeScript 与 Go 两端校验。真实三项目验收记录见 Work App 的 `docs/validation/context-pipeline-2026-10-08/`；测试与 Adapter 资格分别记录。

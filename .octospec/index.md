# Octo Runtime 工程知识目录

当前实现基准为 Git `df63c8f` 与本次工作树。当前合同依据源码核对，历史证据独立记录；不把旧设计或曾经通过的测试当作现有功能。工程说明使用中文。

## 当前规则

| 主题 | 入口 |
| --- | --- |
| 强制产品意图归属、需求范围检查与按合同归属修复 | [基础架构](rules/architecture.md) |
| 总体协议、调用时序与审批／追问往返 | [协议与调用设计](rules/protocol-design.md) |
| 身份、Home、profile、安装与生命周期 | [本地 Runtime](rules/runtime-lifecycle.md) |
| 公共输入、默认值与多模态 | [InvokeInput](rules/invoke-input.md) |
| IPC、执行接纳与断流修复 | [本地执行](rules/local-execution.md) |
| 帧、原生模式、canonical 与交互 | [输出协议](rules/output-protocol.md) |
| 纯执行、有界窗口与业务历史 | [状态与容量](rules/stateless-execution.md) |
| 每轮模型输入、控制通道与 cwd | [Context 输入](rules/context-input.md) |
| 未知可选项与业务 extra | [Context 扩展](rules/context-extensions.md) |
| 本轮进程环境变量 | [envs](rules/environment.md) |
| 本轮 MCP 连接 | [MCP](rules/mcp.md) |
| 宿主管理支持范围、Adapter 适配转发与实际可用性 | [Adapter 责任边界](rules/adapter-metadata.md) |
| OpenClaw profile 连接与目标 | [OpenClaw](rules/openclaw.md) |
| 四挡 effort 与诚实回执 | [思考强度](rules/reasoning.md) |
| 插件归属、装配与资源清理 | [Extra](rules/extras.md) |
| 渠道上下文、回执与投递 | [Channel](rules/channel-integration.md) |
| 会话 binding、代次与 reset | [会话重置](rules/session-reset.md) |
| 生成类型与运行时校验 | [协议 Schema](rules/protocol-schema.md) |
| TypeScript、检查及线上联调 | [开发与验证](rules/engineering.md) |
| 中文说明与提交 | [协作约定](rules/collaboration.md) |

机器可读触发条件见 [规则索引](rules/_index.yaml)，与规则 frontmatter 同步。`inject_when` 只是编码 Agent 阅读条件，不是 Runtime 自动注入模型 Context 的配置。

## 操作指南

- [工作区与开发组织](guides/workspace.md)：目录、依赖、构建及新增包。
- [Adapter 开发](guides/adapter-authoring.md)：接口示例和验收。
- [Provider 实现矩阵](guides/providers.md)：传输、模式及权限差异。
- [Extra 配置与调用](guides/extra-configuration.md)：当前 CLI 路径、SDK 和本地 WebUI。
- [IM Agent 与通用 invoke 的责任边界](guides/im-agent-invocation-boundary.md)：长期 Agent 的业务策略与单次执行能力分层；固定 workdir 与 reset 是 IM 架构决策，不是每会话目录功能计划。
- [本地运维](guides/operations.md)：真实状态、排障和日志。

根目录按场景分为 [CLI 使用指南](../CLI_USAGE_GUIDE.md) 和 [SDK 原生接入指南](../SDK_NATIVE_INTEGRATION_GUIDE.md)；[INTEGRATION.md](../INTEGRATION.md)仅作选型导航，[DEPLOYMENTS.md](../DEPLOYMENTS.md)说明发行部署。包 README 保留包级用法。

## 历史与取舍

- [CLI 使用与 SDK 原生接入文档分拆](journal/shared/2026-10-16-cli-sdk-guides-split.md)：按使用场景拆分完整正文，桌面应用必须 SDK 接入；明确 CLI 全量发行与实际启用的区别，迁移文档链接与示例。

- [executionFeatures 删除交付](tasks/remove-execution-features/delivery.md)：Runtime、Work App、Worker 按 Feature 提交并推送，类型/常量/发现与消费者清理完成；1001项Runtime、2555项桌面/kit测试通过，正式im renderer及真实Codex文本/图片/审批/取消/MCP通过，远端未部署。实施门槛及新增问题见[独立评估](tasks/remove-execution-features/feasibility-review.md)。

- [F4 删除 computer-use 标签专用探测](journal/shared/2026-10-16-remove-computer-use-probe.md)：删除 Codex 创建时的配置扫描、helper 和 TOML 依赖；930 项回归通过，真实 Codex 工具请求 im-test 成功。其余 Feature 待实施，真实 Home 动态 MCP 注入问题单独记录。

- [本地 WebUI Extra 替换 SSE Demo](tasks/runtime-webui-extra/brief.md)：已实现 `octo-runtime-webui-extra`，端口 `13888`，默认项目 `~/octo-runtime-workspace`；移植 Work App 的 thinking/工具、Composer 和模型菜单，项目使用 sessionStorage，独立 JSON 最多保留 100 个会话与 Provider binding，支持刷新/清理。真实 Codex、浏览器与仓库外安装证据及线上限制见[交付记录](journal/shared/2026-10-16-runtime-webui-extra-delivery.md)。

- [executionFeatures 清理开发计划与逐项评分](tasks/remove-execution-features/brief.md)：按实际消费者拆为七项，覆盖 Adapter 输入检查、watchdog、标签专用探测、桌面产品策略、Worker 登记合同及真实验收；当前准备度平均约 94 分，待补齐活动源切换和未知 Adapter 策略。本轮仅计划，未改产品代码。

- [宿主管理 Adapter 支持范围](journal/shared/2026-10-16-adapter-forwarding-ownership.md)：确定 `executionFeatures` 为待删除的自建能力声明机制；Adapter 按合同适配转发，宿主管理功能使用，必要的运行状态及原生协议校验留在执行边界。本轮仅落 OKF，代码清理尚未实施。

- [IM 中途诊断后无有效回复的收尾体验](tasks/im-diagnostic-silent-completion/brief.md)：参考 PR #49，已实施首条有界诊断和 IM 待核查收尾；正常路径无新增诊断通知、网络或模型调用。全量 929 通过、8 跳过，im-test 五场景及真实桌面组件验收通过，见[实施记录](journal/shared/2026-10-16-im-diagnostic-silent-completion-delivery.md)。

- [现有 Adapter 的 Plan 模式与用户交互探索体验](tasks/adapter-plan-interaction-exploration/brief.md)：Context v3 显式 actmode 已接通 Codex、CC、OpenCode ACP，完成 Work App / im-test 验证及 Codex 结构化问答；会话及模式默认策略归产品，IM Channel Gateway 不接入 Plan。限制见[交付记录](journal/shared/2026-10-16-actmode-first-three-delivery.md)，职责纠偏见[记录](journal/shared/2026-10-16-product-intent-ownership.md)。

- [Runtime 长期运行四项整改总览与评分](guides/runtime-long-running-review-plan.md)：OpenClaw 入队过滤/容量、小时日志保留与单文件 100 MiB、整请求 32 MiB 与图片 IPC、64 Bot/配置操作准入已分批实施；保留实施前评分 96/95/96/95，实际验证与推送状态见[收尾记录](journal/shared/2026-10-16-hourly-log-delivery.md)。

- [Channel 六项决策实施与测试环境验收](journal/shared/2026-10-16-channel-features-delivery.md)：当前分支分批实现 Codex 独立图片、新会话一次历史、原生 Mention 与固定目录校验；全仓回归及 im-test 群/话题、真实 Codex 识图和客户端高亮通过，限制逐项记录。

- [Channel Gateway Bot 连接状态机与断线恢复](tasks/channel-connection-state-machine/brief.md)：五态与首次失败不重试已实现，上线后按 5/10/20/30 秒恢复，成功清错误并重置计数。im-test 真实收发、重复连接踢旧、双 Bot 隔离及 CDP 显示通过；合盖待验，见[交付记录](journal/shared/2026-10-16-channel-connection-state-machine-delivery.md)。

- [协议责任与拒绝跨模块猜测兜底](journal/shared/2026-10-16-contract-responsibility-decision.md)：从业务与合同定位问题，在责任模块修复；发送端漏填 mention 不由接收端正文匹配补救，旧实现的兼容动机不是复制设计的理由。

2026-10-15 Channel 讨论拆分为六项，包含功能计划、架构决策和协作核对，不能统一按开发 plan 评分。2026-10-16 明确固定 workdir 与 reset 为已接受的架构决策，不是待开发功能；各项实现与验收状态以正文为准：

| 专项 | 已确认结论与待决边界 |
| --- | --- |
| [1. Codex 独立图片输入](tasks/channel-image-input/brief.md) | 仅 Codex、仅独立图片消息；OpenClaw/cc、富文本及转发内图片不纳入，复用 inputs 图片 part |
| [2. 新会话历史 Context](tasks/channel-new-session-history/brief.md) | 每新 session 只尝试一次，最多 15 条/1500 字符纯文本；reset 仍补旧聊天，失败空历史继续，正常续聊不重拉 |
| [3. 不持久化上下文](tasks/channel-no-context-persistence/brief.md) | 有界内存，不新增历史、Context、binding 或投递账本持久化 |
| [4. 限流与重试](tasks/channel-rate-limit-retry/brief.md) | 区分 API/Provider/Channel 重试，衔接另一 Codex 任务，不重复实现 |
| [5. 固定工作目录架构决策](tasks/channel-fixed-workdir-decision/brief.md) | 已接受的 IM 架构约束，不是开发 plan；一个 IM 后台 Agent 固定目录，任务/session/reset 均不改变；不扩大为通用 Host 的目录限制 |
| [6. Mention 身份与能力](tasks/channel-mention-context/brief.md) | 入站支持真实 UID 点名及纯 ais 的 @所有AI，拒绝正文匹配与免 @；出站真人点名由模型查 UID、Channel 随 final 发送，普通回复不自动 @；模型出站广播与 Bot 目标待决 |

- [IM 长任务时限与 Codex 故障重试](tasks/im-long-running-retry/brief.md)：已实施一天默认值与独立恢复预算；Extra 重试工具/交互前的明确 Codex 暂态失败，Host 保持单次执行。真实 Codex 受控 503 恢复通过，真实 IM 收发、一天持续运行与工具后恢复仍待验收。

- [单一发行包的第三方插件合同](tasks/public-plugin-contracts/brief.md)：公开 Extra/协议类型与工具，仓库外 TS 工程及真实 Agent Run 验证；第三方 Adapter 入口和 CLI 追加清单仍待实施，详见[验证记录](journal/shared/2026-10-15-public-plugin-contracts.md)。

- [CLI 与 SDK 分别决定 Adapter 加载集合](tasks/adapter-composition-ownership/brief.md)：CLI 默认清单固定归属 apps/cli/src/default_adapters.json，SDK 在独立 Host 入口直接 import；默认来源拆分已实施，第三方追加清单仍待实现。依赖与包体归宿主，接入示例及加载实现必须有详细中文注释。

- [移除 AdapterHost app 启动壳](tasks/remove-adapter-host-app/brief.md)：apps 收敛为 CLI 与 daemon，统一使用 package runner，保留独立 Host 进程及全部 CLI 功能；检查、离线安装与真实 Provider 结果见[验证记录](journal/shared/2026-10-15-remove-adapter-host-app.md)。

- [CLI 构建 commit 信息](tasks/cli-build-commit/brief.md)：pnpm build 固化 Git 来源，版本与帮助显示 commit/dirty，发行包保留元数据。

- [CLI 设备级 Extra 配置目录](tasks/device-extra-directory/brief.md)：记录 CLI 唯一配置源、SDK 宿主边界与实施计划。

- [统一 Host/RPC 执行输入](tasks/unify-invoke-transport/brief.md)：沿用 InvokeInput 与 signal，RPC 只传输，Host 唯一解析；[验收记录](journal/shared/2026-10-15-unify-invoke-transport.md)包含 CLI、Playboard 和 Work App 命令及真实结果。

- [删除通用执行渠道快照](tasks/remove-context-snapshot/brief.md)：删除 contextSnapshot、渠道快照引用类型及转发；业务自行保存材料，另记录 Host 与 RPC 统一调用链的目标。

- [删除通用协议业务场景](tasks/remove-business-scenarios/brief.md)：删除场景白名单、ScenarioRequest 及 Node/browser 导出；Channel Gateway Extra 保留业务接入职责，不为 Work App 测试程序保留旧合同。

- [删除业务能力合同](tasks/remove-business-capability-contract/brief.md)：移除自有 capabilities、执行计划能力标签及 ExecutionTarget 预留设计；验证结果单独记录。
- [后续协议简化检查](journal/shared/2026-10-15-protocol-simplification-review.md)：核实业务场景、渠道快照和内部派生参数的真实调用链；其中未消费计划字段按[后续任务](tasks/remove-unused-plan-fields/brief.md)删除，其余为建议。

- [实体设备与虚拟 Runtime 归属澄清](tasks/device-virtual-runtime-boundary/brief.md)：按用户架构图复盘设备、虚拟身份与 profile 混用问题，明确 Host 级 Extra、业务归属与迁移验收；本次为文档决策，代码待改造。
- [Playboard 统一 daemon 执行](tasks/playboard-daemon-execution/brief.md)：记录绕过 daemon、重复装配 OpenClaw 的问题与改造原因；当前工作树已统一临时 daemon、两层 RPC 和资源隔离，见[验证记录](journal/shared/2026-10-15-playboard-daemon-execution.md)。
- [Extra 责任边界决策](tasks/extra-responsibility-boundary/brief.md)：复盘原地更新和业务 RPC 的过度设计，明确宿主编排、必备状态及改造验收；当前代码已按新接口调整，后续 [dispose 修复验证](journal/shared/2026-10-15-extra-dispose-repair.md)单独记录。
- [架构演进](journal/shared/architecture-evolution.md)：Git 节点、已撤回设计的问题和当前替代。
- [历史验证摘要](journal/shared/provider-validation-history.md)：原文日期的真实证据、失败及未验收边界。
- [31 份材料审查表](tasks/consolidate-runtime-knowledge/migration-review.md)：每份旧文档的去向与理由。
- [本次任务](tasks/consolidate-runtime-knowledge/brief.md)：范围与验收。
- [本次整理验收](journal/shared/2026-10-15-knowledge-consolidation.md)：检查结果及其范围。
- [知识变更记录](log.md)。

旧方案全文留在 Git，不在当前知识目录镜像；需要追溯时用 `git show <commit>:<path>`。未实现的提议不能写成当前操作步骤。

## OKF 目录约定

| 目录 | 单元类型与用途 |
| --- | --- |
| `rules/` | `type: Rule`，当前必须遵守的合同 |
| `guides/` | `type: Guide`，操作与实现参考；本仓采用的 OKF 扩展类型 |
| `tasks/<slug>/` | 开发任务使用 `type: Task`；保留原路径的纯架构决策使用 `type: Guide` 并链接现行规则，不因位于 tasks 就视为待开发功能 |
| `journal/shared/` | `type: Journal`，历史事实、学习及验证结果 |
| `learnings/pending/` | 仅放未决知识，完成后回写规则 |

知识单元使用 YAML frontmatter；`index.md`、`log.md` 和填空模板免检。任务 `context.yaml` 是编码阅读记录，不是 Run Context envelope。根目录及协议包的旧 docs 目录已移除。

## 同步与校验

上游为 [octo-spec](https://github.com/Mininglamp-OSS/octo-spec)。`manifest.yaml` 记录版本和来源提交：`d456507bbd37cd4e3ac58671d07b89a61af35579`，其 VERSION 为 `1.2.0`。同步时使用同一提交的 checkout，升级时一起核对版本与来源。

```bash
# 在仓库根执行；同步全局规则需要指定上游 checkout
GLOBAL_SRC=/path/to/octo-spec bash .octospec/scripts/sync.sh

# 本仓检查覆盖 rules/guides/tasks/journal、索引及全仓 Markdown 文件链接
uv run --with pyyaml python .octospec/scripts/lint.py
```

Python 3 已安装 PyYAML 时也可直接运行 `python3 .octospec/scripts/lint.py`。上游原始 lint 只覆盖其规定的知识目录，不能单独证明 guides 格式或链接正确。

上游 sync 与 block 脚本保持原样；本仓 `scripts/sync.sh` 最后同步中文 `AGENT-BLOCK.md`。全局缓存 `_global/` 被 Git 忽略，新 checkout 先同步才能读取全文。中文命令、workflow skill 与 MR 模板在首次同步时物化到根目录，已有文件不覆盖；修改时同步维护源与物化文件。上游许可证保留在 `LICENSE`、`NOTICE`。

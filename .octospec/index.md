# Octo Runtime 工程知识目录

当前实现基准为 Git `df63c8f` 与本次工作树。当前合同依据源码核对，历史证据独立记录；不把旧设计或曾经通过的测试当作现有功能。工程说明使用中文。

## 当前规则

| 主题 | 入口 |
| --- | --- |
| 总体责任边界 | [基础架构](rules/architecture.md) |
| 身份、Home、profile、安装与生命周期 | [本地 Runtime](rules/runtime-lifecycle.md) |
| 公共输入、默认值与多模态 | [InvokeInput](rules/invoke-input.md) |
| IPC、执行接纳与断流修复 | [本地执行](rules/local-execution.md) |
| 帧、原生模式、canonical 与交互 | [输出协议](rules/output-protocol.md) |
| 纯执行、有界窗口与业务历史 | [状态与容量](rules/stateless-execution.md) |
| 每轮模型输入、控制通道与 cwd | [Context 输入](rules/context-input.md) |
| 未知可选项与业务 extra | [Context 扩展](rules/context-extensions.md) |
| 本轮进程环境变量 | [envs](rules/environment.md) |
| 本轮 MCP 连接 | [MCP](rules/mcp.md) |
| Adapter 执行元数据与实际可用性 | [Adapter 声明](rules/adapter-metadata.md) |
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
- [Extra 配置与调用](guides/extra-configuration.md)：当前 CLI 路径、SDK 和 SSE 示例。
- [本地运维](guides/operations.md)：真实状态、排障和日志。

宿主接入与部署仍由根目录 [INTEGRATION.md](../INTEGRATION.md) 和 [DEPLOYMENTS.md](../DEPLOYMENTS.md) 提供入口；包 README 保留包级用法。

## 历史与取舍

- [删除通用协议业务场景](tasks/remove-business-scenarios/brief.md)：删除场景白名单、ScenarioRequest 及 Node/browser 导出；Channel Gateway Extra 保留业务接入职责，不为 Work App 测试程序保留旧合同。

- [删除业务能力合同](tasks/remove-business-capability-contract/brief.md)：移除自有 capabilities、执行计划能力标签及 ExecutionTarget 预留设计；验证结果单独记录。
- [后续协议简化检查](journal/shared/2026-10-15-protocol-simplification-review.md)：核实业务场景、渠道快照和内部派生参数的真实调用链；其中未消费计划字段按[后续任务](tasks/remove-unused-plan-fields/brief.md)删除，其余为建议。

- [Playboard 统一 daemon 执行](tasks/playboard-daemon-execution/brief.md)：记录绕过 daemon、重复装配 OpenClaw 的问题与改造原因；当前工作树已统一临时 daemon、两层 RPC 和资源隔离，见[验证记录](journal/shared/2026-10-15-playboard-daemon-execution.md)。
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
| `tasks/<slug>/` | `type: Task`，目标、范围、取舍与验收 |
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

# Octo Runtime 开发指引

本项目是内部 TypeScript monorepo。沟通和文档直接使用中文。

先读 [OKF 知识目录](.octospec/index.md) 与 [基础架构](.octospec/rules/architecture.md)。Runtime 是本地运行时设备，AgentExecutor 是统一执行内核，原 AdapterHost 是过渡别名；外部接入由 Extra 负责。本地存在和执行不以登录、云端登记或 IM 建联为前提。

## 目录与命令

- `apps/`：CLI 和 daemon 入口；独立 Host 子进程使用 adapter-host package 的 runner。
- `packages/`：协议、执行内核、daemon SDK、Provider Adapter 和 Extra。
- `test/`：跨包测试；包内测试按各包目录维护。
- `.octospec/rules/`、`.octospec/guides/`：当前合同与操作指南；历史结论放 journal。
- `CLI_USAGE_GUIDE.md`：云端设备的 CLI 使用、部署和运维。
- `SDK_NATIVE_INTEGRATION_FULL_GUIDE.md`：原生启动、特性配置及可选 Agent 调用。
- `SDK_CHANNEL_GATEWAY_GUIDE.md`：仅接入 Octo IM，OctoBuddy 推荐入口。
- `INTEGRATION.md`、`DEPLOYMENTS.md`：选型导航及发行部署入口。
- `pnpm build`：构建 workspace。
- `pnpm typecheck`：构建并检查类型。
- `pnpm lint`、`pnpm lint:names`：代码和命名检查。
- `pnpm test`：构建并运行 Node 测试。

规则正文只维护在 `.octospec/rules/`。本文件和 `CLAUDE.md` 提供入口，不另存一套架构约束。

<!-- octospec:begin -->
## octo-spec 工程规范

本仓库将工程知识保存为 `.octospec/` 下的 OKF Markdown，供各编码 Agent 共用。

1. 修改前读取 `.octospec/rules/_index.yaml`，按路径或任务标签读取命中的规则全文，优先处理 `load_bearing: true`。架构正文在 `.octospec/rules/architecture.md`。
2. 全局规则位于 `.octospec/_global/`，由固定版本同步。同 `id` 的仓库规则覆盖全局规则；中文协作约定见 `rules/collaboration.md`。
3. 非简单代码改动在 `.octospec/tasks/<slug>/brief.md` 记录目标、关键合同、范围和验收依据，在 `context.yaml` 记录实际读取的规则。已有明确需求按用户授权执行；仅在缺少关键决策时询问。
4. 实现后对照规则与验收项检查 diff，按改动范围运行检查。真实接口调试必须连接线上测试环境，验证记录不得包含凭据。
5. 收尾时将可复用结论回写规则，将验证结果写入 journal；`learnings/pending/` 只放待决问题。提交、推送、创建 MR 按用户授权执行。

说明、任务、评审和提交描述直接使用中文；字段、命令及专有名称保留原文。Claude Code 可使用 `/octospec-plan`、`/octospec-go`、`/octospec-check`、`/octospec-finish`，其他 Agent 执行同一流程。

此区块由 `.octospec/scripts/sync.sh` 从本仓库的 `AGENT-BLOCK.md` 同步；修改源文件后重新同步。
<!-- octospec:end -->

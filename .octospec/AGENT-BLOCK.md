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

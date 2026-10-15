---
type: Journal
title: 接入 OKF 工程知识与架构迁移
description: 中文接入 octo-spec，迁移架构正文并记录格式、链接和同步验证。
tags: [architecture, documentation, octospec]
timestamp: 2026-10-15T00:00:00Z
---

# 接入与迁移结果

参考 octo-spec 的两层规则及 octo-server 的 Agent 入口结构，在 octo-runtime 增加独立的 `.octospec/` 知识包。上游来源与版本记录在 manifest；仓库入口、命令、workflow skill、MR 模板和项目规则使用中文。

原 `ARCHITECTURE.md` 定义了当前架构与必须遵守的约束，因此正文迁入 `rules/architecture.md`，声明 `type: Rule`、关键规则标记与触发条件。根目录保留导航页。正文仅调整相对链接，保留原有架构决策、当前实现说明与待确定事项。

原 `CLAUDE.md` 中以 Worker 为前置中心、维护业务持久状态与可靠 outbox 的旧说明，与当前架构及 README 的纯执行约束冲突。入口已改为引用统一规则，不另存一份架构正文。

## 验证

- 上游 OKF lint 通过；系统 Python 缺少 PyYAML，实际用 `uv run --with pyyaml python <octo-spec>/scripts/octospec-lint.py .octospec` 执行。
- 3 条规则的 id、优先级、关键标记和触发条件，与 `rules/_index.yaml` 一致。
- 迁移后的架构正文与 Git HEAD 的原文比较，仅相对链接发生变化。
- 对架构入口、README、两个 Agent 入口、规则正文与知识目录的 54 个本地 Markdown 链接进行检查，全部可解析。
- 同步重复执行后，Agent 入口、知识包、物化命令和 MR 模板的内容 hash 不变；两个 Agent 入口各有唯一的中文受管块。
- 物化脚手架与知识包中的中文源文件一致；全局规则缓存被 Git 忽略。
- `git diff --check` 通过。

本次只修改工程知识、Agent 指引和同步脚手架，未修改 Run / Context 或运行时代码。未运行构建、模型执行、桌面 CDP 或线上测试环境联调。

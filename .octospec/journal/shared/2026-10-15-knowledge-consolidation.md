---
type: Journal
title: 全量文档整理与 docs 移除验收
description: 记录当前实现核对、31 份材料取舍及文档工具校验范围。
tags: [documentation, migration, verification]
timestamp: 2026-10-15T00:00:00Z
implementation_baseline: df63c8f
---

# 整理结果

以 Git HEAD `df63c8f` 和工作树源码为基准，逐份审查根 docs 的 30 份文件及协议包的 InvokeInput 指南。对应关系见 [审查表](../../tasks/consolidate-runtime-knowledge/migration-review.md)，当前内容入口见 [知识目录](../../index.md)。

- 架构及当前合同归入 19 条规则；构建、开发、配置和运维步骤归入 5 份指南。
- Git 演进节点、已撤回设计的问题和当前替代归入 [架构演进](architecture-evolution.md)。旧方案全文留在 Git，不在当前知识库镜像。
- 原有实测保留日期、结果和失败范围，合并到 [历史验证摘要](provider-validation-history.md)，不作为本次重新验证通过的证据。
- 移除根 docs 与协议包 docs，更新项目入口和包 README 的本地引用。根 `ARCHITECTURE.md` 保留导航，正文位于规则目录。

核对时修正了旧公共 invoke 包装、已移除的 Worker 注册与业务调度器描述、过时的 OpenClaw 绑定前提，以及未落地的 Extra 布局与启动教程。当前执行链路的责任、字段和容量约束分别引用源码，避免把提案写成已实现能力。

整理期间工作树出现的渠道默认工作目录实现已核对到相应规则；相关源代码、测试与其他 INTEGRATION 编辑保持原有改动，不纳入本次文档任务的实现或验收结论。

## 本次验证

- `uv run --with pyyaml python .octospec/scripts/lint.py`：知识单元格式、规则索引一致性、全仓 Markdown 本地文件链接和旧目录缺失检查通过。
- 上游 `scripts/octospec-lint.py .octospec`：其覆盖目录中的 OKF 格式检查通过；本仓扩展的 guides 由本地 lint 补充覆盖。
- `node scripts/lint-names.mjs`：通过，无命名发现或例外。
- `git diff --check`：通过。
- 指定 manifest 来源的上游 checkout 运行中文 `scripts/sync.sh`，比较同步前后知识包、Agent 入口和物化脚手架的文件 SHA-256，内容均未改变；全局缓存不参与比较。

本次只整理工程知识与文档工具，没有修改执行协议或 Runtime 行为，没有运行构建、模型调用、桌面 CDP 或线上测试环境联调。历史记录中的成功、失败和未验收项仍按原日期理解。

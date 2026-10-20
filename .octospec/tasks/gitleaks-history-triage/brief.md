---
type: Task
title: 历史 Gitleaks 告警核验与精确处置
description: 核验 Issue 22 的 45 条历史告警，仅对确认非秘密内容添加精确例外。
tags: [security, git, testing]
timestamp: 2026-10-19T13:13:00Z
slug: gitleaks-history-triage
source: self
upstream: https://github.com/Mininglamp-OSS/octo-runtime/issues/22
---

# 历史 Gitleaks 告警核验与精确处置

## 目标与固定基线

处理 Issue #22 报告的 45 条历史告警，保留新增凭据模式的检测。

- 原失败提交：`62d10ac46e7c2c3505b42c362229f7b91f328e5b`。
- 实施开始 main：`ab3ded527db4599f50bbab4c2045b4b025086f3d`，后续复现固定于该 SHA。
- Gitleaks：`8.30.1`，官方二进制经 SHA256 校验，使用内置规则。
- 调用方：`reusable-secret-scan.yml@v1`，记录的解析值为
  `8feb64b77fcd794571ba9a959f7f745bc7a0650c`。

## 责任与范围

历史例外由本仓库维护方审核。用户授权提交 Runtime PR 并关联 #22。
本 PR 包含精确指纹例外、逐条分类台账、隔离验收脚本及维护说明。
保留现有扫描版本、完整历史/PR 范围、内置规则、日志脱敏与工作流引用。
不重写历史，不改动 Runtime、SDK、Provider 或产品执行行为。

## 验收

1. 固定 SHA、refs 和版本复现历史告警，记录与原 CI 的计数差异。
2. 每个指纹有分类、源码依据和处置；待确认项、未处置真实凭据继续阻塞完成。
3. 只添加原始 `commit:file:rule:line` 例外，不排除目录、字段、整个提交或规则。
4. 隔离仓库保留原始历史，使例外实际命中；当前修复的完整历史与 PR 扫描均无告警。
5. 在原路径、原行号及邻近行加入非功能性 canary，完整历史和 PR 扫描均须拦截全部 19 条。
6. 验证显式配置缺失、无效 TOML 仍退出非零；证据和日志不包含候选值。
7. 本地结果与 GitHub 托管结果分别记录。
8. 命名检查仅允许已核验历史证据的固定内容快照保留原路径；内容变更、追加旧名及其他文件中的旧名仍须失败。

45 条均已核验为非秘密内容，待确认 0，确认凭据泄露 0。
详见[逐条台账](findings.md)和[验证记录](../../journal/shared/2026-10-19-gitleaks-history-triage.md)。

---
type: Journal
title: Issue 22 历史 Gitleaks 告警处置与验收
description: 45 条历史误报的精确例外，以及完整历史和 PR 模式中的新增密钥模式回归。
tags: [security, git, testing]
timestamp: 2026-10-19T15:10:00Z
source: self
---

# 历史 Gitleaks 告警处置与验收

关联 [Issue #22](https://github.com/Mininglamp-OSS/octo-runtime/issues/22)、
[任务 brief](../../tasks/gitleaks-history-triage/brief.md) 和
[逐条台账](../../tasks/gitleaks-history-triage/findings.md)。

## 修复与分类

固定 main 为 `ab3ded527db4599f50bbab4c2045b4b025086f3d`，
原失败提交为 `62d10ac46e7c2c3505b42c362229f7b91f328e5b`。
两个基线复现出完全相同的 45 个指纹：
资源 UUID 30 条、会话测试标识 14 条、本地合成演示口令 1 条。
全部已核验为非秘密内容，待确认 0，确认真实凭据 0。
没有执行候选值网络探测或凭据撤销/轮换操作。

根目录 `.gitleaksignore` 新增 45 条原始提交 SHA 的精确指纹，
每条有台账编号和依据；没有目录、字段、整个提交或规则豁免。
Gitleaks 内置规则、现有工作流和 `@v1` 引用保持不变。

## 验证方法与证据

使用 Gitleaks 8.30.1 官方 Windows x64 ZIP，已核对官方 SHA256：
`d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e`。
环境为 Windows 11 build 22621、x64、Python 3.11.9、Git 2.55.0.windows.5。

[验收脚本](../../tasks/gitleaks-history-triage/verify.py)从隔离仓库根执行实际扫描命令；
JSON 运行仅增加脱敏报告参数，另执行不带报告参数的原样命令。
临时仓库保留原始 SHA 及祖先、不增加额外分支或标签，使历史例外实际生效。
canary 仅在本地隔离提交中生成，不执行这些文件或访问外部服务。

| 检查 | 实际结果 |
| --- | --- |
| 两个固定基线，无例外 | 各 45 条相同指纹，退出 1 |
| 两个固定基线应用例外 | 各 0 告警，退出 0 |
| 修复候选，完整历史 / PR | 均 0 告警，退出 0 |
| 移走例外文件 | 原 45 条重现，退出 1 |
| 显式配置缺失、无效 TOML | 均退出 1 |
| 7 个历史路径中的 19 条 canary，完整历史 / PR | 均精确检出全部 19 条，退出 1 |
| 原样命令 | 干净候选退出 0，canary PR 退出 1 |

Canary 覆盖资源标识、三种会话字段、原行号及邻近行、curl 授权头和内置 github-pat 规则。
此前的历史证据及 canary 提交保留，PR 收尾通过 `--reuse-evidence` 复用；
当前文件另复制到隔离候选，验证内容与本 PR 一致。
每轮 `summary.json` 记录实际 SHA、命令参数、计数和退出码，同目录保存脱敏报告与日志。

## 结果边界与维护

原基线 Git 可达 477 个提交，Gitleaks 报告 444；main 分别为 498 和 463。
Issue 原 CI 报告 454，其完整 refs 未保留，不宣称本地精确还原该次 CI 扫描范围。
两个本地基线的完整指纹一致，规则/文件分布与 Issue 相符，详见台账。

CI 文档 Prettier 与 diff 检查通过。OKF 完整文档门禁存在 14 个基线已有的跨仓链接缺失，
本次新增错误 0；未为通过检查创建虚假文件。
本次不修改 TypeScript 或产品运行代码，不运行无关的构建、Provider 或模型联调。
GitHub 托管检查以 PR 上的实际运行结果为准；本地验证不能代替托管验收。

维护者新增例外前须核验来源与用途，待确认告警和未处置真实凭据继续阻塞。
操作说明见 [CI 指南](../../../.github/CI.md)，合同已回写
[开发与验证规则](../../rules/engineering.md)。

## 2026-10-20：rebase 与命名检查兼容

PR #45 已 rebase 到 main `7fb81e930675c62897e436828b5a1fcdc8c99f40`。
该轮 GitHub Secret Scan、History Check 和 Windows 发行验证通过；
Linux/macOS 的 `lint:names` 把两份历史证据中的原始旧路径判为现行命名违规。
这是本 PR 原先遗漏的验收项，未通过不应描述为整体 CI 成功。

在现有命名检查中按文件路径及规范化行尾后的 SHA256 识别两份已核验内容快照，
仍逐行报告历史例外；没有把文件或目录排除于扫描，也没有改写原指纹和分类台账。
内容修改、附加旧名、复制到其他路径及其他文件中的旧名继续失败。
`test/name-lint.test.js` 的 7 项本地回归通过，包含 LF/CRLF 与上述拒绝场景；
隔离扫描验收脚本同步复制本次命名检查及测试文件。
本地与后续 GitHub CI 结果分别记录，以 PR 对应提交的实际检查为准。

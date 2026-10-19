---
type: Task
title: 稳定 tag 直接发布 npm 与 GitHub Packages
description: 从同一份已验证归档直接交付两个 registry，保持源码占位版本、不可变内容及 latest 单调一致性。
tags: [release, npm, github, testing]
timestamp: 2026-10-19T00:00:00Z
---

# 目标与意图归属

用户明确要求后续不使用 `npm stage publish`，每个新 tag 直接发布 npm 和 GitHub Packages。
GitHub Packages 指 `npm.pkg.github.com`，不是 GitHub Release 的附件；现有 Release 交付继续保留。
这是发行基础设施职责，不改变 Runtime、SDK、Adapter 或宿主产品策略。

# 合同与范围

- 源码及内部 workspace 保持 `0.0.0`，仅发布单一公开根包；稳定 annotated tag `vX.Y.Z`
  仍是发行版本来源，不额外开放 rc/dev 版本或自动创建 tag。
- 完整 CI 矩阵只产生一份经验证的 tgz，npm、GitHub Packages 和 Release 消费相同字节。
- 两个 registry 都执行直接 `npm publish`，没有 stage、approve、reject 或自动修改安全策略。
  npm 使用 `NPM_TOKEN` 和 provenance；GitHub Packages 使用有 `packages: write` 的
  `GITHUB_TOKEN`，不伪造 npm provenance。
- 两个 registry 独立并行交付，均先使用 `release-X.Y.Z`，已有版本必须匹配完整 integrity。
  认证、网络和无效 metadata 错误不能被解释为 404；公开延迟有界等待，超时准确报告未完成。
- 部分交付恢复必须从已存在的任一 registry 验证原提交并复用 buildTime，不能重建不同内容覆盖
  不可变版本。控制脚本来自当前 workflow commit，发行源码仍固定 tag commit。
- 完整交付指两个 registry 及 GitHub Release 资产均就绪；三个 latest 指针只向共同完整的最高
  稳定版本收敛，旧版本补发和并发恢复不得回退。
- dry-run 不发布包、不改 dist-tag、不创建或修改 Release。真实发布、组织策略修改、删除已有
  暂存版本和再发历史版本不属于本次代码验证范围。

# 验收

1. workflow 使用双 registry matrix、显式 registry/auth/provenance，且无暂存发布命令。
2. 同内容跳过、不同内容拒绝、404 等待、401/403/网络错误、超时均有可执行单元测试。
3. npm 缺失而 GitHub Packages 已存在时，恢复原 buildTime 并校验 commit/clean/integrity。
4. promotion 覆盖双 registry 交集、integrity 冲突、三个 latest 指针及历史版本恢复；原双端测试保留。
5. 定向测试、格式、workflow YAML/actionlint 和双轴评审通过；不把本地结果当作真实 registry 发布验收。

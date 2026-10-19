---
type: Task
title: 仅发布 npm 官方仓库并恢复稳定版 latest 自动推进
description: 移除未经需求要求的 GitHub Packages 发布、恢复与晋升依赖，保留单一 npm registry 和稳定版 latest 单调合同。
tags: [release, npm, testing]
timestamp: 2026-10-19T00:00:00Z
---

# 目标与授权

用户授权先把 npm `latest` 调整为已公开的 `1.0.1`，再从最新 main 开独立 worktree 修复 CI；npm registry 只有 `https://registry.npmjs.org`。删除已有的 octo-runtime GitHub Packages，不删除 npm 版本或 GitHub Release 附件。用户随后确认已手动删除 GitHub Packages，并授权将本 worktree 建分支、提交、推送、创建 PR 并合并进入 main；不创建新版本或发行 tag。

# 合同与范围

- 本任务属于发行基础设施，不改变 Runtime、Adapter、Extra、Home 或业务输入；维护者决定发行版本，CI 只消费明确的 tag。
- 移除 GitHub Packages matrix job、token 配置、packages 权限、构建恢复回退源及 latest 查询和写入。
- 稳定 annotated tag `vX.Y.Z` 直接发布同一份验收归档到 npm，并交付 GitHub Release；自动将 latest 推进到最高完整稳定版。历史补发不得回退指针。
- RC 和其他预发布不进入稳定版本候选集，不调整 latest。不新增自动 RC 发布路径。
- 保留不可变版本 SHA512、clean commit、构建时间恢复、上传后有界等待、dry-run 零写入和 latest 并发协调。
- 删除 GitHub Packages 前必须确认组织、包类型和包名，只删除本项目的 npm package；凭据权限不足时报告真实阻塞，不扩展权限或误删其他包。

# 验收

回归覆盖单一 registry、版本升级 latest、旧版恢复不回退、RC 不晋升、空响应明确失败、认证错误不当作缺包、异步可见性等待及同版本构建时间恢复。运行相关 Node 测试、格式和 workflow 检查。线上核对 npm latest 为 `1.0.1`，如删除权限具备则确认 GitHub package 不再存在。

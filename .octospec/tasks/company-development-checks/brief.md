---
type: Task
title: 首次公开 PR 的协作说明、CI 完整性、格式与 main 保护
description: 按用户授权补齐四项工程流程，统一 Node 24.x，不修改运行协议或插件业务行为。
tags: [ci, testing, documentation, git]
timestamp: 2026-10-17T00:00:00Z
---

# 首次公开 PR 的工程检查

## 目标与边界

用户确认先实施英文协作说明、CI 测试完整性、main 合并保护和格式检查，Node 必须为 24.x。决定权属于仓库维护流程，不改变 SDK、Extra 或 Provider 产品行为，不触碰既有 Home、身份与配置，不创建或合并 PR。

## 方案

- 更新 CONTRIBUTING 和 GitHub CI 说明为英文，描述当前 SDK/AdapterHost/Extra 架构与真实命令。公开 PR 使用英文，内部中文约定保留并明确适用范围。
- 本地 pnpm test 与 CI 共享 test:suites，CI 复用前序构建。仓库已有调试 WebUI 测试保留，不扩展为生产 UI 或浏览器端到端验收。
- engines 限制 >=24 <25，.nvmrc 为 24，CI 从该文件取版本；npm 发布现有固定 24 保持一致。
- Prettier 覆盖自有源码、测试、脚本、JSON/YAML 配置、GitHub 协作文件与 CONTRIBUTING；统一修复此范围内的存量格式。排除生成物、锁文件及上游同步浏览器源码，不机械改写历史知识记录和架构文档。
- main 要求 PR、一次批准、清除过期批准、解决评审会话、分支基线最新，以及来自 GitHub Actions 的 CI Gate。管理员同样适用，禁止强推和删除。
- CI Gate 必须等待整个 Ubuntu/macOS 矩阵，失败、取消或跳过均不能当作成功。此固定名称可在首次 PR 前配置，不依赖尚未运行的嵌套安全检查名称。

## 验收

格式检查、lint、命名检查、类型构建、共享完整测试及打包/离线验证通过；生成协议无漂移。GitHub API 回读 main 保护并核对设置。真实 PR 的 hosted runner 仍须首次 PR 后验收，不将本地成功写成远端成功。本轮不接入 Project/Sprint、CODEOWNERS 或额外安全工具。

---
type: Task
title: 首次 PR 的干净安装与依赖扫描修复
description: 针对 GitHub hosted runner 暴露的构建脚本许可和开发依赖漏洞修复配置，保留严格门禁并请求指定评审。
tags: [ci, testing, dependency, git]
timestamp: 2026-10-17T00:00:00Z
---

# 首次 PR 的 CI 修复

用户授权提交 PR 后明确不执行合并，由 Review 流程处理。PR #1 已创建，按用户指定请求 Jerry-Xin、yujiawei 与 mochashanyao，未启用自动合并。

## 已确认的失败

- Dependency Review 首次无法读取图；对仓库调用 vulnerability-alerts 启用 API 后，依赖 compare 从 403 恢复 200，返回 437 条变更。此前 alerts 查询为 true，不能把该字段直接当成依赖图 API 可用的证据。
- Ubuntu/macOS 都在 pnpm 冻结安装时报 ERR_PNPM_IGNORED_BUILDS：@parcel/watcher@2.6.0；尚未进入模型或测试执行。新增针对该已锁版本的 allowBuilds 许可，其他包继续严格校验。已读取安装脚本：仅在显式 build_from_source 时调用 node-gyp，普通平台使用其预编译可选包。
- 图恢复后发现 happy-dom 18.0.1 和 brace-expansion 5.0.9 的已知漏洞，升级测试依赖至修复版本。happy-dom 保持 20.x，最低 20.8.9 覆盖当前三个告警；brace-expansion 在原有传递依赖范围内刷新，不新增通用忽略或降低严重性门槛。

## 验收

先完成冻结安装、本地完整测试与构建，再推送当前 PR，查看真实 Ubuntu/macOS 及 Dependency Review 结果。不得以本地已有缓存安装或关闭依赖扫描代替干净 runner 验收。生产 Runtime 配置、Home、身份与协议不变；不执行合并。

本地验证已通过：冻结安装及全工作区构建；ESLint、命名、格式、根 TypeScript 检查；WebUI 35 项通过；Node 1083 项中 1074 项通过、9 项条件跳过、0 项失败；单包打包及空缓存离线安装、公开 API、Extra 加载和卸载保留 Home 验证通过。实际锁定 happy-dom 20.14.6、brace-expansion 5.0.12。远端结果以当前 PR 最新提交的 Checks 为准。

28e018e 的远端 Dependency Review 已通过，依赖图 compare 未发现漏洞；两个平台均通过冻结安装和 ESLint。随后命名检查报 spawnSync rg ENOENT，确认 runner 缺少脚本依赖的 ripgrep。在 CI 中用平台包管理器显式安装，并在英文协作说明声明本地前置依赖；保留现有命名扫描规则。

## 自动评审

参考 octo-server 的 CODEOWNERS 原生机制，本仓对所有路径配置三位指定用户，不增加自动请求评审的工作流。三位均已核验具备仓库写权限，并在 PR #1 请求成功。GitHub 按目标分支的 CODEOWNERS 自动请求，因此首个 PR 手动请求；文件经评审合入 main 后，后续非草稿 PR 或草稿转为可评审时自动请求。作者本人不作为自己的评审人。请求三人不等于要求三票通过，main 仍要求至少一位批准；未改为三位全部批准。

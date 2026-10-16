---
type: Task
title: SDK 宿主统一 pnpm workspace 接入
description: 子模块固定在 octo-runtime，宿主统一安装并通过 workspace 协议引用内部包。
tags: [documentation, installation]
timestamp: 2026-10-16T00:00:00Z
---

# SDK 宿主统一 pnpm workspace 接入

## 目标与归属

用户明确选择宿主独立 pnpm workspace：Runtime 作为 `octo-runtime/` submodule，先配置宿主 `pnpm-workspace.yaml`，再添加 `workspace:*` dependencies。宿主拥有包管理、构建和最终打包的决定权；Runtime 提供正确的内部依赖声明与现有 build。无需新增宿主构建 script。

## 范围与合同

同步 Gateway、完整 SDK 指南及工作区指南。宿主纳入 `octo-runtime/packages/*`，统一根目录安装、过滤构建和 lockfile；不纳入 CLI 根包及 apps。公共包按内部依赖自动链接，宿主直接 import 时才增加直接依赖。

干净安装发现 ACP、Claude Code、CodeBuddy、Codex、OpenClaw、OpenCode、ZCode GUI 直接 import protocol，却未声明该直接依赖。修复各 Adapter manifest 并同步 Runtime lockfile，避免依赖原仓根包间接提供解析路径。不改变执行逻辑、公开协议、加载集合、安装决策或已有 Home/身份/配置。

## 验收

在没有 node_modules/dist 的仓库副本中，保持子仓原 workspace 文件及 lockfile，仅通过宿主安装并构建 Gateway 依赖闭包；验证五个直接包的真实 Node import 和公共包链接，验证宿主 frozen-lockfile 重装。校验文档 JSON/YAML、OKF、本地链接与 diff。此项验证不启动 Provider 或接入 IM，不作为线上执行验收。

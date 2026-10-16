---
type: Task
title: 按宿主操作拆分 SDK 指南
description: 从已有 Electron 项目出发，提供完整原生接入和 Channel Gateway 两条可执行路径。
tags: [documentation, runtime, installation]
timestamp: 2026-10-16T00:00:00Z
---

# 按宿主操作拆分 SDK 指南

用户要求减少开场概念，拆成 SDK_NATIVE_INTEGRATION_FULL_GUIDE.md（启动、特性配置、可选 Agent 调用）与 SDK_CHANNEL_GATEWAY_GUIDE.md（仅 Octo IM，OctoBuddy 推荐）。两篇从已有 Electron 项目加入 git submodule 开始，明确 package.json、workspace、Codex/OpenClaw 的注册、主进程启动、IM config 及 SDK 重载。

本任务属于接入文档组织与示例，不改变 SDK API 或业务运行行为。使用当前 startAccount、invoke、loadExtra/unloadExtra，不发明 agentRequest 或 reload SDK 方法。配置来源归宿主；Channel Gateway 示例由宿主读取文件，将已准备的值传给 SDK。

验收：两篇可按步骤操作；内部 workspace 依赖及传递依赖区别明确；示例严格 TypeScript 检查和 JSON 配置检查通过；当前文档链接及章节锚点迁移；旧入口仅导航。保持 Runtime 身份、Home 和现有数据，不启动服务或进行线上联调。

后续修正：用户明确子仓位于当前项目的 `octo-runtime/` 下，使用相对路径引用具体 package，不修改宿主 pnpm-workspace.yaml，也不改变 Runtime 各包声明。示例使用 `link:./octo-runtime/packages/<包目录>`，子仓独立安装与构建；说明直接依赖、protocol/core/adapter-sdk 等传递依赖和正式发行依赖闭包的区别，并验证无宿主 workspace 的真实导入。上一轮绝对路径版本是 Agent 对需求的误解，不是接入要求。

---
type: Journal
title: CLI 使用与 SDK 原生接入指南分拆
description: 按用户确认的场景拆分指南并迁移当前入口，保留命令与 SDK 示例。
tags: [documentation, runtime, installation]
timestamp: 2026-10-16T00:00:00Z
---

# CLI 使用与 SDK 原生接入指南分拆

用户确认 CLI 默认包含全部 Adapter、Extra，以及系统管理、开启自启等服务能力；用于云端设备的定制接入与运维。Electron、Tauri 2 桌面程序必须 SDK 接入，严禁把 CLI 作为接入层。

新增 [CLI 使用指南](../../../CLI_USAGE_GUIDE.md)和 [SDK 原生接入指南](../../../SDK_NATIVE_INTEGRATION_GUIDE.md)，各自先说明背景和适用场景。[INTEGRATION.md](../../../INTEGRATION.md)收敛为选型导航，当前 README、开发、部署、包级和工程知识入口同步迁移。历史记录保留原文件引用，用于追溯当时的文档。

现有命令、JSON 和 TypeScript 示例迁移到各自指南。明确发行物包含、组件启用、系统自启注册及 Provider 准备是不同事项；SDK 宿主仍自行决定配置来源、依赖与装配范围。Tauri 2 需宿主提供 Node.js 辅助进程承接 SDK，不宣称已有 Tauri 插件。

核对源码时修正文档的两处旧描述：CLI 和 SDK 已分别管理 Adapter 默认加载集合；Playboard 整请求上限为 32 MiB，与公共 INVOKE_REQUEST_MAX_BYTES 一致。SDK 不增加 API，也不改变发行或运行代码。

## 验证范围

验证通过：`uv run --with pyyaml python .octospec/scripts/lint.py` 检查 153 个 OKF 单元、20 条规则和 1100 个本地文件链接；32 处新指南链接及章节跳转有效。迁移前后 13 个 CLI 代码块和 7 个 SDK 代码块逐字一致，`git diff --check` 通过。

此任务仅修改文档，不启动或重启 Runtime，不修改既有 Home、身份、配置及 SQLite，不进行线上联调。

## 后续阅读顺序修正

按用户反馈，安装段先列建议安装的 `@mininglamp-oss/octo-cli` 工具包，再单独说明提供 `octo-runtime` 命令的 Runtime 发行包。第 4 节改为“接入 Octo IM”，先给 Codex / Claude Code（CC）类型和 OpenClaw 类型配置，再给启动与状态命令，最后集中说明配置字段和多 Bot 管理。不再使用“方案一／方案二”；CC 使用真实的 `claude-code` 配置值，切换时省略 Codex 示例中的模型和思考强度。相关章节链接同步迁移。

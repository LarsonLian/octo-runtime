---
type: Task
title: CLI 帮助与命令入口修正
description: 展示发行版本、统一分层帮助并删除不需要的命令入口。
tags: [cli]
timestamp: 2026-10-15T00:00:00Z
---

# 范围与验收

裸命令显示 `Octo Runtime CLI (根 package.json 版本)` 和用途。支持 `--version`、`-v` 与 `version`。参考 octo-cli 的 Usage、Available Commands、Flags 分层帮助，支持子命令帮助。

删除 CLI 的 extra status/load/unload、adapter connect 和 agent-run get/cancel；SDK 与内部 IPC 保持原合同。daemon 命令组只显示帮助，子命令按 start/stop/restart/status/install/uninstall/run 排序。playboard 在最后，帮助包含可运行 JSON 示例及文档参考。

帮助、版本、错误参数不得初始化 Home 或启动服务。保留现有身份、配置和运行状态。构建、类型、lint、CLI 回归与发行包全局命令验证分别记录。

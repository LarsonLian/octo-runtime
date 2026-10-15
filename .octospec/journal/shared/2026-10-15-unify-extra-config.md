---
type: Journal
title: 统一 CLI 与 daemon 的 Extra 配置入口
description: 删除渠道专用配置路径并验证多 Bot 完整配置保存和重启加载。
tags: [extra, channel, testing]
timestamp: 2026-10-15T00:00:00Z
---

# 结果

删除 channel configure、CLI 的渠道文件适配器、启动时 Bot 文件发现和渠道模块隐式装配；删除插件公开的 readImBots/loadImBots 文件读取 API 及专用 activate 脚本。CLI/daemon 不直接依赖任何 Extra 包，也不根据 Bot 配置初始化 OpenClaw 连接。唯一 CLI 文件入口为 `<home>/default/extra/<name>/config.json`。

extraset 保存完整插件声明，不理解或合并 Bot 字段。多个 Bot 由插件自己的 config.bots 数组表达，名称缺省值由插件内部处理。不迁移、删除或回退读取现有本机旧文件。历史渠道配置验证记录反映当时实现，以本次合同为准。

验证：workspace 构建和 TypeScript 检查通过；专项 42 项通过，涵盖多 Bot 数组原样保存、整份替换、凭据文件权限、插件加载与新 CLI daemon 进程启动。并发构建曾清理 dist 导致测试模块缺失；构建结束后重新执行全量测试，共 735 项，728 项通过、7 项跳过、0 项失败。全仓 lint 仍有 26 项错误，未报告通过。

线上测试环境 verify-bot 空凭据探针返回 400；没有有效测试 Bot 凭据，未执行真实 Bot 鉴权与消息收发。未改动生产配置。本次未修改 Run/Context 协议或桌面 UI。

---
type: Task
title: 统一 Extra 配置入口
description: 移除 CLI 与 daemon 的渠道专用配置及隐式装配。
tags: [extra, channel]
---

# 目标与合同

CLI/daemon 只处理 Extra 声明及 JSON 结构，插件自己解释 Bot 数组和默认值。删除 channel configure、渠道文件读取 API、隐式模块装配及基于 Bot 的 OpenClaw 配置发现，不保留历史兼容或自动迁移。

## 验收

构建、类型检查、相关测试及 lint；配置多个 Bot、整份替换及重启加载统一通过 Extra 验证。真实接口仅使用 im-test，缺少有效测试凭据时如实记录验证边界。

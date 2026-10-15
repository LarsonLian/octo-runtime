---
type: Journal
title: 移除旧安装脚本入口
description: 独立 CLI 统一使用 npm 安装，移除偏离当前设计的 installers 说明与引导。
tags: [installation, documentation]
timestamp: 2026-10-15T00:00:00Z
---

# 设计与范围

用户明确目标：独立 CLI 使用 `npm install -g @mininglamp-oss/octo-runtime`，旧 installers 的多系统安装及在线设备登记流程不再适用。

当前仓库的 installers 目录只剩 README，脚本此前已移出。删除剩余说明文件，README 与 DEPLOYMENTS 统一介绍 npm 安装，移除技能中的 installer 发布措辞。仓库外的历史归档不属于本次修改范围。

保留 CLI 的本机 daemon 用户服务管理；它负责本地运行和自启。安装不隐式执行云端登记，业务接入由可选 Extra 管理。未修改执行代码、协议、发行脚本或既有 Runtime Home、身份、配置与运行状态。

# 验证范围

本次仅变更文档与删除说明文件，检查知识格式、Markdown 链接及残留安装入口；不触发线上登记、真实模型执行或服务重启。

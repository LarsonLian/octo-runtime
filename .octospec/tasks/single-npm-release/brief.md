---
type: Task
title: 单一 npm CLI 发行物
description: 内部模块随根版本一起交付，不单独发布。
tags: [installation]
timestamp: 2026-10-15T00:00:00Z
---

# 单一 npm CLI 发行物

对外仅发布 `@mininglamp-oss/octo-runtime`，提供 `octo-runtime` 命令。
保留 workspace 开发结构，内部包禁止独立发布；生成产物时版本统一取根 package.json。
生产依赖实体化并通过 npm bundleDependencies 打包，避免安装端访问内部包 registry。
根包不提供 SDK exports。程序升级不修改 Home、身份、profile 或配置，不自动安装 Provider。

验收：构建与类型检查、产物无源码及 workspace/link 依赖、隔离离线安装、CLI help、真实 daemon 与 Adapter 动态加载。
本次不改变接口和协议；线上测试环境可达性与本地安装验收分别记录。

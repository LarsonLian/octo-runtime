---
type: Task
title: 移除 AdapterHost app 启动壳
description: apps 收敛为 CLI 和 daemon，继续独立启动 package runner 并保留 CLI 功能。
tags: [architecture, runtime, testing]
timestamp: 2026-10-15T00:00:00Z
---

# 移除 AdapterHost app 启动壳

用户确认移除 `apps/adapter-host`，保留 `octo-runtime` 及全部现有子命令。当前 app 只转入 package runner，SDK 已使用该 runner，CLI daemon 的默认路径和发行脚本仍依赖旧 app。

## 合同与范围

- 先更新基础架构，再删除 app 源码、manifest 和构建配置。
- CLI daemon 默认通过 package exports 解析 `@mininglamp-oss/octo-runtime-adapter-host/runner`。继续独立 spawn Host，经 stdio RPC 执行；保留显式入口覆盖和现有监督恢复。
- 更新根脚本、发行打包、workspace lock、测试路径及当前文档。可复用的进程边界说明归入 package README。
- `octo-runtime` 命令、参数及功能保持；Run=7、Context=v3、RPC 合同保持。保留已有 Home、Runtime 身份、profile、配置和运行状态，不重新安装 Provider。

## 验收

- apps 只保留 CLI 与 daemon 的 workspace，当前执行和发行路径不引用已删除 app。
- lint、类型检查、跨包测试通过，覆盖 CLI 控制、Playboard 执行、取消及 Host 异常恢复。
- npm 发行物在隔离目录离线安装后，全局 CLI 可运行，daemon 能启动 package runner 并动态加载 Adapter；卸载保留测试 Home。
- 连接 `https://im-test.deepminer.com.cn/` 记录线上测试环境的实际结果，区分自动化执行证据与线上验证范围，不记录凭据。

实施和验证结果写入 journal，不以目标条目代替通过证据。

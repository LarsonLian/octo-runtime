---
type: Journal
title: 无登录安装和运行的验证记录
description: 删除 CLI login，验证空 Home 初始化、重复执行保留数据及真实前台进程就绪。
tags: [runtime, lifecycle, installation, testing]
timestamp: 2026-10-15T00:00:00Z
---

按用户最新要求直接删除 CLI login，不保留兼容命令，连同其 prepare/recover update 分支及未使用类型一并移除。daemon install/run 在 setup lock 内只准备缺失的默认配置和 machine identity；显式 OpenClaw 连接也无需登录。已有 Home、身份、凭据与配置不重置。

- `pnpm typecheck`：构建及类型检查通过。
- `pnpm lint`：通过。
- `node --test test/cli-home.test.js test/cli.test.js test/profile-layout.test.js test/cross-service.test.js`：22 项通过。覆盖空 Home 安装、默认路径与显式路径、重复安装/运行保留原配置和身份、非法 schema 拒绝及 login 命令移除。
- 真实 CLI 前台进程：以新建 `/tmp/od-home-*` Home 和测试 Adapter manifest 启动，IPC status 返回 `ready: true`，默认配置为 schema 1、default profile、stable channel，machine identity 已生成；SIGTERM 后退出码为 0，随后清理本次临时目录。
- 全局 `octo-runtime` 链接目标已核对为当前 checkout；本次已重建发行文件。未改动或重启既有常驻服务。

本次未修改 UI、Run/Context 协议或外部接口，未进行云端认证和 im-test 渠道联调。原生服务安装通过测试 backend 和现有跨平台 backend 回归验证；未替换本机已有服务定义，Windows 未实机验证。

---
type: Task
title: CLI 使用与 SDK 原生接入文档分拆
description: 按使用场景拆分接入正文，明确桌面应用必须 SDK 接入与 CLI 全量发行范围。
tags: [documentation, runtime, installation]
timestamp: 2026-10-16T00:00:00Z
---

# CLI 使用与 SDK 原生接入文档分拆

## 用户决定与范围

CLI 的职责是使用，SDK 的职责是接入。CLI 默认包含全部 Adapter、Extra，以及系统管理、开启自启等服务能力，仅用于云端设备的定制接入、部署和运维。Electron、Tauri 2 桌面程序严禁通过 CLI 接入，必须 SDK 接入。

据此新增 CLI_USAGE_GUIDE.md 与 SDK_NATIVE_INTEGRATION_GUIDE.md，开头各自说明背景和适用场景，原 INTEGRATION.md 仅作导航。现有 CLI 命令、SDK API 和示例迁移到各自指南；不新增接口，不改运行行为、发行物依赖、Home、身份或配置。文档组织及桌面接入方式属于用户已明确的产品决定。

发行物默认包含组件与组件实际启用分开说明：安装 CLI 不表示全部 Extra 已启用或已注册系统自启；Provider 软件及认证仍按使用范围准备。SDK 宿主自行决定配置来源、依赖及装配范围。

## 验收

- 两份指南按场景独立阅读，旧文件仅保留导航；当前 README、开发、部署和包级入口转到新指南。
- 桌面应用必须 SDK 接入，SDK 管理子进程及 Provider CLI 的事实不改变。
- SDK TypeScript 代码块保持完整；CLI 命令和 JSON 示例不因迁移丢失。
- OKF 校验、本地文件与新指南章节链接检查、git diff --check 通过。

验证记录见 [分拆记录](../../journal/shared/2026-10-16-cli-sdk-guides-split.md)。

---
type: Journal
title: CLI 默认 JSON 与 SDK 直接 import 的实现验证
description: 默认来源拆分、独立 Host 入口、接入注释要求及验收范围。
tags: [architecture, adapter, sdk, verification]
timestamp: 2026-10-15T12:50:00Z
---

# CLI 默认 JSON 与 SDK 直接 import

## 交付行为与理由

依据[装配归属任务](../../tasks/adapter-composition-ownership/brief.md)，CLI 默认清单移到 [apps/cli/src/default_adapters.json](../../../apps/cli/src/default_adapters.json)，构建到 CLI dist，由 CLI daemon 和 Playboard 使用。删除根共享 JSON 及 SDK 复制脚本，使目录归属与产品决策一致。

SDK 的 [独立 Host 入口](../../../packages/octo-runtime-daemon/src/runtime/adapter-host.ts) 直接 import 并注册 Adapter，保留当前 12 项选择。客户维护自己的入口并通过 distribution.adapterHostEntrypoint 传路径，即可只导入所需项；不要求用户准备另一份 JSON。SDK runner 的默认路径不再指向复制清单，显式 manifest 覆盖保留兼容。

CLI JSON loader 与 SDK 代码入口共用 serveAdapterHost 注册、stdio RPC、就绪和退出清理，实例仅存在于 Host 子进程。依赖声明随代码直接导入补齐，未裁剪宿主依赖或扩大自动安装范围。宿主负责依赖、包体和 Provider 安装；加载选择不承诺包体缩小。

同步 [接入文档](../../../INTEGRATION.md)、部署说明、开发指南以及 Work App 正式资源路径和既有验证脚本。接入示例分为独立 Host 与 SDK 生命周期两个文件，关键实现和示例均附中文注释；此要求写入架构规则和任务验收。

## 验证结果

- Runtime pnpm build、根 TypeScript 检查及 pnpm lint 通过；OctoSpec frontmatter、规则索引及文件链接检查通过。
- 新增 4 项回归通过：直接导入仅注册选中项并完成调用、未知类型失败、空集合与重复类型、SDK 停止再启动、Host SIGKILL 后恢复同一集合（部分断言合并在同一测试）。
- 全量回归第一次运行共 816 项：808 通过、7 跳过、1 失败。失败来自独立图标包目录缺失导致 adapter-icons.test.js 无法导入；新增第 4 项崩溃恢复测试随后单独运行通过。未为此恢复或伪造图标项目，不能将全量检查写成通过。
- CLI 发行包构建及临时前缀离线安装通过：CLI JSON 存在、根共享 JSON 不存在、SDK 无复制 JSON 仍能默认启动并列出 12 项；原 CLI 命令、daemon、插件合同及卸载保留 Home 检查通过。临时安装用于验证，未更新用户的全局安装。
- INTEGRATION.md 的两个完整 TS 示例通过 TypeScript 检查，使用真实字段及导出。
- scripts/verify-playboard-live.mjs 对 im-test 检查可达后，真实 Codex 与 OpenClaw 都返回预期标记及 run.completed。该结果证明本地 Provider 执行，不代表 Worker 注册或远程业务调度通过。
- Work App embedded-harness-service.test.ts 15 项通过；完整类型检查和构建因缺少同一图标包失败。CDP 验证时 9222 已不可连接，未声称更新后 renderer 验收完成。

## 未完成范围与保留项

第三方 extra_adapters.json 追加、公开 Adapter 开发入口、已有 daemon 选择冲突检测和运行中变更集合不属于本轮交付。现有进程仍需宿主按生命周期协调重启才能使用更新代码；本轮未删除或重置既有 Home、身份、profile、配置和 Provider 状态。Run=7、Context=v3 不变；没有协议变化，不要求 Worker 协议重建。

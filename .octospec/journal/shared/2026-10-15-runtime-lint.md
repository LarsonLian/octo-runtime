---
type: Journal
title: Runtime lint 清理验证
description: 记录未使用变量、类型引用和 JSON 边界类型检查的修复及验证范围。
tags: [typescript, testing]
timestamp: 2026-10-15T00:00:00Z
---

# Runtime lint 清理验证

清理 CLI 与 Host 的未使用代码；Socket JSON 先以 unknown 接收并校验对象和方法；渠道快照显式移除本地 signal；Bot 列表沿用逐项运行时校验；InvokeInput 使用 type-only 引用并显式丢弃协议版本与本地 signal。

当前工作区 `pnpm lint`、`pnpm lint:names`、`pnpm typecheck`（含 workspace 构建）通过。以下 9 个测试文件共 65 项通过：host、host-run-service、invoke-input、im-runtime、im-wecom、im-lifecycle-rpc、extras、channel-packages、cli-channel。

验证基于包含其他在途改动的工作区；本次提交仅包含 lint 修复。未改 Run / Context 协议或接入真实接口，未执行线上联调。

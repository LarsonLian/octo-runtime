---
type: Journal
title: Channel Gateway 默认目录验证
description: 省略 cwd 的配置、目录创建与 im-test 真实执行验证。
tags: [channel, workspace, testing]
timestamp: 2026-10-15T00:00:00Z
---

Octo Channel Gateway 省略 adapter.workdir 时，配置校验允许通过，执行入口提供 ~/octo-runtime/channels/{bot_id} 并创建目录。显式路径和 OpenClaw 的原生工作区行为保持原合同。通用 extraset 仍仅保存完整声明。

构建及 typecheck 通过；渠道、IM 与 Extra 相关回归共 52 项通过。后续新增 extraset 保存后加载用例，cli-channel 的 8 项测试全部通过。修改的 configuration.ts 和 dispatcher.ts 单独 ESLint 通过；全仓 lint 有其他文件的既存错误，未作为本次修复范围。

从受保护本机配置读取测试 Bot 凭据，对 https://im-test.deepminer.com.cn/api 校验真实身份，省略 workdir 构造本轮请求，借现有桌面 daemon 执行真实 Codex pwd。终态 run.completed，模型报告路径与默认渠道目录一致。本次未向 IM 会话发送消息，未重启现有 daemon；该证据验证新版渠道请求构造与真实 Provider cwd，不表示既有 daemon 已重新加载新版插件。

## 提交前检查

当前工作树另含 Bot 名称默认值、状态展示及插件未知字段保留。提交前重新运行 `pnpm typecheck`（包含全量构建），以及 channel-packages、cli-channel、extras、im-runtime、im-lifecycle-rpc、im-protocol、im-session-store 和 im-wecom 八份测试，共 54 项通过。没有重新执行线上模型调用。

`pnpm lint` 报告 25 项既有错误。涉及已修改文件的 CLI JSON 解析赋值及渠道运行类未用变量错误，已对 HEAD 原文通过 ESLint stdin 复核；其余报错文件没有本次代码变更。本次不扩大为全仓 lint 修复。

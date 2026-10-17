---
type: Journal
title: CLI Extra 启动诊断验证
description: 配置自动加载、启动日志、业务状态与 im-test 鉴权失败验证。
tags: [extra, testing, lifecycle]
timestamp: 2026-10-15T04:10:00Z
---

# 结论

CLI extraset 与 daemon run 均使用 Home 下 default/extra；本机 channel-gateway 配置已存在，但凭据仍为占位符。占位符会在插件内部被判为 IM_BOT_TOKEN_INVALID。未修改已有 Home、身份、profile、配置或既有进程。

前台启动新增扫描目录、声明数量和名称、逐插件加载结果。缺包返回 EXTRA_MODULE_NOT_FOUND，保留配置读取的受控错误码与 IM/WECOM 受控初始化错误码。新增 extra status channel-gateway，查询插件连接状态；loaded 不表示 Bot 在线。

# 自动验证

- pnpm build、pnpm lint、tsc -p tsconfig.json --noEmit 通过。
- Node 全量测试 739 项：732 通过、7 跳过、0 失败。首次运行有一处旧 stderr 单行断言失败，更新为验证新增发现日志及末尾错误后，全量重跑通过。
- CLI 完整进程覆盖 extraset、两次启动自动加载、缺包插件隔离、加载日志及日志不包含凭据。
- OKF lint 和 git diff --check 通过。全局 octo-runtime 链接实际指向当前 checkout 的 CLI dist。

# 线上测试环境

临时 Home 经 extraset 保存 channel-gateway，使用完整 CLI daemon run 启动；目标为 https://im-test.deepminer.com.cn/api。采用格式有效但无效的测试凭据，请求实际 verify-bot 接口得到 IM_AUTH_HTTP_401，状态 authentication_failed、connected=false；CLI 按名称查询能看到该状态，日志包含发现、loading、启动结果且不含测试凭据。

执行内核使用 fixture manifest，无真实模型调用或消息发送；只验证真实鉴权失败与诊断链路，未验证有效凭据下的 WS 在线和消息执行。临时 daemon 正常停止，临时 Home 已清理。

最初临时 Home 使用 macOS 的长系统临时目录，UDS 超长导致 listen EINVAL；改用短 /tmp 路径后完成上述验证。该失败与 Extra 加载无关。

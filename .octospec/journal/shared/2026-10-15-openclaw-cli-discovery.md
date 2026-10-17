---
type: Journal
title: OpenClaw CLI 发现与 SDK 连接分离验证
description: 每次 CLI daemon 启动刷新发现来源，执行层只读取连接快照。
tags: [openclaw, adapter, testing]
timestamp: 2026-10-15T00:00:00Z
---

# 实现

合同见 [OpenClaw 规则](../../rules/openclaw.md)，任务见 [简报](../../tasks/openclaw-cli-discovery/brief.md)。发现位于 `apps/daemon/src/openclaw.ts`，由独立 CLI daemon 入口、连接命令和 playboard 调用。SDK runner 不调用发现模块。

CLI 保存 Home 来源，每次 daemon 启动重新解析端口/token，保存公共连接快照并认证探测。支持默认 profile、已有 profile 配置和只有连接目录的 CLI profile。显式 URL/token 不回退 Home；Home 刷新失败时该次启动不把旧快照交给执行层。首次完全未配置时仍允许之后显式 connect。

共享 Adapter 的 configure 仅接受显式 URL/token，初始化稳定设备身份；probe/invoke 只读，不触发配置发现或设备身份修复。SDK 可显式保存 Runtime 连接，或直接传入连接和设备身份。Run/Context 协议未修改，不涉及 Worker 或桌面重建。

# 验证事实

- `pnpm typecheck` 通过，包含 workspace 构建；最后的 CLI daemon 入口更新另经包级构建通过。
- `pnpm lint` 通过。
- 首轮 `pnpm test`：739 项，732 通过、7 跳过、0 失败。随后加强 daemon 重启测试的就绪判断，修正 macOS 临时目录导致的 Unix socket 路径长度问题，并加入只有连接目录的命名 profile。
- 最终 OpenClaw 专项 5 项全部通过，覆盖 CLI 每次刷新、显式来源优先、SDK 无发现/无写入、真实 CLI daemon 子进程重启与两个 profile 的 WS/token 轮换、稳定设备身份及共享 Host 的 CLI/SDK probe/invoke。
- 最后一次全量复核期间，共享工作树的 Channel 源码与测试继续变化，出现 `IM_TYPE_INVALID`，涉及 Extra/IM 测试，部分失败用例未退出；已停止该轮测试进程。该轮不记作全量通过，也未回退或修改并行工作。
- 真实连接：读取本机现有 OpenClaw 配置，在临时 Runtime 中初始化连接；CLI 快照模式和 SDK 显式连接模式的认证 probe 均 `available: true`，地址为 `ws://127.0.0.1:18789/`。临时 Runtime 已清理，未修改 OpenClaw 原配置或真实 token。
- `https://im-test.deepminer.com.cn/` 返回 HTTP 200；这仅证明测试站点可达，不证明完整 IM 投递或模型执行。实际端口/token 轮换使用 fixture Gateway，未修改正在使用的 OpenClaw 服务。
- OKF lint 与 `git diff --check` 通过；记录中无凭据。

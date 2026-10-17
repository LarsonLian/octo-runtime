---
type: Journal
title: daemon start 自动安装服务验证
description: 服务缺失时自动安装，已有服务继续原启动逻辑。
tags: [runtime, lifecycle, testing]
timestamp: 2026-10-15T00:00:00Z
---

# 实现

对应 [任务简报](../../tasks/daemon-start-precheck/brief.md)。`start` 在 Home setup lock 内检查原生服务，仅缺失时复用 install 初始化、探测、安装和 enable；随后沿用后台启动与本地 IPC readiness 检查。已安装但 disabled、failed 或 unknown 不触发重装。安装失败直接上报。

# 验证结果

- `pnpm typecheck`：通过，包含完整 workspace build。
- `pnpm lint`：通过。
- `node --test test/cli-home.test.js test/cli.test.js test/cli-channel.test.js test/cross-service.test.js`：35/35 通过。
- 实机 macOS `launchd-user`：独立临时 Home 和独立服务 label，先 extraset，再首次 start 自动安装，最终 service running、IPC ready；第二次 start 保持同一 PID，没有 install/enable；配置、machine identity 和 Extra 文件原样保留。
- 实机测试结束 uninstall 本次临时服务并清理本次临时 Home；未改动已有服务或 Runtime Home。
- 线上测试环境 `https://im-test.deepminer.com.cn/`：实际请求 HTTP 200；本次验证本地服务生命周期，未执行渠道认证、消息收发或真实模型调用。

Linux/Windows 后端由现有自动化测试覆盖，本次没有对应平台实机验收。未修改 Run/Context 协议或桌面 UI。

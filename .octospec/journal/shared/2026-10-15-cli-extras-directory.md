---
type: Journal
title: CLI 设备级 extras 目录实现与验证
description: 记录唯一配置目录、profile 参数边界、自动回归及 im-test 实机执行范围。
tags: [extra, runtime, testing]
timestamp: 2026-10-15T00:00:00Z
---

# 决策与实现

按 [任务计划](../../tasks/device-extra-directory/brief.md)，CLI 的唯一配置位置为 `<home>/extras/<name>/config.json`。Extra 属于宿主 Home，profile 仅区分虚拟 Runtime。SDK 保持由宿主提供声明，不限制配置来源。目录使用复数 `extras`。

extraset、extraget、路径诊断和 daemon 扫描同步修改；Extra 命令拒绝 `--profile`。`extras` 为保留基础目录名，daemon 不将该目录发现为 profile。原子写入、0600 权限、JSON 校验和插件加载边界保留。

当前版本尚未发布，不加入旧目录探测、回退、合并、复制、迁移或提示。没有修改既有用户配置、身份或服务安装；测试使用临时 Home。

# 自动验证

- `pnpm typecheck`：通过，包含 workspace 构建及 TypeScript 检查。
- `pnpm lint`：通过。
- `node --test test/cli-extra-directory.test.js test/cli-status.test.js test/cli-home.test.js test/cli-channel.test.js test/cli.test.js test/playboard.test.js`：58 项通过，0 失败。
- `uv run --with pyyaml python .octospec/scripts/lint.py`：通过；系统 Python 缺少 PyYAML，使用临时 uv 环境执行。
- `git diff --check` 与暂存差异检查：通过。

回归覆盖配置完整往返及权限、默认 profile 变化、不同 Home 隔离、拒绝 Extra 的 profile 参数、基础目录名冲突、daemon 普通/quiet 启动、只加载设备级声明、临时执行不加载 Extra，以及现有服务/身份保护。额外目录内故意放置无效文件，验证其不影响加载且不触发探测或迁移提示。

# 实机验证及边界

`node scripts/verify-extra-sse-live.mjs` 通过。CDP 读取真实 Octo Work renderer，确认服务地址为 `https://im-test.deepminer.com.cn`、已登录且内置 Runtime running；真实 daemon PID 为 56892。

脚本在临时 Home 经 CLI 将 SSE Extra 保存到 `extras`，再由宿主读取声明，将执行端口接至真实桌面 daemon。真实 Codex 返回预期标记和 `run.completed`，Run ID 为 `c52b159f-dbf9-4d81-8873-6e1b14e08596`。Bearer 拒绝、卸载后端口关闭、共享 Host 仍 ready 的断言均通过。

此证据覆盖新目录配置与真实本地执行；桌面 `connectionsEnabled=false`，没有验证 ChannelGateway 的远端注册、IM 建联或消息收发。未改 Run/Context 协议、SDK 存储合同或桌面 UI，不升级协议版本，不重启既有桌面或重建用户 Home。

工作树已有其他开发内容；此次仅暂存本需求的路径、参数约束、回归和文档差异，其他修改保留。

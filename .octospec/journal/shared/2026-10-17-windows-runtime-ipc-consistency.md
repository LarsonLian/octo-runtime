---
type: Journal
title: Windows Runtime IPC 一致性实施记录
description: 记录正式 CLI/daemon Pipe 合同修复、分层自动化证据及待完成的 hosted Windows 验收。
tags: [runtime, ipc, windows, release, testing]
timestamp: 2026-10-17T20:39:11Z
---

# Windows Runtime IPC 一致性实施记录

## 根因

PR #19 的 Windows 发行验收在 adapter-host 身份查询修复后继续 readiness 超时。源码核对确认：
正式 CLI 使用 8 位 FNV 风格 hash，正式 daemon 使用 16 位 SHA-256。两端对同一 Home 生成不同
Windows Pipe。增加等待时间不能修复该确定性错配。

盘点同时确认 SDK embedded daemon 与 Playboard 临时 daemon 使用独立 prefix 和独立生命周期；
这些端点不是重复错误，不能与正式 Runtime 强制合并。

## 实施

- daemon package 新增正式 Runtime 控制端点纯函数，并通过独立 subpath 导出。
- CLI `runtimePaths` 与 daemon `resolveDaemonRuntimePaths` 调用同一个生产函数；Windows 统一采用
  16 位 SHA-256 格式，POSIX 路径不变。
- 两个实际消费者都支持仅供合同测试使用的显式 platform 参数，生产默认仍为
  `process.platform`。
- Windows verifier 使用 60 秒总 deadline；单次 status 查询不超过剩余时间与 5 秒中的较小值。
- verifier 保留最后一次 status 错误和有界 daemon stderr；daemon 提前退出时立即失败。

## 当前验证

- `pnpm build` 通过。
- 31 项定向测试通过，覆盖正式 Windows 同 Home 一致、大小写等价、POSIX 路径不变、embedded
  命名空间隔离、延迟就绪、超时诊断、提前退出和诊断长度。
- `pnpm format:check`、`pnpm lint:names`、`pnpm lint`、`pnpm typecheck` 通过。
- `pnpm test` 通过：Node 测试 1152 项中 1143 通过、9 项按既有条件跳过、0 失败；WebUI
  Vitest 35 项通过。
- Standards 与 Spec 双轴 code review 均通过；review 发现的启动错误、清理顺序和 status 子进程
  回收问题已修复并补充回归测试。
- Octospec lint 只报告仓库已有的 14 条跨兄弟 checkout 失效链接，本专项未新增 lint 问题。
- 当前开发环境没有 Windows。本地测试只证明确定性端点与控制流合同，不证明 `.cmd`、原生
  Windows Pipe、PowerShell 或 `taskkill`。

## 待完成

- 提交并推送后等待 GitHub hosted `windows-latest` 与 `CI Gate`。两项通过前，不得将本专项标为
  Windows 原生验收完成。

实施计划与 milestone 可执行性见
[Windows Runtime IPC 端点一致性](../../tasks/windows-runtime-ipc-consistency/brief.md)。

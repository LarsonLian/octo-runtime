---
type: TaskBrief
title: Windows Runtime IPC 端点一致性
description: 统一正式 Runtime CLI 与 daemon 的 Windows Pipe 派生合同，并建立无本地 Windows 机器时的分层验收。
tags: [runtime, ipc, windows, release, testing]
timestamp: 2026-10-17T20:39:11Z
status: active
---

# Windows Runtime IPC 端点一致性

## 背景与问题

PR #19 新增真实 Windows 全局安装验收后，`octo-runtime-daemon.cmd --home PATH` 能启动，但
`octo-runtime status --home PATH` 不能连接同一 daemon。正式 Runtime CLI 使用 8 位 FNV 风格
hash 生成 Windows Pipe，正式 daemon 使用 16 位 SHA-256 生成 Windows Pipe。两端对同一 Home
得到不同端点；延长 readiness 等待时间不能修复确定性的端点错配。

当前开发环境没有真实 Windows 机器。本任务必须把可在任意平台证明的合同一致性与只能在
Windows 验证的进程、`.cmd`、Pipe 和 `taskkill` 行为分开记录，不得把 macOS 上的模拟结果写成
Windows 原生通过。

## 目标

1. 正式 Runtime CLI 与正式 daemon 对同一个规范化 Home 必须生成同一个控制端点。
2. POSIX 继续使用 `<home>/sockets/octo-runtime-daemon.sock`；Windows 统一使用
   `\\.\pipe\octo-runtime-<16 位小写十六进制 SHA-256 前缀>`。
3. SDK embedded daemon 与 Playboard 临时 daemon 保持独立命名空间，不得因本次统一而改成正式
   Runtime Pipe。
4. Windows 发行验收必须在有界时间内等待 readiness，并在失败时输出最后一次 CLI status 错误
   和 daemon stderr，不能只报告 `actual: false`。
5. GitHub hosted `windows-latest` 必须完成全局安装、CLI 查询、daemon 启动、进程树回收、卸载和
   Home 保留验证，才能判定本任务完成。

## 非目标

- 不改变 IPC 请求或响应协议。
- 不改变显式 `--socket` 或 `OCTO_RUNTIME_SOCKET` 覆盖优先级。
- 不统一 embedded、Playboard 与正式 Runtime 的端点命名空间。
- 不创建或推送发行 tag，不执行 npm 或 GitHub Release 发布。
- 不用增加无限重试或放宽 CI Gate 掩盖 Windows 失败。

## 端点责任矩阵

| 场景               | 生产者               | 消费者                | 一致性要求                        |
| ------------------ | -------------------- | --------------------- | --------------------------------- |
| 正式 Runtime       | `apps/daemon`        | `apps/cli`            | 同一 Home 必须相同                |
| SDK embedded       | daemon SDK Home      | SDK runner/client     | 内部相同；必须与正式 Runtime 隔离 |
| Playboard 临时执行 | CLI temporary daemon | 同一次 Playboard 调用 | 内部相同；必须与正式 Runtime 隔离 |
| 显式 socket 覆盖   | 调用方               | daemon 与对应客户端   | 保留调用方值，不参与默认派生      |

## 已选方案

默认正式端点的所有权属于 daemon IPC 合同。实现新增一个 daemon package 子路径导出的纯函数，
输入为已经规范化的 Home 和显式 platform，输出正式 Runtime 控制端点。CLI `runtimePaths` 与
daemon `resolveDaemonRuntimePaths` 必须调用该函数，删除各自的默认 Pipe 算法。

选择现有 daemon 的 16 位 SHA-256 格式作为统一格式。原因如下：

- daemon 是端点监听方，当前真实监听地址已经使用该格式；
- SDK embedded 与 Playboard 的现有 Windows 端点也使用 SHA-256 前缀，但通过不同 prefix 隔离；
- 当前 8 位 CLI 地址不能连接 daemon，不存在需要保留的可工作 CLI/daemon 组合；
- 16 位输出比 8 位输出降低不同 Home 碰撞概率。

平台参数仅用于纯函数和合同测试。生产调用仍默认使用 `process.platform`，不得新增用户配置项。

## Milestone 与可执行性

### M0：端点盘点与失败证据

- 盘点正式 Runtime、SDK embedded、Playboard 和显式覆盖四类端点。
- 保存 PR #19 hosted Windows 失败事实：daemon 身份查询已通过，CLI readiness 仍失败。
- 可执行性：已能通过源码和 CI 日志完成，不需要 Windows 机器。

### M1：共享正式端点派生

- 在 daemon package 增加无副作用的正式端点派生函数及明确子路径 export。
- CLI 与 daemon app 删除重复算法并调用共享函数。
- 保留 `--socket`、`OCTO_RUNTIME_SOCKET`、embedded 与 Playboard 行为。
- 可执行性：TypeScript 构建和纯函数测试可在当前 macOS 完成。

### M2：合同与隔离回归

- 用显式 `platform="win32"` 调用 CLI 与 daemon 的实际路径解析入口，断言同一 Home 端点相同。
- 断言 Windows 大小写等价 Home 产生相同正式端点。
- 断言 POSIX socket 路径不变。
- 断言 embedded 端点与正式 Runtime 端点不同；Playboard 继续使用独立 prefix。
- 可执行性：这些测试只验证确定性字符串合同，可在当前 macOS 执行；它们不证明 Windows Pipe
  可创建或连接。

### M3：Windows 验收诊断

- verifier 使用总 deadline，而不是把尝试次数误写成总耗时保证。
- readiness 失败时报告最后一次 status 错误和有界 daemon stderr。
- daemon 提前退出时立即失败；已取得有效 PID 且进程仍存活的失败路径执行 `taskkill /T /F`，所有路径均清理临时目录。
- 可执行性：控制流和静态合同可在当前 macOS 测试；`.cmd`、PowerShell 和 `taskkill` 仍需 M4。

### M4：Hosted Windows 原生验收

- 推送分支后等待 GitHub Actions `Verify release package (windows-latest)`。
- 只有 Windows job 与 `CI Gate` 均为 success，才记录原生验收通过。
- 若失败，必须读取失败步骤日志并回到对应 milestone；不得用本地测试替代。
- 可执行性：仓库已有 GitHub hosted Windows runner，不依赖开发者持有 Windows 机器。

## 验收标准

1. CLI 与 daemon 的 Windows 同 Home 合同测试通过，并调用同一个生产派生函数。
2. POSIX、embedded、Playboard 和显式 socket 覆盖测试无回归。
3. readiness 失败测试能看到最后一次 status 错误；daemon 提前退出测试能看到 stderr。
4. `pnpm format:check`、`pnpm lint:names`、`pnpm lint`、`pnpm typecheck`、`pnpm test` 通过。
5. 双轴 code review 无阻塞问题。
6. PR #19 的 Windows 原生发行验收和 `CI Gate` 通过。

## 风险与回退

- 风险：Windows 用户若只运行旧 CLI 或旧 daemon，与新版本混用时仍可能端点不一致。本发行包
  同时交付 CLI 与 daemon，并要求升级后重启；本任务不承诺跨版本二进制混用。
- 风险：错误诊断可能包含本地 Home 路径。诊断不得包含凭据、环境变量值或文件内容，输出长度
  必须有界。
- 回退：在未发布 tag 前可回退本分支提交。不得通过删除 Windows required check 作为回退方案。

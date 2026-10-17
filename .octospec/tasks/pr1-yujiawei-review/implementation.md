---
type: Task
title: PR 1 逐项整改与提交记录
description: 按 reviewer 与问题编号分别提交，记录决策、实际验证和完成边界。
tags: [review, testing, lifecycle]
timestamp: 2026-10-17T00:00:00Z
---

# 实施记录

用户已授权按问题修复并单独 commit。此前 brief、assessment 和消费者审查是实施前评估；执行状态以本文件为准。不推送、不发送 GitHub 评审回复、不合并 PR。

每项提交正文说明 reviewer、编号、采用的决策、验证证据。R02a/R02b 由同一上传 API 删除解决，合为一个问题提交；S01–S05 标明来自 Jerry-Xin 生命周期意见的同类检查，不能冒称 reviewer 直接提出。R04 没有代码缺陷，记录 Node 24 检查证据，不制造无意义代码提交。

## 当前进度

- R01（yujiawei）：已删除 getGroupInfo 实现及星号导出对应入口；保留 getGroupMembers。包构建、9 项渠道/最终 @ 回归及构建后导出核对通过。
- R02a/R02b（yujiawei）：已删除两项上传 API；保留 files.ts 图片尺寸与类型辅助函数。包构建、6 项图片/IM 运行回归及导出核对通过。
- R03（yujiawei）：已同步架构、本地执行及两份 SDK 指南；同账号互信，不新增鉴权或错误卡片。OKF 与补丁格式检查通过。
- R04（yujiawei）：原提交 CI 已有证据；本轮 Node 24 构建、类型、Lint、命名、格式与完整测试通过，新提交远端 CI 待推送后运行。
- R05（Jerry-Xin）：已监听 child/stdin/stdout/stderr 错误并保存首次失败，拒绝 pending 与后续调用、关闭 reader、释放失败队列；修正同步写失败的定时器清理。6 项新增回归（含真实 Host RPC 中坏调用失败、兄弟及后续调用成功）和 8 项既有 ACP 回归通过。
- R06（Jerry-Xin）：ACP/NDJSON 已使用同一次可等待的受管组清理；父进程 exit 不取消 KILL 升级，NDJSON 自然 exit 也启动清理。7 项进程组/超时回归、6 项 ACP 故障回归及 47 项既有 ACP/Host/native 回归通过。
- S01–S05（同类审查）：已分别修复，具体实现与验证见下文；最终完整检查通过，见下文。

## 验证约束

自动化使用隔离的假 Provider 和真实 OS 管道，不调用真实模型；有真实 API 调试时只连 im-test。保留现有身份、Home、配置和正在运行的产品实例。每项使用聚焦回归，最终统一执行 lint、类型构建和完整测试。平台未实测的结果明确保留，不把本机证据冒充远端 CI 或 Windows 实测。

## S01：Codex 管道错误隔离

来自 Jerry-Xin R05 的同类检查，并非 reviewer 单独提出。已补 stdin/stdout/stderr 与 reader 的 error 监听，保存首次传输失败，拒绝后续写入。包构建与 29 项 Codex 回归通过，包含三个流的重复错误、单一失败终态及既有取消/交互测试。

## S05：Host 启动错误归属

来自 Jerry-Xin R05 同类审查。已在 readiness 前监听 ChildProcess error 并关闭该 RPC 客户端，避免共享调用方被未处理异常终止。隔离地替换测试进程 execPath 注入真实 ENOENT；readiness 立即失败，不等配置的 10 秒超时。Host 包构建及相关测试通过。

## R06：回收预算与平台范围

采用 adapter-sdk 独立 process-cleanup 子路径共享低层回收函数；ACP client 增加单向 SDK 依赖，无循环依赖。POSIX 仅对明确创建的独立组发信号，不扫描其他进程。TERM 400 ms、KILL 后确认 200 ms 共用起点；ACP 协议取消等待 250 ms 后进入此清理，默认总等待上限约 850 ms，位于 Host 默认 1000 ms 宽限内。更短的宿主宽限仍由现有 Host 返回真实 cleanup_timeout，不扩大用户预算；后台同次清理继续有界收敛。

重复 close 返回同一 Promise；EPERM 不计作不存在；实际发信号遇到 EPERM 时保存原因并继续有界确认，其他非 ESRCH 错误直接抛出；确认超时返回 PROCESS_CLEANUP_TIMEOUT。macOS 使用真实隔离父子进程验收，未调用模型或业务 API。Windows 继续只终止既有受管 child，不把 POSIX 组回收声称为 Windows 后代树保证；Linux/macOS 远端 CI 在后续推送后确认，本轮未执行 Windows 实机验收。

## S02：Host 所拥有的进程组回收

来自 Jerry-Xin R06 的同类检查。Host launcher 复用本次受管组回收函数，close 先关闭 RPC 再返回同一清理 Promise，readiness 失败也等待同一清理；删除按 leader exit 提前返回与遗留 exit/timer 竞速。真实 Host fixture 的后代忽略 TERM 仍被回收，相关组回收和 Host 共 30 项测试通过。

## S03：ZCode 进程组回收

来自 Jerry-Xin R06 的同类检查，现已通过真实 ZCode 协议 fixture 复现并验证：Provider 返回终态后先退出，其忽略 TERM 的后代仍须被回收。close 复用同一清理 Promise，关闭 reader，取消定时器在 finally 释放；协议停止宽限 250 ms 加受管回收 600 ms，不超过 Host 默认 1 秒预算。进程组与 ZCode 共 17 项测试通过。

## S04：ACP / ZCode 接收缓冲

来自 Jerry-Xin 生命周期意见的同类审查。两种传输复用已有 DriverQueue：单事件 256 KiB、单队列 4096 条、单队列序列化总量 4 MiB，任一超过即失败。ACP 按 session 的更新队列隔离；ZCode 按单次客户端事件队列隔离。数值是序列化字节预算，不是进程 RSS 上限。

普通协议行（包含尚未换行的数据）在 readline / JSON.parse 前限制为 256 KiB。ACP 当前 prompt 明确带原生图片时，原生行允许到既有 INVOKE_REQUEST_MAX_BYTES=32 MiB，容纳输入回显；结束后恢复普通行上限，事件队列始终使用 256 KiB / 4096 / 4 MiB。ZCode 当前不支持图片输入，始终使用普通行上限。不增加可配置参数或动态猜测消息类别。

超限返回 STREAM_EVENT_TOO_LARGE 或 STREAM_BUFFER_OVERFLOW，释放积压、拒绝新输入、关闭 reader 并启动受管组回收；仅当前调用失败，不静默丢事件后报告成功。稳定错误码随错误对象返回。共 7 项新增容量回归覆盖条数、字节、无换行、图片原生 RPC 回显，以及真实 ZCode Provider 管道在消费者停读时主动关闭。相关 ACP、ZCode 与回收共 34 项通过；后续稳定错误码/确定性时序检查另与 native 回归一起验证。

S04 补充：新增 ACP 与 ZCode 正常完成后消费者停读的时序回归，正常退出保留已接纳终态，超限才清空积压；ZCode 在 leader exit 启动清理、stdio close 后判断接收结束。9 项容量/终态专项与进程组回归通过。

R06/S02 完整回归补充：macOS 在进程退出窗口可能短暂拒绝组信号。记录 EPERM 后继续在原期限内确认消失，只有确认 ESRCH 才成功；持续拒绝保留为超时 cause。Host 启动错误与清理错误同时发生时使用 AggregateError 保留两者，避免丢失 ENOENT 等真实原因。增加短暂/持续 EPERM 故障注入，与受影响的 Host 装配、Antigravity、playboard 和进程组共 49 项通过。

## 最终验证与交付

- 环境：macOS、Node v24.19.0、pnpm 11.19.0。
- pnpm typecheck（含全部 workspace 构建）通过；后续回收竞态修正后重建受影响 SDK/Host 包并再次执行根 tsc --noEmit，通过。
- pnpm lint、pnpm lint:names、pnpm format:check 全部通过。
- 完整 pnpm test:suites：Node 1113 项，1104 通过、9 跳过、0 失败；现有 UI 35 项通过。最终错误 cause 元数据补充后，额外 Host 启动/装配回归通过。
- 三个删除 API 在源码及构建导出中均不存在，原生图片尺寸解析保留。
- OKF 与 git diff --check 通过，专属进程 fixture 已退出；没有操作真实模型或 im-test 业务 API，没有修改现有 Runtime 身份、Home、profile 或配置。
- 当前没有待用户决定的方案项。尚未运行的是新提交远端 CI 和 Windows 实机验收，不能冒充本地证据；Windows 不承诺 POSIX 后代组回收语义。
- 用户授权范围内已按问题本地提交，commit 正文注明 reviewer、问题编号、决策与验证。未推送、未发送评审回复、未合并 PR。

复现过程发现并修正了三项完整回归失败（macOS 退出窗口 EPERM 影响启动错误和正常完成），重新执行完整测试后全部通过。曾将类型构建和 ESLint 同时启动，clean-dist 导致类型文件暂时缺失；后续按构建完成后再运行类型化 Lint 的顺序检查通过，没有通过放宽规则绕过门禁。

## 本地提交索引

| 问题 / 来源 | 主要提交 | 决策 |
| --- | --- | --- |
| R01 / yujiawei | 0df78b4 | 删除无已知消费者的 getGroupInfo |
| R02a、R02b / yujiawei | 07ac14c | 删除上传 API，保留图片解析 |
| R03 / yujiawei | aefa0c2 | 明确同系统账号互信及 SDK 边界 |
| R05 / Jerry-Xin | 5a83853 | 隔离 ACP 传输失败 |
| S01 / R05 同类检查 | 69797be | 隔离 Codex 管道失败 |
| S05 / R05 同类检查 | 91a3847 | 收敛 Host 启动错误 |
| R06 / Jerry-Xin | 43059b8、6075f48、d687916 | 有界回收受管组，保留退出竞态及原始失败原因 |
| S02 / R06 同类检查 | df7eb23 | 回收 Host 后代 |
| S03 / R06 同类检查 | f24a4bf | 回收 ZCode 后代 |
| S04 / 生命周期同类检查 | cf6b35d、cc8fc9d | 限制接收积压，保留正常终态 |

R04 的 Node 24 证据随本次验收文档记录；不需要产品代码变更。3cdeea6 保存实施前决策基线。

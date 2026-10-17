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
- R04（yujiawei）：原提交 CI 已有证据，新修改按实际检查补充。
- R05（Jerry-Xin）：已监听 child/stdin/stdout/stderr 错误并保存首次失败，拒绝 pending 与后续调用、关闭 reader、释放失败队列；修正同步写失败的定时器清理。6 项新增回归（含真实 Host RPC 中坏调用失败、兄弟及后续调用成功）和 8 项既有 ACP 回归通过。
- R06（Jerry-Xin）：ACP/NDJSON 已使用同一次可等待的受管组清理；父进程 exit 不取消 KILL 升级，NDJSON 自然 exit 也启动清理。7 项进程组/超时回归、6 项 ACP 故障回归及 47 项既有 ACP/Host/native 回归通过。
- S01–S05（同类审查）：待逐项核实、修复和回归。

## 验证约束

自动化使用隔离的假 Provider 和真实 OS 管道，不调用真实模型；有真实 API 调试时只连 im-test。保留现有身份、Home、配置和正在运行的产品实例。每项使用聚焦回归，最终统一执行 lint、类型构建和完整测试。平台未实测的结果明确保留，不把本机证据冒充远端 CI 或 Windows 实测。

## S01：Codex 管道错误隔离

来自 Jerry-Xin R05 的同类检查，并非 reviewer 单独提出。已补 stdin/stdout/stderr 与 reader 的 error 监听，保存首次传输失败，拒绝后续写入。包构建与 29 项 Codex 回归通过，包含三个流的重复错误、单一失败终态及既有取消/交互测试。

## S05：Host 启动错误归属

来自 Jerry-Xin R05 同类审查。已在 readiness 前监听 ChildProcess error 并关闭该 RPC 客户端，避免共享调用方被未处理异常终止。隔离地替换测试进程 execPath 注入真实 ENOENT；readiness 立即失败，不等配置的 10 秒超时。Host 包构建及相关测试通过。

## R06：回收预算与平台范围

采用 adapter-sdk 独立 process-cleanup 子路径共享低层回收函数；ACP client 增加单向 SDK 依赖，无循环依赖。POSIX 仅对明确创建的独立组发信号，不扫描其他进程。TERM 400 ms、KILL 后确认 200 ms 共用起点；ACP 协议取消等待 250 ms 后进入此清理，默认总等待上限约 850 ms，位于 Host 默认 1000 ms 宽限内。更短的宿主宽限仍由现有 Host 返回真实 cleanup_timeout，不扩大用户预算；后台同次清理继续有界收敛。

重复 close 返回同一 Promise；EPERM 不计作不存在，实际发信号失败直接返回，确认超时返回 PROCESS_CLEANUP_TIMEOUT。macOS 使用真实隔离父子进程验收，未调用模型或业务 API。Windows 继续只终止既有受管 child，不把 POSIX 组回收声称为 Windows 后代树保证；Linux/macOS 远端 CI 在后续推送后确认，本轮未执行 Windows 实机验收。

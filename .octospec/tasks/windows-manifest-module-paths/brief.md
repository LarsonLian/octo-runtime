---
type: Task
title: "Task: Windows manifest 模块路径加载"
description: "修复 AdapterHost 将 Windows 绝对路径直接传入 ESM import 的错误。"
tags: [adapter, testing]
timestamp: 2026-10-19T12:00:00Z
slug: windows-manifest-module-paths
source: self
upstream: "https://github.com/Mininglamp-OSS/octo-runtime/issues/37"
---

# Task: Windows manifest 模块路径加载

## Goal

调用方继续通过既有 manifest.module 传入本机文件路径；Host 内部转换为合法 ESM specifier，能够就绪、执行假 Adapter 并有界关闭。

## Background

基线为 6fee2e1828587c26c97d185a60590d956ee10192。原 loader 仅识别点和斜杠前缀，Windows 盘符路径触发 ERR_UNSUPPORTED_ESM_URL_SCHEME。Issue 报告 12 项直接失败、3 项后续断言受阻，逐项复测而非推定恢复。

GitHub API 已核对远端 ab3ded527db4599f50bbab4c2045b4b025086f3d：新增 #35/#36 涉及发行流程，不修改 loader 或相关测试。PR 分支已更新到此 main，不覆盖主工作区及已有 Windows 验证记录；原复现证据仍归属上面的实现基线。

## 责任与产品意图检查

- 需求来自宿主按既有接口选择本地 Adapter；路径识别及 ESM 转换归 Runtime loader。
- 调用方显式输入 module/export/options，不补造 Adapter 选择、Provider 配置或业务意图。
- 最先违反合同的是 runner 的路径分类；只修复该内部边界。
- 不新增 SDK 方法、公开入口、平台选择、配置字段、错误协议或调用方清理责任。
- 相对路径继续基于 manifest；包 specifier 与 file URL 原样保留，其他产品默认行为不变。
- 不新增安装、重试、模块回退或业务策略。

## Load-bearing list

- adapter：只加载显式选中模块，保留工厂、类型与导出校验。
- invocation / ipc：沿用 spawnAdapterHost、invoke、close 及独立 Host。
- testing：测试 Home/temp 位于所有 checkout 外；使用假 Provider，不构建运行实例。

## Out of scope

- #38 日志、#39 WebUI 及其他 Windows 权限/生命周期问题。
- 新公开 SDK、追加清单机制、Bot/真实模型或 Windows 总验收 #14。

## Acceptance

- 修复前保留现有 focused test 的真实 Windows 导入失败。
- 回归覆盖绝对路径、空格、中文、URL 特殊字符、manifest-relative、file URL、包 specifier、缺失模块和无效导出。
- UNC 转换独立测试，不依赖网络共享。
- Host 真子进程完成 readiness → invocation → close，并确认进程退出。
- 重跑指定三个文件，记录 12 项直接失败和 3 项受阻断言的新结果及独立缺陷。
- 执行 format、lint、lint:names、typecheck、test:suites 和 Octospec 检查，明确剩余失败与平台缺口。
- 检查 exports/types/schema/signatures 无漂移，结果写入 journal。

## 本地验证结论

修复与专门回归完成。全仓仍有 53 个原有失败用例，其中部分从导入失败推进到独立关闭/IPC 问题。完整命令、逐项复测与跨平台缺口见[验证记录](../../journal/shared/2026-10-19-windows-manifest-module-paths.md)。

---
type: Task
title: Issue 57 实施计划
description: 宿主存储工厂的阶段与验证错误记录。
tags: [channel, session, extra]
timestamp: 2026-10-20T00:00:00Z
---

# Issue 57 实施计划

- complete: 核对规则、当前调用链与用户授权。
- complete: 工厂公开类型、逐 Bot 句柄和停止收尾。
- complete: Extra/SQLite/SDK 生命周期与公开类型测试。
- complete: SDK 接入文档、规则与 journal。
- complete: 构建、lint、类型、跨包测试、OKF 验证和 diff 自查。

## 限制和错误

- 不提交、不推送、不发布。
- 上轮测试因缺少依赖和 dist 未启动；本轮使用已安装 Node 24，正在 frozen-lockfile 安装。

## 验证中发现并处理

- 第一轮专项 27/29 通过：重复消息在同一实例被入站去重静默忽略，测试应跨 reload 验证持久 occurrence/reset；修正测试场景。
- TS6 命令行文件编译需 --ignoreConfig；公开类型测试补该参数。
- 全仓首轮 1336 项：1324 通过、10 跳过、2 失败。定位为替换 Bot 时 delete/set 改变 Map 顺序，造成既有状态索引合同回归；保留原 key 位置修正。
- OKF 初跑 Python 缺少 PyYAML，改用仓库推荐 uv run --with pyyaml；全仓现有 14 个跨仓链接缺失，新增文件未报告问题。

最终结果：1326 Node/35 UI 通过；10 条件跳过；包外入口和严格公开类型通过；OKF 14 个既有跨仓缺失链接。未提交/推送/发布，真实 IM/Provider 未验。

## 第二轮整体 review（用户追加）

- complete: Standards/Spec 双轴审查，复现并修复 SDK 断流、初始化撤权、draining 存储错误、presentation 收尾和无效异步工厂。
- complete: 新增异常回归、全仓检查、记录最终审查结果；不提交、不推送。
- 验证过程调整：全仓 pnpm test 的 prebuild 会清空 dist，不能与依赖声明产物的类型感知 lint 并发。并发 lint 出现大量类型不可解析错误，本轮改为构建/测试完成后顺序重跑，不按产品缺陷处理。

第二轮最终：1342 Node 通过、10 条件跳过、35 UI 通过；类型、lint、命名及包外验证通过；5 类已确认问题全部修复。

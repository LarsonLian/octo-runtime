---
type: Journal
title: Runtime 架构演进与已撤回的设计
description: 用 Git 解释当前边界的形成，只保留旧设计的问题和替代结论。
tags: [architecture, history]
timestamp: 2026-10-15T00:00:00Z
implementation_baseline: df63c8f
---

# 架构演进与已撤回的设计

本页依据本仓库 Git 历史与 `df63c8f` 工作树核对。当前行为以 [架构](../../rules/architecture.md) 和专项规则为准；本页不提供旧接口的操作教程。原文仍可用 `git show <commit>:<path>` 查看，无需把旧方案副本继续保存在当前目录。

## 形成当前实现的节点

| 日期 | 提交 | 变化及当前价值 |
| --- | --- | --- |
| 2026-08-29 / 08-30 | `cf9b3fa`、`94b2ed8` | 初始 monorepo，随后迁移 TypeScript；保留 workspace、Protocol 与 Provider Adapter 的组织基础 |
| 2026-08-30 | `57df51e` | JSON Schema 生成 wire 类型；至今保留 Schema 与运行时语义校验分工 |
| 2026-09-04 | `c2be6e1`、`6155dbf` | 旧业务引擎引入 SQLite 与 durable outbox / 双水位 ACK；这些机制服务于当时的业务执行平台，已不属于当前本地执行实体 |
| 2026-10-04 / 10-09 | `dc7d9cb`、`89445f8` | 演进 OpenClaw 外部 Agent 与来源声明；当前保留 preset/provisioned 和已有目标执行，撤回专用 runner 的复杂绑定前提 |
| 2026-10-08 / 10-09 | `5e99fc4`、`6359986` | 曾在执行层增加 Context Compiler/Pipeline、材料预取与摘要；后续明确违反本轮上下文由业务方决定的边界 |
| 2026-10-11 | `97692b0` | 固定四挡思考强度映射及未应用/降档提示，不以默认执行冒充参数已应用 |
| 2026-10-13 | `11e18b4`、`e9119ff` | 分离 Worker 与 IM 接入，完整本地事件交给消费应用；不让展示裁剪改变原始业务历史 |
| 2026-10-13 | `3a009cf`、`a6f8655` | native/canonical 双模式、原生 Driver 与独立 Host control；native 不由 canonical 反推 |
| 2026-10-13 | `2ef68f9`、`368d6f0`、`9a29c3c` | 固定渲染、取消会话级上下文去重、删除执行侧业务加工；相同项在不同 Event 显式提交时每轮传递 |
| 2026-10-14 | `39288a0`、`1da30e7`、`0aa5a09` | 本轮 MCP、独立可信控制指令及业务 reset；普通模型 Context 与控制通道继续分离 |
| 2026-10-14 | `53378dc` | 本地 SDK 合入 daemon，统一 OpenClaw profile 连接；不要求客户部署独立 embedded 包 |
| 2026-10-15 | `1cc5fab` | 统一 Runtime 名称并集中调整执行链路；当前 Core/daemon 不再维护业务 SQLite/store 或持久 outbox |
| 2026-10-15 | `80d70af` | 删除旧 Context Builder 和 Worker 接入，拆分 Octo/WeCom Extra，公共入口统一 InvokeInput |
| 2026-10-15 | `df63c8f` | 明确本地设备、共享 AdapterHost 和可选 Extra；本地存在不依赖线上登记 |

## 不再采用的设计及原因

| 旧思路 | 对当前项目的问题 | 当前替代 |
| --- | --- | --- |
| 注册云端后 Runtime 才算存在 | 混淆设备本体、本地就绪和远程可见性，外部故障影响本地使用 | Home/profile 保存本地身份，接入与共享独立 |
| Runtime 持有业务 Agent/Session/Run 与 SQLite 历史 | 执行内核承担业务权威与存储职责，增加重启恢复和重复副作用耦合 | 调用方保存历史和 binding，Host 只保留有界源窗口 |
| 逐事件持久 outbox、确认水位和 ACK DELETE | 把业务可靠投递耦合到本地执行传输 | 保留命令接纳回执和源游标，业务独立负责投递 |
| 按 session/hash 自动补齐、去重模型背景 | 执行层擅自改变本轮输入，reset 或 resume 失败时还可能伪造恢复 | 业务显式提交每轮快照，空输入和重复都有效 |
| 执行层读取引用、注册业务处理器、摘要与字段投影 | 取材授权与材料选择越过业务边界，输入难以复核 | Host 仅按白名单保序固定渲染 |
| Runtime 安装 Provider/插件或修复时自动下载 | 执行层替宿主决定版本与安装范围 | HostApp 决定方案，缺失返回明确状态 |
| OpenClaw 必须先 claim、绑定专用 runner 和改写工作区 | Provider 目标、连接和运行时身份相互绑死 | profile 管连接，本轮 Context 选目标，使用原生工作区 |
| 为各业务入口建立执行内核或强制经过 Extra | 复制执行合同，宿主内部调用也被业务插件约束 | 同一 AdapterHost，内部直接调用，外部按需 Extra |
| 把断流、命令 ACK 或原生 payload 的 completed 当成功 | 无法区分执行清理、历史保存与最终投递 | 独立 Host control 与真实终态，缺口如实失败 |

上述结论不要求迁移或兼容旧格式。旧测试通过和旧架构当时可运行，均不能证明其适合当前项目边界。

## 目标与实现仍有距离的事项

- 设备共享访问 Extra 的最终授权和远程控制合同仍待确定；当前没有 Worker 接入工厂。
- Extra 配置迁至 Home 根 `extras/`、统一 CLI 启动汇总属于未落地的旧提议，不是当前配置要求。
- 保留的对象式 module API 与函数式 Extra API 共存，不可仅因包名变化就宣称所有宿主已切换。
- 任一 Provider 的取消清理、原生审批或跨版本连接，仍需针对实际实现单独验收。

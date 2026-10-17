---
type: Review
title: 宿主 SDK 接入流程的现状与缺口
description: 按宿主操作区分已有能力、待接入口和待验路径，避免把内部检查和发行扩展当作接入工作量。
tags: [sdk, extra, assessment, lifecycle]
timestamp: 2026-10-17T00:00:00Z
---

# 宿主接入流程的现状与缺口

起始基线 f88b6b0，本地 SDK 已实施并通过自动化，证据见[交付记录](../../journal/shared/2026-10-17-sdk-host-extra-contexts.md)。目标是[宿主 H01–H06 完整流程](brief.md)，接入方新增的核心操作只是把 loadContexts 传给 runtime.loadExtra；第三方 App 和真实 IM 由用户明确留待后续。

## 评分口径修正

需求必要性 **100/100**，技术可执行性 **100/100**。主要依赖已有 loader、业务回调和执行传输，当前没有要求修改 Codex 或向宿主暴露内部逻辑的技术阻碍。

**撤回上版 40/100 作为宿主 SDK 完成度的表述。** 该数字按内部模块和额外分发项目分配权重，不能表示 demo 的接入工作量，也不能表示整个 Runtime 只完成 40%。本版按接口可用事实记录状态，不重新编造一个总百分比。

本轮限定的“本地 SDK 入口与 daemon 自动化”已完成。该入口已支持函数装配，不能再写 0/100 或尚不可调用；完整产品接入仍须后续宿主与 im-test 验证，不把仓内 fake Provider 测试换算成线上完成率。

## 宿主步骤与剩余工作

| 步骤 | 当前已有能力 | 尚缺什么 | 工作由谁完成 |
| --- | --- | --- | --- |
| H01 启动 | createDaemonRuntime、startAccount 和独立 AdapterHost；SDK 自动化已通过 | 后续第三方宿主回归 | 宿主提供原有配置，SDK 维持原生命周期 |
| H02 业务函数 | LoadContexts、同步/异步返回、每轮取值、覆盖和预算已实现；demo 已有 persona.loadContexts | 不需要接入方再写 Context 加载框架 | 宿主只实现自己的取值函数 |
| H03 注入函数 | 通用 SDK 重载与同进程装配已实施；JSON 快照与冻结函数依赖已验 | 后续真实 Gateway 经 SDK 加载验证 | Runtime SDK；宿主加载时多传函数 |
| H04 数据更新 | 仓内 SDK 两轮分别读到 A/B，独立 Host PID 不变，同步/异步均通过 | 第三方数据源与真实 IM 两轮验证 | 后续宿主/IM 验收；宿主照常保存业务数据 |
| H05 状态和重载 | 本地与 runner 同名互斥、状态合并、卸载重载、取消/交互映射均已验 | 第三方产品展示与真实用户交互 | SDK 内部完成；宿主调用方式不增加内部步骤 |
| H06 退出和切账号 | 本地初始化 abort、stop、切账号/租户、runner 退出清理和失败阻塞均已验 | 宿主实际退出与账号流程验证 | SDK；宿主通知并等待 stop |

本次已实现 **H03 入口及 H05/H06 的现有生命周期接线**，并通过 H04 仓内效果验收。不能因列出多个竞态场景就把它们变成多个宿主功能，也不能要求业务团队补 executionPort、身份映射或自行创建 loader。

## SDK 内部必须接好的地方

| 内部检查 | 当前依据与 gap | 宿主看到的结果 |
| --- | --- | --- |
| JSON 与函数分开 | [SDK 入口](../../../packages/octo-runtime-daemon/src/runtime/daemon-runtime.ts)快照 config、浅冻结 dependencies，复用[loader](../../../packages/octo-runtime-daemon/src/extras.ts)；函数不进入 runner session | 已通过同步/异步函数、配置快照及磁盘声明检查 |
| 共享执行端口 | [SDK 内部端口](../../../packages/octo-runtime-daemon/src/runtime/local-extras.ts)关联活动 invocation/run 并绑定所属 Extra；复用原源流 | 已通过 native 帧、canonical 回答、所属实例取消及可信执行环境透传 |
| 唯一实例与状态 | 装配位置共享命名与 64 声明容量；轮询合并本地状态 | 已通过两位置互斥、状态、容量和重启恢复检查 |
| 生命周期 | 立即 abort，沿 loader 清理；失败阻止新代次装配，仍继续停 runner | 已通过初始化失败、卸载/停止/账号切换/故障的自动化 |
| 日志与引用释放 | 本地装配注入原 RuntimeLogging，并在容器关闭时关闭 writer；实例清理释放活动映射 | 复用原白名单与日志合同；独立 SDK GC 压测和真实宿主长稳仍未新增验证 |

详细竞态、数据流和失败边界见[实现附录](flows.md)。这些属于一次 SDK 入口交付的内部完整性，不向宿主新增对应 API 或管理对象。

## 不纳入本次满分条件的扩展

不要求增加 `@mininglamp-oss/octo-runtime/sdk` 等 npm 导出，不要求另外发布 SDK 包。demo 当前按 submodule/workspace 引入 SDK 和模块，这是受支持的接入方式；沿该方式构建和启动通过即可。需要独立 npm 消费时另设分发任务，不能反过来阻塞本次函数注入。

此前 [loader / CLI 交付记录](../../journal/shared/2026-10-17-extra-initializer-delivery.md)证明已有基础，不代替这次公开 runtime SDK 接线的验证；也不要求重复实现已经完成的 Context 合并、额度或 Provider 逻辑。

---
type: Rule
title: 本地身份、生命周期与就绪事实
description: Home、账号与租户 profile 的身份隔离及本地 SDK 生命周期。
tags: ["runtime","identity","lifecycle"]
timestamp: 2026-10-15T00:00:00Z
implementation_baseline: df63c8f
id: runtime-lifecycle
tier: repo
priority: 90
load_bearing: true
inject_when:
  paths: ["packages/octo-runtime-daemon/**","apps/daemon/**","apps/cli/**","test/*runtime*","test/embedded-*"]
  touches: ["runtime","identity","lifecycle"]
source: self
supersedes: []
---

# Runtime 本地存在与接入边界

本文按当前源码说明本地身份、SDK 与状态。Run 固定为 7，Context 固定为 `octo.context-envelope/v3`，各协议版本独立。

## 本地存在

HostApp 安装并初始化 Runtime 后，本地执行对象及稳定身份即存在。SDK 在同一 app-owned Home、subject 和 tenant profile 中复用 Runtime ID；模块停用、外部断线和普通重启不删除该身份。显式销毁身份是另一个操作，不能作为连接故障的自动修复。

`machine_id` 是 Home 级安装分组标识，不是硬件指纹、认证凭据或跨产品全局设备身份。同一 Home 可以有多个账号／租户 Runtime；不同 app-owned Home 不自动合并。

| 事实 | 当前依据 |
| --- | --- |
| Runtime 已初始化 | profile 中保存合法本地 `runtime_id` |
| 本地就绪 | 有效 IPC 响应、`health.local.ready` 和 `adapterHostReady` |
| Provider 可用 | 实际 probe；不等于已认证或本次调用一定成功 |
| 扩展初始化完成 | 扩展生命周期状态；不等于其所有业务连接健康 |
| 执行完成 | 对应 Run 的真实终态；不等于业务保存或投递成功 |

## 安装与包

所有 Runtime 及依赖的安装方案由 HostApp 决定。SDK、Host 和 Adapter 只能执行明确方案；缺失或版本不符时返回状态，不在注册、探测或执行时自行下载。

本地 SDK 位于 `octo-runtime-daemon/src/runtime`；独立 embedded 包已删除。daemon 的生产依赖只包含本地执行及协议所需包，不依赖业务 Channel。Octo 与 WeCom 由各自 `extra-channel-*` 包提供，宿主按需携带和启用。

当前 `worker-access` 包已移除，不再提供 Worker 注册、WS、心跳或远程执行工厂。本地 SDK 不要求 Human Token、Worker URL 或 Runtime credential。其他产品的云端登记与设备在线能力必须使用其实际实现和回执，不能由本地 ready 推导。

## SDK 生命周期

1. HostApp 准备 Node、runner、manifest、Adapter Host 及 Provider。
2. `createDaemonRuntime({appId, home, ...})` 创建本地 SDK。
3. `startAccount({subject, tenants})` 初始化本地身份并启动 IPC／Host。
4. 宿主显式配置需要的模块或 extras，业务层提交已准备的本轮输入。
5. 宿主消费输出、保存完整历史、处理交互和取消；停止账号或应用时等待 `stop(reason)` 回收资源。

当前 SDK 使用 daemon server 承载本地控制子进程，同一账号多个 profile 共享 Host。不要把包解耦写成完全没有子进程，或把计划中的专用对外进程写成已完成。

## 上下文与恢复

每轮模型 Context 由业务方选择，允许空值、仅当轮项或显式重复。执行配置独立解析校验，不让业务背景变为必填。Host 不采集业务状态，不缓存、补齐、合并、去重或省略模型输入，见 [注入约束](context-input.md)。

Provider session 不保证恢复成功。业务方管理 binding 与 reset，并决定新会话要发送的背景。Host 源流有界，重启后不恢复旧执行，不自动重新 invoke。历史与可靠投递属于消费应用。

当前 API 以 [SDK 类型](../../packages/octo-runtime-daemon/src/runtime/types.ts)、[daemon 导出](../../packages/octo-runtime-daemon/src/index.ts)和[Extras 合同](extras.md)为准。真实测试记录按当时日期和范围解释，不代表后续改造已完成线上验收。

## 身份实现依据

[identity.ts](../../packages/octo-runtime-daemon/src/runtime/identity.ts) 校验保存的 schema、profile、租户与 Runtime ID 格式，不合法时明确失败；不会因外部断线自动换身份。身份文件仍有自己的 `schema_version: 1`，与 Run 7 和 Context v3 无关。

[home.ts](../../packages/octo-runtime-daemon/src/runtime/home.ts) 管理 app-owned Home 与账号路径。Home 级 machine 分组、profile Runtime ID、业务 Agent ID、业务 session ID 和 Provider session ID 不可互换。会话 reset 不删除 Runtime 身份。

CLI 不提供 `login` 命令及其旧更新入口。`daemon install` 与 `daemon run` 共用默认 Home 解析，首次使用时只创建缺失的本地配置及 machine identity，保留已有配置和身份。裸 `daemon` 只显示帮助；前台运行必须显式使用 `daemon run`。登录、登记和共享属于可选业务 Extra，不能作为本地安装和执行的条件。

`daemon start` 在 Home 安装锁内预检原生用户服务；仅 `not_installed` 时复用安装流程并启用自启，然后后台启动并等待本地 IPC 就绪。已安装服务不重装、不自动修复 drift、不改变禁用状态；手动 `install` 仍可用于修复定义。此流程不安装 Provider 或其他 Runtime 依赖。

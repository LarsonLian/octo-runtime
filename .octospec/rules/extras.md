---
type: Rule
title: Extra 加载与业务边界
description: 插件归属、执行端口、停止清理与显式装配。
tags: ["extra","lifecycle","installation"]
timestamp: 2026-10-15T00:00:00Z
implementation_baseline: df63c8f
id: runtime-extras
tier: repo
priority: 90
load_bearing: true
inject_when:
  paths: ["packages/octo-runtime-daemon/src/extra*","packages/octo-runtime-extra-*/**","apps/cli/src/extras.ts","apps/daemon/**","test/extras*"]
  touches: ["extra","lifecycle","installation"]
source: self
supersedes: []
---

# Extras 插件：背景、架构边界与技术方案

## 背景：为什么需要 extras

octo-runtime 为设备提供统一的本地执行能力。设备上的 AdapterHost 承载执行内核，各个业务入口通过同一个 `AdapterHost.invoke()` 提交执行请求。无论请求来自宿主应用、IM、飞书还是团队共享入口，业务入口使用的执行合同相同。

外部系统的接入方式属于具体业务实现。例如，打通 Octo IM 需要处理 Octo 的认证、消息与结果投递；打通飞书需要处理飞书的账号、事件与消息协议；把本机 Runtime 共享给团队使用，需要实现对应的授权、请求接收与结果回传。这些业务可以使用不同的连接方式和内部结构，但最终都调用统一的 `AdapterHost.invoke()`。框架无需理解这些外部系统，也不应为每种业务接入增加一套执行内核。

extras 机制让宿主按需装配这些业务能力，并统一管理插件的加载、卸载和资源清理。每个 extra 是可插拔的能力，负责自己的业务接入；框架只提供执行入口和生命周期合同。一个插件可以自行管理多个账号、几十条 WS、重连与路由，框架不规定这些连接的数量、组织方式或业务状态。

**没有任何 extra，不影响框架使用。** 宿主仍可直接调用 `AdapterHost.invoke()`，本地执行能力不依赖外部系统接入、插件加载或云端连接。extras 是可选的业务扩展，不是框架运行的前置条件。

## 设备、Runtime 与 extras 的归属

同一设备的一个 Runtime Home 由一个 daemon 同时承载多个 profile；每个 profile 对应一个独立 Runtime 身份。daemon 共享一个 AdapterHost 执行内核，AdapterHost 运行在独立子进程中。多个 profile 不要求各自启动 daemon。

个人使用与团队共享可以分别使用 `personal` 和 `team` profile。移除团队 Runtime/profile 的操作必须只处理该 Runtime 的注册、凭据、配置和运行资源，不影响个人 Runtime，也不卸载公共 daemon。移除单个 Runtime/profile 与卸载整个设备的公共运行服务是不同操作；这里规定操作边界，不表示单独移除功能已经完成。

extras 属于 Host，不挂靠 Runtime/profile，也不要求插件账号绑定 Runtime。宿主选择要加载的插件；插件自行决定怎样与外部系统交互，随后通过注入的 `AdapterHost.invoke()` 执行请求。Runtime 身份管理与插件业务接入分别遵循各自合同。

```text
Runtime Home / Host
  ├─ 一个 daemon
  │   ├─ Runtime：profile personal
  │   ├─ Runtime：profile team
  │   └─ extras：按宿主配置加载的业务插件
  └─ 共享 AdapterHost 执行内核（独立子进程）
       └─ AdapterHost.invoke()
```

## 当前实现

Extra 是 Host 上可装配的业务能力。Runtime、IPC Host 和 Provider Adapter 在本地独立存在；加载 Extra 不要求云端注册。Extra 通过宿主注入的执行能力提交请求，自己实现触发、连接、认证、业务状态和结果投递。

当前提供统一加载器、CLI JSON 配置入口和 `octo-runtime-extra-sse-demo` 示例。Octo 与 WeCom 的代码分别位于 `octo-runtime-extra-channel-gateway` 和 `octo-runtime-extra-channel-wecom`；两包均已提供默认函数式 Extra 导出，也保留对象式模块工厂；两者按不同合同加载，不能混用。旧 worker-access 已移除。

## 插件是什么

插件包导出一个稳定名称和一个默认 lambda：

```ts
import type { ExtraContext, JsonObject } from "@mininglamp-oss/octo-runtime-daemon";

export const name = "example";

export default async function load(ctx: ExtraContext, config: JsonObject): Promise<void> {
  const service = createBusinessService(config);
  ctx.onDispose(() => service.close());
  await service.start(ctx.signal);
}
```

`createBusinessService` 是业务代码示意。插件内部可以使用类、状态机、多条 WS 和重连管理器。公共层不规定内部实现，也不提供每个平台专属的加载方法。

一个 daemon 中，同名插件只加载一次。多个机器人、账号或 WS 属于插件内部配置和管理范围，不拆成多个框架实例。卸载后允许再次加载；重复加载尚未卸载的实例返回 `EXTRA_ALREADY_LOADED`。

`name` 只能使用小写字母开头、后续小写字母/数字/连字符，最长 64 字符。配置目录名称必须与模块导出的 `name` 相同；不匹配返回 `EXTRA_NAME_MISMATCH`。例如包名 `@mininglamp-oss/octo-runtime-extra-sse-demo` 声明名称 `sse-demo`。

## Context 与配置分别承担什么

```ts
type ExtraPlugin = (ctx: ExtraContext, config: JsonObject) => void | Promise<void>;

interface ExtraContext {
  adapterHost: Pick<HostRunService, "invoke" | "cancel" | "respondInteraction">;
  signal: AbortSignal;
  onDispose(dispose: () => void | Promise<void>): void;
  onConfigure(handler: (config: JsonObject) => void | Promise<void>): void;
  onRequest(handler: (method: string, params: JsonObject) => unknown | Promise<unknown>): void;
}
```

`ctx` 是插件运行环境，提供共享 Host 的 `invoke`、实例停止信号及清理登记。它不是发给模型的 Context v3，不能整体序列化为模型输入。

`config` 是宿主构造的插件专属 JSON 对象。框架没有通用业务 Config，也不要求插件导出 `validateConfig()`。每个插件在 lambda 内理解必要字段，配置不足时拒绝初始化。

CLI 默认从 JSON 文件读取；Desktop App 可以从 SQLite 或其他来源读取，再构造对象。插件无需知道配置来源。SDK 不扫描配置目录，宿主明确提供声明；CLI daemon 的启动装配明确选择目录读取适配器。

业务发起方决定每轮 `Actor + Trigger + Target + Input + Context`，处理业务 defaults/mandatory。Extra 若只是原始请求代理，则不追加或重建模型 Context。执行边界继续校验协议、身份、权限与必要执行配置；空模型 Context 与不同 Event 中显式重复的 item 都保持原语义。

## Load 与 dispose

```text
宿主选择插件与 JSON 对象
  -> loader 创建独立 context / signal / 清理列表
  -> import 已安装包
  -> 核对声明名称
  -> load(ctx, config)
  -> 初始化完成，状态 loaded

卸载 / daemon 退出 / 初始化失败
  -> 通知 signal.abort()
  -> 等待初始化退出
  -> 逆序执行登记的 disposer
  -> 等待异步清理完成
```

lambda 返回或 Promise 完成表示初始化完成，不表示插件卸载。长期连接、监听器与任务仍由插件持有。

每创建一个资源，应立即登记清理动作，再继续后续初始化。清理逆序执行，同一实例每个 disposer 只执行一次。单个 disposer 失败时仍继续其他清理，最终报告 `EXTRA_DISPOSE_FAILED`。初始化中途失败会回收已登记资源，其他插件和本地 Host 可以继续运行。

插件必须让初始化和内部任务响应停止信号，自己的 disposer 等待内部任务退出。加载器不强行终止同进程 JavaScript，也不是插件沙箱。业务重连和是否重试外部副作用由插件处理；loader 不在失败时自动重新 invoke 或自动重启插件。

公开状态只报告生命周期和脱敏错误码，不公开配置、Token 或第三方异常原文。`loaded` 不证明云端已登记或 WS 正常。插件可登记 `onRequest`，由 `requestExtra(name, method, params)` 转交业务查询；方法、返回数据和脱敏由插件定义，框架不定义 Bot 或通用在线状态。

## SDK 动态管理

`configureExtra(descriptor)` 校验并应用完整声明。相同 module 且插件登记 onConfigure 时，向该处理器提供完整 config；否则卸载并重载该插件。enabled=false 时卸载。操作不重启共享 Host，不安装或下载包。配置更新与业务请求按插件串行执行；卸载先通知停止，再等待在途处理与资源清理。处理器必须响应停止信号。

`loadExtra`、`unloadExtra` 和 `extraStatus` 对应已声明插件的生命周期操作；`requestExtra` 只向已加载且登记 onRequest 的插件转交请求。更新失败拒绝请求，不承诺业务副作用事务回滚；宿主应展示应用失败并允许重试。CLI extraset 仍只写盘，重启生效，不等同于 SDK 动态配置。

SDK 保留成功应用的最新声明供同账号重启恢复；load/unload 更新该实例内的启用状态。logout/account-switch 清除动态声明并恢复构造时的初始声明，宿主应在新账号登录后恢复自己的配置。宿主长期存储仍由宿主负责。

IM 插件的 onConfigure 按完整 bots 数组删除缺失项、更新变化项，未变化连接保留。可选 authorized_space_ids 属于插件业务配置，Octo 以认证得到的真实 Space 校验；空列表不授权任何 Space，省略时不增加宿主租户限制。授权范围变化重建连接。status 业务查询返回脱敏的逐 Bot 状态。Work App 使用此路径，按账号 SQLite 保存和恢复配置。

对象 modules 和函数式 extras 不能以同名同时装配，daemon 在取得进程资源前拒绝初始冲突，并拒绝动态配置时的冲突。

## 适用场景与边界

| 场景 | 插件内部负责 |
| --- | --- |
| Octo Channel | Octo 认证、多个 WS、消息转换、卡片与结果投递 |
| 飞书接入 | 飞书认证、事件接收、消息转换与结果投递 |
| WeCom Channel | 企微认证、连接与消息协议 |
| 团队共享入口 | 共享授权、请求接收、业务身份与结果回传 |
| CI / 自建系统 | 触发、可信业务身份、请求构造和回传 |
| 本地目录监听 / 定时任务 | 本地事件、调度与结果处理 |
| HTTP SSE 示例 | HTTP、Bearer、请求转交与流编码 |

Provider Adapter 是执行的被调用实现，不属于这些业务入口。宿主自身业务可以直接调用 `invoke()`，不必包装成 Extra。Extra 的价值是独立装配与生命周期，不是强制所有内部调用绕一层插件。

验证应分别覆盖配置保存、重启加载、鉴权、真实 Host 事件流、初始化失败回收和卸载端口释放。Run=7 与 Context=v3 本次没有变化；示例 HTTP 接口不替代其他 Run 身份、权限、租约合同。

历史自动测试和 im-test 真实桌面/Codex 范围见 [验证摘要](../journal/shared/provider-validation-history.md)。CLI 配置与 SDK 示例见 [配置指南](../guides/extra-configuration.md)。

## 源码依据

[加载与清理](../../packages/octo-runtime-daemon/src/extras.ts)、[声明校验](../../packages/octo-runtime-daemon/src/extra-config.ts)、[Octo 默认导出](../../packages/octo-runtime-extra-channel-gateway/src/extra.ts)、[WeCom 默认导出](../../packages/octo-runtime-extra-channel-wecom/src/extra.ts)、[生命周期测试](../../test/extras.test.js)。

CLI 唯一配置源为 `<home>/extras/<name>/config.json`，由同一 Home 的 Host 管理；profile 只区分虚拟 Runtime，不分区 Extra。SDK 由宿主显式提供声明，不强制采用 CLI 的文件布局。extraset/extraget 拒绝 `--profile`；不得按 profile 搜索、回退或合并同名声明，否则用户可能修改未生效的文件。当前版本尚未发布，不增加旧布局探测、兼容、迁移或提示逻辑。决策与实施范围见 [设备级目录任务](../tasks/device-extra-directory/brief.md)。

前台 `daemon run` 默认输出扫描目录、发现条目和逐插件加载结果；`--quiet` 关闭普通生命周期输出。插件生命周期与业务在线状态分别按真实证据报告。宿主自己的存储不受 CLI 文件位置约束。

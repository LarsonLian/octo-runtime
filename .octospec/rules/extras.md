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

## 最新决策与实现状态

2026-10-15 用户确认收敛责任边界：宿主 App / CLI 管理配置变更，按“卸载对应 Extra → 修改并保存完整配置 → 使用最新配置加载”编排；Extra 不承担通用原地配置更新合同。框架提供独立的加载、卸载和状态查询，保留现有 `signal` / `onDispose` 清理机制。每个实例必须具备状态能力，默认返回 `{}`，插件可登记同步 `onStatus(() => JsonObject)` 提供自定义快照。框架不解释状态业务字段，宿主按插件定制处理。

当前工作树已按此边界删除原地配置钩子与通用业务 RPC，提供同步状态回调、宿主显式卸载后加载完整新声明。旧接口不保留兼容入口。问题复盘、责任表、三个插件的源码依据及迁移验收见 [责任边界决策](../tasks/extra-responsibility-boundary/brief.md)，实际验证范围以其实施记录为准。

## 背景：为什么需要 extras

octo-runtime 为设备提供统一的本地执行能力。设备上的 AdapterHost 承载执行内核，各个业务入口通过同一个 `AdapterHost.invoke()` 提交执行请求。无论请求来自宿主应用、IM、飞书还是团队共享入口，业务入口使用的执行合同相同。

外部系统的接入方式属于具体业务实现。例如，打通 Octo IM 需要处理 Octo 的认证、消息与结果投递；打通飞书需要处理飞书的账号、事件与消息协议；把本机 Runtime 共享给团队使用，需要实现对应的授权、请求接收与结果回传。这些业务可以使用不同的连接方式和内部结构，但最终都调用统一的 `AdapterHost.invoke()`。框架无需理解这些外部系统，也不应为每种业务接入增加一套执行内核。

extras 机制让宿主按需装配这些业务能力，并统一管理插件的加载、卸载和资源清理。每个 extra 是可插拔的能力，负责自己的业务接入；框架只提供执行入口和生命周期合同。一个插件可以自行管理多个账号、几十条 WS、重连与路由，框架不规定这些连接的数量、组织方式或业务状态。

**没有任何 extra，不影响框架使用。** 宿主仍可直接调用 `AdapterHost.invoke()`，本地执行能力不依赖外部系统接入、插件加载或云端连接。extras 是可选的业务扩展，不是框架运行的前置条件。

## 设备、Runtime 与 extras 的归属

2026-10-15 最新澄清：设备承载多个虚拟 Runtime 标识，Extra 属于设备 Host，Channel 配置不要求 profile。下文 personal／team profile 仅解释既有实现，不能视为个人／组织共享必须采用的模型。共享插件可以管理一组虚拟身份并分别登记和授权；其具体实现仍待确定。`--profile` 在 Extra 命令中不承担配置分区，Provider 连接选择另行处理。完整结构与迁移要求见 [设备与虚拟 Runtime 决策](../tasks/device-virtual-runtime-boundary/brief.md)。

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

当前提供统一加载器、CLI JSON 配置入口和 `octo-runtime-webui-extra` 本地工作台。Octo 与 WeCom 的代码分别位于 `octo-runtime-extra-channel-gateway` 和 `octo-runtime-extra-channel-wecom`；两包均已提供默认函数式 Extra 导出，也保留对象式模块工厂；两者按不同合同加载，不能混用。旧 worker-access 已移除。

## 插件是什么

### 第三方 TypeScript 插件与发行包

第三方无需源码或私有包安装权限。单一 npm 发行包通过 `@mininglamp-oss/octo-runtime/extra` 导出完整 Extra 类型与协议类型，通过 `/protocol` 提供同一协议类型及常用校验、常量和事件工具。内部 packages 继续 private；不能要求客户 import 私有包名或内部路径。`.d.ts` 的传递依赖必须随发行物携带，并在仓库外以 `skipLibCheck=false` 验证。

`ExtraAdapterHost` 显式声明 invoke、cancel、respondInteraction，不通过内部 HostRunService 类间接暴露实现。实例由 `ctx.adapterHost` 注入，调用方只导入类型/工具，不创建第二个内核。invoke 保留 native/canonical 重载；事件流是异步迭代器，流内元素分别为 HostFrame 或 CanonicalEvent，事件类型保留判别联合。InvokeInput、Context、配置、会话、MCP、交互、错误等依赖类型必须可从公开入口取得。

独立工程的安装、编译、加载及 Agent Run 验收见 [第三方插件合同](../tasks/public-plugin-contracts/brief.md)与[开发指南](../guides/extra-configuration.md)。框架类型不替代插件业务 JSON 的运行时校验；发行包不自动下载插件。下文私有包 import 仅供仓库内部开发，第三方使用公开入口。

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

`name` 只能使用小写字母开头、后续小写字母/数字/连字符，最长 64 字符。配置目录名称必须与模块导出的 `name` 相同；不匹配返回 `EXTRA_NAME_MISMATCH`。例如包名 `@mininglamp-oss/octo-runtime-webui-extra` 声明名称 `webui`。Extra 的只读 `adapterHost.list` 可选端口返回共享 Host 已加载 Adapter 的实际探测结果；旧宿主未提供此端口时 WebUI 明确返回不可用，不猜测引擎状态。

## Context 与配置分别承担什么

保留函数式加载入口和既有清理注册，仅增加同步状态回调，不另建 Extra 对象或 dispose 接口。

```ts
type ExtraPlugin = (ctx: ExtraContext, config: JsonObject) => void | Promise<void>;

interface ExtraContext {
  adapterHost: Pick<HostRunService, "invoke" | "cancel" | "respondInteraction">;
  signal: AbortSignal;
  onDispose(dispose: () => void | Promise<void>): void;
  onStatus(handler: () => JsonObject): void;
}
```

`ctx` 是插件运行环境，提供共享 Host 的 `invoke`、实例停止信号及清理登记。它不是发给模型的 Context v3，不能整体序列化为模型输入。

`config` 是宿主构造的插件专属 JSON 对象。框架没有通用业务 Config，也不要求插件导出 `validateConfig()`。插件自行检查业务配置；内部配置有误时跳过受影响项，通过自定义状态返回脱敏错误，有效项继续初始化。授权配置无效时不得建立未授权连接。此类内部错误不等于 Extra 加载失败；入口、声明或清理等框架错误仍按生命周期报告。

2026-10-16 配置合同：三个内置 Extra 提供原始 `config-schema.json`，描述完整 `{ module, enabled?, config }` 声明。`module` 以对应包名 `const` 表达；字段 description 必须说明业务用途、必填条件、何时设置及省略行为，不能仅复述字段名。特别区分 OpenClaw 已有 Provider Agent ID、平台 Bot ID 与 Runtime ID。可选 `context` 只描述固定 v3 标识及开放的 items 对象数组，并说明 IM Channel 执行 AgentRun 时固定附带；不内嵌或引用完整协议定义，item 内部合同仍归 octo-runtime Context v3。业务方自行参考 schema、选择校验器或生成类型；框架不强制 Zod、不增加配置编译器，不从 schema 自动填值或改变 JsonObject 加载合同。非 JSON Schema 可表达的真实权限、资源可用性及协议语义约束继续在现有边界校验。公开入口和打包要求见[配置指南](../guides/extra-configuration.md#原始-json-schema-配置合同)。

CLI 默认从 JSON 文件读取；Desktop App 可以从 SQLite 或其他来源读取，再构造对象。插件无需知道配置来源。SDK 不扫描配置目录，宿主明确提供声明；CLI daemon 的启动装配明确选择目录读取适配器。

配置值与其来源必须分开：Channel 仅接收宿主已解析的 `bf_token` / `app_secret`，不提供 `bf_token_file` / `app_secret_file` 或其他文件、环境变量、配置中心的取值字段。来源读取、解密、组合、持久化及刷新由宿主负责；SDK/Extra 校验并消费值。新增配置须遵循[架构责任边界](architecture.md#配置来源归宿主sdk-消费配置值)，schema 不为不同存储来源增加业务字段。真正的工作目录、资源与内部状态路径按各自业务合同保留。

本次删除不考虑旧凭据文件配置兼容：读取解析、文件权限错误分支及旧 file-config 模块一并移除，不保留旧路径转发、迁移或回退。未知可选扩展仍按各插件原有合同处理，不代表支持旧取值机制。

配置 schema 以直接阅读为目标：Bot、Adapter、重试等业务字段按实际 JSON 层级直接内联，不使用 `$ref`、`definitions` 拆分。字段说明和原有条件约束保留，不能以减少引用为由省略必填关系或扩大运行时接受范围。

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

停止信号必须传到插件内部正在建联、握手、执行和投递的任务，不能先等待初始化完成再取消。内部 manager 先禁止新操作并取消初始化，再等待队列；重复 close 等待同一次清理。一个资源关闭失败仍须尝试其他资源，最后汇总错误；不能只调用 Promise.allSettled 而丢弃失败结果。正常的任务取消不作为资源清理失败。

Octo 与 WeCom 已接入 Extra signal；WebSocket close 等待实际关闭，Octo 等待卡片轮询和 typing 发送退出，WeCom 等待回复队列退出。内部关闭失败向上形成 EXTRA_DISPOSE_FAILED；业务配置错误仍按状态报告，两类错误不得混淆。

插件必须让初始化和内部任务响应停止信号，自己的 disposer 等待内部任务退出。加载器不强行终止同进程 JavaScript，也不是插件沙箱。业务重连和是否重试外部副作用由插件处理；loader 不在失败时自动重新 invoke 或自动重启插件。

加载器生命周期状态只报告生命周期和脱敏错误码，不公开配置、Token 或第三方异常原文。`loaded` 不证明云端已登记或 WS 正常。内部状态通过专用状态查询转发，框架不定义 Bot 或通用在线状态。

## 状态接口与宿主编排要求

- 每个 Extra 实例必须具备状态查询，默认回调返回 `{}`；插件通过 `onStatus(handler)` 登记自身实现。未自定义状态不等于不支持查询，空对象也不证明健康。
- 回调同步返回 JSON 对象，仅读取内部状态快照。当前 Octo、WeCom 均从内存读取状态；SSE 可读取 HTTP server 和活动请求集合。没有将插件回调统一异步的现有依据；SDK 跨进程查询可以是异步调用。
- 各 Extra 独立定义返回 JSON 和脱敏规则，宿主负责解释及展示。框架不投影业务字段、不根据状态自动控制连接，不把此接口扩大成任意业务 RPC。状态查询不得触发联网探测、配置修改或修复。
- 生命周期与内部状态分开；未加载、加载失败、查询失败和已加载返回 `{}` 不得混淆。卸载后不调用旧实例状态，自定义回调失败不伪装为默认 `{}`。
- Bot 的 `enabled` 是 IM 插件业务配置，缺省 true、false 不连接；状态必须保留停用 Bot。当前两包以 `stopped` 表达停用后的连接状态，不为统一框架发明业务状态码。
- 配置修改由宿主明确卸载、保存并重新加载目标 Extra；同一插件内其他连接可以一起重建，不要求保留未变化 Bot 的连接。加载必须取得新配置，不能重新应用旧启动快照。
- 每个 Extra 的正常加载、卸载、失败回收独立，不连带卸载其他 Extra 或重启共享 AdapterHost。同名操作有序；卸载返回前必须等待清理，清理失败如实报告。这不是进程沙箱保证。
- 宿主拥有持久配置和最新声明，SDK 不扫描宿主存储、不隐式安装、不计算业务配置差异。runner 恢复与账号隔离须使用宿主最新有效声明；保存、加载、外部连接成功分别报告。

## SDK 与宿主生命周期

`loadExtra(descriptor)` 接收完整声明，显式加载会将该 SDK 实例内的声明标记为启用；相同名称尚未卸载时拒绝，不自动更新或重载。`unloadExtra(name)` 先通知停止并等待资源清理。加载器保留清理失败的实例以阻止重复加载，不把失败伪装成资源已释放。

`extraStatus()` 查询生命周期；`extraStatus(name)` 查询该实例的同步状态回调，经 IPC 返回 JSON 对象。加载器的 `inspect(name)` 在对应实例生命周期队列中读取快照，校验 JSON 并复制；回调异常或无效 JSON 返回受控 `EXTRA_STATUS_FAILED`，不泄漏异常原文。

CLI `extraset` 只保存并返回 `reload_required`，执行 `daemon restart` 后读取最新配置。持久停用通过 `extraset` 保存 `enabled: false` 后重启。CLI 不提供 extra status/load/unload；SDK 与内部 IPC 保留显式生命周期管理。框架不会因状态变化自行重载。

SDK 在显式加载尚未完成时，卸载、退出和切换账号／租户可先发出停止请求，不排在该加载完成之后才通知停止。停止请求绑定原账号的进程；已排队的旧账号卸载不能作用于新账号。被取消的加载返回 EXTRA_LOAD_CANCELLED，不记为最新启用声明。最终配置与账号状态仍通过生命周期队列更新。SDK 退出时即使收到 EXTRA_DISPOSE_FAILED 也继续回收进程，进程退出后向宿主报告该失败；进程已停止不等于插件清理正常完成。

SDK 保留成功应用的最新声明供同账号重启恢复；load/unload 更新该实例内的启用状态。logout/account-switch 清除动态声明并恢复构造时的初始声明，宿主应在新账号登录后恢复自己的配置。宿主长期存储仍由宿主负责。

IM 插件仅在加载时处理完整 bots 数组；状态由各插件返回 `{ bots: [...] }`，SSE 返回监听与活动请求信息，各包 README 维护字段含义。可选 authorized_space_ids 属于插件业务配置，Octo 以认证得到的真实 Space 校验；空列表不授权任何 Space，省略时不增加宿主租户限制。Work App 保留账号 SQLite，由宿主按平台卸载、保存并加载完整配置，不要求 SDK 提供逐 Bot 命令。

对象 modules 和函数式 extras 不能以同名同时装配，daemon 在取得进程资源前拒绝初始冲突，并拒绝动态加载时的冲突。

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

前台 `daemon run` 默认输出扫描目录、发现条目、逐插件加载结果和内部状态；`--quiet` 关闭普通生命周期输出。SDK 的 `extraStatus()` 查询生命周期，`extraStatus(name)` 转交插件业务状态，不把 loaded 推导成连接在线。宿主自己的存储不受 CLI 文件位置约束。

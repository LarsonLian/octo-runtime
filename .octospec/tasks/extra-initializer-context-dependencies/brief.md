---
type: Task
title: Extra 两阶段函数入口与动态 Context 依赖注入
description: 保持 config 为纯 JSON，以独立函数参数注入业务能力，定义同步异步回调、整体生命周期和有界资源合同。
tags: [extra, channel, context, lifecycle, typescript, testing]
timestamp: 2026-10-16T00:00:00Z
---

# Extra 两阶段函数入口与动态 Context 依赖注入

状态：2026-10-17 已实施共享 loader、三个 CLI Extra、两个 Channel 动态 Context、text-only 指令及配置示例。实施基线 `aad4086`。用户最新要求“SDK 接入的先不用改”，因此 SDK HostApp 同进程装配迁移明确延期；下文保留该部分目标设计。实际证据与未验项见[交付记录](../../journal/shared/2026-10-17-extra-initializer-delivery.md)。本次不兼容旧 Extra ABI 和 instructions.source，不删除或重新初始化用户身份、Home 或配置。

## 本轮实施范围

共享 `ExtraPlugins.load(module, config, dependencies)` 可在同一 Node 进程装配类型明确的业务函数；CLI 的 JSON 声明继续通过 `load(name, registration)` 加载并传空依赖。Gateway、WeCom 和 WebUI 全部迁移；WebUI 增加显式 `config.context`，本轮输入同 key 整项覆盖静态配置。现有 `createDaemonRuntime.loadExtra(descriptor)` 继续传 JSON，未增加函数跨进程入口。两个 Channel 的回调加载结果通过 buildContext 参数进入本轮快照，内部 manager 未向宿主暴露。

配套阅读：[接口与装配设计](design.md)、[内存与异步资源合同](memory.md)、[逐模块评估与实施顺序](assessment.md)。

## 2026-10-17 评审确认

用户同意 SDK 在 HostApp Node 组合层装配 Extra，以及 loader 调用并等待第二阶段初始化。关于宿主通知单个 Extra load/unload 和整体停止，用户说明这是初步想法，要求进行工程评估，不作为已确认的全部实现细节。评估建议采用：宿主决定并通知，SDK 有界协调，Extra 自己清理内部资源；具体停止、取消和失败行为见[生命周期评估](design.md#生命周期分工的工程评估)。

“业务能力注入”专指本次新增的 loadContexts 等业务函数。“模型执行端口”专指 ExtraContext 已有的 adapterHost.invoke/cancel/respondInteraction。后者是调整装配位置时需要接通的既有基础设施，不要求业务方再提供模型执行实现，也不是本次新增的业务依赖字段。用户已确认这一区分。

用户同意动态结果不保存为历史、限制在途调用并在结束或卸载时释放。验收目标是框架新增内存不随累计消息或重载次数无界增长；需以受控测试证明，尚未声称已验证。此确认不表示任意外部 IO、业务缓存或同步代码均可获得绝对内存上限。

## 1. 业务目标和决定权

宿主业务既需要固定 Bot Context，也需要在消息执行前从内存、数据库或业务 API 取得当轮 Context。宿主提供函数，Channel 在自己的业务流程中调用，生成并提交本轮完整快照。宿主不取得 Channel 的 manager、Bot、连接、队列或 session 对象。

用户确定的要求：

- config 始终是普通 `JsonObject`；配置文件、声明和运行快照中没有函数、表达式、函数 ID 或可执行字符串。
- Extra 采用函数组合；第一阶段返回函数，第二阶段接收明确的函数依赖，不返回插件管理对象。
- 动态加载支持同步返回及 Promise 返回，不能假定外部一定有 IO，也不能假定一定没有 IO。
- 合并时动态 Context 优先；同 namespace/name 整项替换静态配置项。
- 保持插件封装和整体加载、卸载、状态边界，不增加内部对象控制接口。
- 本次不保留旧入口重载、兼容包装、自动迁移或旧协议回退；破坏性授权只覆盖本任务接口和消费者更新。
- 默认 IM 人设正文改为 `我是明略科技的Octo助理`；仍用 instructions 文本列表，不新增 persona 协议。

业务方决定提示词和加载时机；Extra 决定自身内部调用位置、排队和资源清理；通用 loader 管整体生命周期；Host/Adapter 只按执行合同校验、传递和适配。空动态列表合法。通用执行层不补齐业务 Context，不按 session 缓存或省略它。

本设计不修改 Run=7、Context=`octo.context-envelope/v3`，不改变安装决定权、Runtime 身份、Home、profile、Provider 原生状态或业务权限。不授权删除、重建或重置上述数据。

## 2. 接口选型

推荐以下两阶段入口。这里的函数式指显式输入和函数组合，不声称网络插件是没有副作用的纯函数。

```ts
type ExtraInitializer<D extends object> = (
  dependencies: Readonly<D>
) => void | Promise<void>;

type ExtraPlugin<D extends object = Record<string, never>> = (
  context: ExtraContext,
  config: JsonObject
) => ExtraInitializer<D>;

type LoadContexts = (
  config: JsonObject,
  options: { readonly signal: AbortSignal }
) => readonly ContextItem[] | Promise<readonly ContextItem[]>;

interface ChannelDependencies {
  readonly loadContexts?: LoadContexts;
}
```

调用含义：

```ts
const initialize = channelExtra(context, jsonConfig);
await initialize({ loadContexts });
```

外层是同步普通函数，检查配置并返回初始化函数；内层可以异步，完成插件启动。`loadContexts` 不在初始化时预取业务材料，而是在每个已接纳的逻辑轮次准备时调用。普通单参数业务函数可忽略第二参数；有 IO 的实现必须传递 signal 并遵守取消合同。

没有业务回调时传 `{}`，插件使用静态 Context。框架不为所有 Extra 定义统一依赖字段；`ChannelDependencies` 属于两个 Channel 的公开合同。后续只增加有具体业务需求的具名函数，不预建任意服务容器。

## 3. 选型比较

| 方案 | JSON 与封装 | 类型和生命周期 | 结论 |
| --- | --- | --- | --- |
| `extra(context, config)(dependencies)` | 数据与函数分开，内部资源不外泄 | 两阶段明确，loader 必须等待初始化函数 | 推荐；符合用户要求 |
| `extra(context, config, dependencies)` | 同样能保持边界 | 一个阶段较少一次函数创建 | 可行，但不采用；本次选两阶段组合 |
| 函数塞进 config 或保存源码 | 破坏纯 JSON 合同 | 无法正常 clone、持久化及校验 | 排除 |
| 返回插件对象、factory 加内部控制方法 | 容易扩大宿主控制范围 | 增加第二套管理接口 | 排除 |
| 每轮查全局注册表、通用 service locator | 依赖隐藏、所有权不清 | 容易产生长驻引用和生命周期分叉 | 排除 |
| 跨进程函数代理或函数序列化 | 超出直接 TS 函数调用目标 | 新增寻址、回调协议和故障模式 | 排除 |

两阶段本身不会天然更省内存，也不需要引入函数式框架、Monad、响应式流或通用依赖注入库。

## 4. 关键行为

| 情况 | 目标行为 |
| --- | --- |
| 同步返回数组 | await 后直接使用；不会因此创建工作线程 |
| 返回 Promise | 等待当前轮结果，完成前不 invoke Provider |
| 未提供 loadContexts | 使用配置内静态项，保持现有 Channel 材料采集 |
| 返回空数组 | 不覆盖或删除静态项；不解释为清空 Context |
| 相同 namespace/name | 动态整项替换，保留被替换项的位置 |
| 动态新增项 | 按回调返回顺序追加到静态项之后 |
| 同一来源内部重复 key | 明确拒绝，不用最后一项掩盖错误 |
| 抛错、拒绝、非法返回、超时 | 本轮准备失败，展示稳定错误；不调用模型、不使用旧结果兜底 |
| Provider 暂态重试 | 复用本逻辑轮已冻结的 Context，不再次调用回调 |
| 新消息 / 新逻辑轮 | 再次调用；不同 Event 的相同项不去重 |
| /reset、/session 等控制操作或未接纳消息 | 不调用动态加载函数 |
| Extra 卸载 | abort，等待受管操作退出并释放引用；不关闭共享 AdapterHost |

合并例子：`[A, B] + [B2, C] -> [A, B2, C]`。不做 payload 深合并、不拼接 instructions.entries、不按 hash 排序。Channel 生成的身份、消息来源等保留项不允许由回调伪造。最终权限、mandatory、固定 workdir 和协议预算继续校验。

“固定人设”在当前计划中指默认正文固定。动态 instructions 整项替换仍遵循用户要求；回调覆盖 instructions 时须自行带上这段人设。若产品要使该身份不可覆盖，则须另行改变该项的覆盖合同，不能在底层暗中补回。普通每轮业务提示建议放在业务 extra 项，避免无意替换整份系统指令。

## 5. 内存设计原则

合并是无状态纯计算。动态结果只属于当前任务及其既有重试快照，不保存为插件历史、session 默认值、lastContexts 或永久缓存。初始化函数通常每个实例只创建一次，不按消息重新创建整个插件。

临时分配不等于泄漏。风险是对象仍被闭包、未完成 Promise、队列、监听器或定时器引用；具体上限和卸载要求见[内存合同](memory.md)。对外部 JS 函数，插件能限制调用数并取消合作式 IO，不能强制终止同步死循环或撤销外部自行持有的内存，不作“任意 lambda 都绝不 OOM”的承诺。

## 6. 破坏性更新范围

一次性更新 Extra 类型、loader、三个内置 Extra、JS fixtures、SDK/CLI 装配、公开导出、打包脚本和全部当前消费者。旧 `(context, config) => void` 不适配；loader 遇到没有返回初始化函数时明确失败，不标记 loaded。

SDK 当前只把 JSON descriptor 发到 daemon。直接闭包不能沿这条路径传递。用户已确认 SDK 将 Extra 执行放在宿主的 Node 组合层，与业务函数同进程；AdapterHost 继续沿原执行链工作。该选择有真实装配成本，须先完成 design.md 的 SDK 验证，不能只改签名后声称完整能力已具备。CLI 仍在自己的 daemon 组合层调用同一 loader，默认传空函数依赖。

删除兼容层不等于删除用户数据。不扫描和改写用户 Home；旧配置结构需要更新时，由其宿主按当前合同重新提供值。不可变历史快照不改写。

## 7. 实施与依赖

- [ ] M0：SDK 同进程装配按用户最新要求延期，不增加函数 RPC。
- [x] M1：新两阶段类型、generic load、三个内置入口及失败清理。
- [x] M2：纯合并、同步/异步加载、取消、容量和两渠道准备链。
- [x] M3 核心前置：双渠道直接提交 InvokeInput、text-only 指令和默认人设示例；原关联任务的全 Adapter 会话矩阵及完整错误展示未在本轮全部交付。
- [x] M4 本轮范围：CLI、公开导出、仓外严格 TS、发行包、生命周期和 GC 回归。SDK HostApp 函数接线延期。
- [x] M5 本轮范围：im-test 隔离群、真实 Codex、动态指令一次调用及 completed；WeCom 真实平台、全 Provider 新建/续聊/reset 矩阵仍待验。

M3 是带系统指令的端到端验收前置，不阻塞先做纯合并函数。此前“执行准备错误”具体指 Extra 将含 `octo.control/instructions` 的完整 Context 交给只支持局部类型的 resolver，可能在 Provider 启动前拒绝；不是要求人设配置承担额外必填执行字段。

## 8. 验收清单

- [ ] config 在文件、SDK 声明和传输中仍是纯 JSON；函数与 AbortSignal 只存在于运行代码参数。
- [ ] 同步外层返回函数；loader 调用内层恰好一次，await 完成后才 loaded；旧接口明确失败。
- [ ] 同步、异步、不提供回调、空结果、非法结果及两来源重复 key 行为一致。
- [ ] 两渠道的覆盖、保序、整项替换、保留项冲突及最终预算均符合合同。
- [ ] Provider 重试不重取；新 Event 重新取；不缓存或省略业务 Context。
- [ ] 超时、取消、卸载、迟到结果和不合作 Promise 不产生无限新任务，不出现未处理拒绝。
- [ ] 满额接纳拒绝、终态清理和热重载满足 memory.md 的结构断言与堆测试。
- [ ] SDK 闭包在同一进程真实执行；config 不进入函数传输；取消与交互按 invocationId 工作。
- [ ] 三个内置 Extra、CLI、SDK、仓外第三方 TS 工程及发行物同步更新，没有隐含私有路径 import。
- [ ] 默认人设精确为 `我是明略科技的Octo助理`，instructions.entries 每项仅 text。
- [ ] 真实 Provider 新建/续聊/reset 证据区分“Context 已提交”和“系统指令实际应用”。
- [ ] build、typecheck、lint、lint:names、相关 Node 测试及跨包回归通过；内存测试按 memory.md 单独启用 GC。
- [ ] Octo 真实联调使用 `https://im-test.deepminer.com.cn/`；WeCom 用真实测试 Bot，缺条件则保持待验。涉及桌面时按 CDP 规则验证。

上方完整验收清单包含延期 SDK 和更广的 Provider 场景，不全部勾选。当前范围的检查与证据记录在 context.yaml 及交付记录，不将 86 分历史设计准备度当作完成比例。

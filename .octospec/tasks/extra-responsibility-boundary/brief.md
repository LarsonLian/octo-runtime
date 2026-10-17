---
type: Task
title: Extra 责任边界收敛与状态接口决策
description: 复盘动态配置改造的过度设计，明确宿主编排、插件状态和后续实施要求。
tags: [architecture, extra, lifecycle, integration]
timestamp: 2026-10-15T00:00:00Z
---

# 决策与实施状态

本次用户已确认：Extra 的通用管理以加载、卸载和状态查询为边界。宿主 App / CLI 负责配置保存及变更编排；每个 Extra 必须可查询自身状态，默认返回空对象。规则正文见 [Extra 合同](../../rules/extras.md)。

用户随后授权直接实施、不保留旧接口兼容。当前工作树已删除 `onConfigure`、`onRequest`、`configureExtra` 和 `requestExtra`，增加同步 `onStatus`，并调整 SDK、CLI、三个插件及 Work App。下文保留设计原因和验收要求；初次核对的旧实现按当时状态理解，实际测试及实机结果见[实施记录](../../journal/shared/2026-10-15-extra-responsibility-implementation.md)。

用户进一步明确：插件内部配置错误跳过受影响项，由插件状态解释，CLI 启动或加载时打印。IM 插件报告 `config_index` 与 `config_error`，有效 Bot 继续初始化；SSE 配置或监听失败报告 `errors`。授权配置无效时不连接，不能因“忽略错误”绕过授权。声明、入口及资源清理失败仍属于框架生命周期错误，不静默吞掉。

# 之前的改造为什么有问题

[差异审查](../../journal/shared/2026-10-15-integration-plugin-gap-review.md)发现的接入文档错误、生命周期管理缺口、业务状态缺口和宿主授权传递问题仍然成立。问题出在后续把“保留 App 逐 Bot 管理体验”扩大成“插件必须支持逐 Bot 原地增量更新”。[实施记录](../../journal/shared/2026-10-15-plugin-sdk-app-integration.md)中的动态配置实现和当时测试属于历史事实，不继续作为新架构要求。

| 之前的设计 | 责任不清晰的原因 | 本次决定 |
| --- | --- | --- |
| `configureExtra` 自动选择原地更新或卸载重载 | 宿主提交配置后，框架根据钩子决定变更路径；配置变更编排被分散到宿主、SDK 和插件 | 宿主明确卸载、保存配置、再以最新完整配置加载 |
| Extra 提供 `onConfigure`，IM 插件比较 Bot 指纹 | 为保留界面功能，额外要求插件复用未变化连接、处理增量和部分失败 | 不要求原地更新；同一插件内连接可以随插件整体重建 |
| `onRequest` / `requestExtra` 承载任意业务方法 | 一个状态观察需求扩大成通用业务 RPC，容易继续加入启停、删除 Bot 等控制 | 收敛为专用状态查询，不建立通用业务控制合同 |
| App 的 Bot 操作需要底层对应细粒度命令 | 将界面操作粒度误认为 SDK 生命周期粒度 | 界面仍可逐 Bot 编辑，宿主修改完整配置后重载对应 Extra |
| 在未核对代码时提出新 Extra 对象及异步 status | 忽略现有函数入口和 `onDispose`，也没有当前插件的异步查询依据 | 保留现有入口和清理机制，仅补同步状态回调 |

2026-10-16 F20 复核：上述连带重连只影响同一 Extra 实际存在其他 Bot 的部署。用户明确主要场景为单机单 Bot、大部分为独立部署实体，因此主流场景没有其他 Bot 被连带断线；此前将此代价笼统描述为普遍问题不准确。少数同机多 Bot 在配置更新时短暂重连已被接受，不值得为其引入公开逐 Bot 运行控制、指纹更新或增量失败合同。宿主仍可编辑公开配置和展示状态，但不得操纵插件内部 manager、Bot 或连接。完整需求价值与维护成本分析见[整体生命周期决策](../../journal/shared/2026-10-16-extra-whole-plugin-boundary.md)。

SDK 对应 Extra 的正常重载不扩散到其他 Extra 或共享 AdapterHost；CLI 当前通过 daemon restart 生效时，影响该 daemon 承载的插件和连接，须分别说明。宿主应如实呈现清理、加载及连接结果，不承诺平滑热更新、在途任务迁移或失败事务回滚。

# 清晰的责任分配

| 主体 | 负责 | 不承担 |
| --- | --- | --- |
| HostApp，包括客户桌面程序、Work App 和 CLI | 安装决策；保存配置；确定授权范围；选择加载和卸载时机；配置变更编排；解释状态并提供业务界面 | 不要求通用 SDK 理解 Bot、Octo、WeCom 字段 |
| SDK / daemon / Extra loader | 声明和协议校验；按名称加载卸载；实例停止信号与清理等待；状态调用及转发；如实报告生命周期失败 | 不选择存储、不隐式安装、不扫描宿主目录、不计算 Bot 配置差异、不按状态自动重连或重载 |
| Extra | 解释加载时收到的完整配置；校验业务身份和权限；管理内部连接、任务、重连与投递；维护并返回自身状态；执行清理 | 不决定宿主如何保存配置，不通过通用控制合同接管宿主配置管理 |
| AdapterHost | 提供共享的 invoke、cancel、respondInteraction 执行能力 | 不保存插件配置、不管理 Bot、不解释 Extra 状态 |

CLI 的配置目录读取属于 CLI 宿主装配行为；Work App 可继续使用账号 SQLite。统一 Extra 不等于统一宿主的存储实现。授权范围由受信宿主提供，插件在业务边界校验；状态不是授权凭据。

# 为什么增加 status

加载器的 `loaded` 只证明初始化函数已经完成，不能证明 Bot 已通过鉴权或外部服务可用。宿主需要观察内部状态，才能区分“配置停用”“连接中”“鉴权失败”“在线”，并决定如何显示、提示或重试。没有状态通道，宿主就会被迫依赖插件内部类或重新增加业务控制接口。

状态查询只读取当前快照，不触发联网探测、安装、启动、修改配置或修复。是否重载及如何处理异常由宿主决定；插件自己的正常连接和重连逻辑继续在插件内部运行。

状态能力是必备合同，默认行为是返回 `{}`；注册自定义回调不是必需动作。框架不得因插件没有自定义状态而返回“不支持状态查询”。空对象不证明健康或在线。

# 沿现有实现扩展

当前定义见 [extras.ts](../../../packages/octo-runtime-daemon/src/extras.ts)：插件默认导出加载函数，接收 `ExtraContext` 和配置，通过 `onDispose` 注册清理。无需另建插件类或重复定义 dispose。

已在现有 `ExtraContext` 中增加：

```ts
type ExtraStatusHandler = () => JsonObject;

// 加入现有 ExtraContext；其 adapterHost、signal、onDispose 保留。
interface ExtraContext {
  onStatus(handler: ExtraStatusHandler): void;
}
```

加载器为每个实例初始化 `status: () => ({})`，插件通过 `onStatus` 登记自己的实现。实例对宿主始终具备状态能力，插件返回自己定义的 JSON 对象。同步回调符合当前三个插件读取内存快照的需要；跨进程 SDK 查询仍可返回 Promise，不据此要求插件回调异步。后续新增异步需要时须另行说明依据，不能预先扩大合同。

通用层只约束 JSON 对象及协议数据约束，不投影字段、不规定通用 Bot/连接模型。各插件负责脱敏，不能返回 Token、完整秘密配置或未经处理的第三方错误。状态序列化需要把现有 `unknown`、`undefined` 等值整理为有效 JSON，不直接把 TypeScript 类型断言当作数据校验。

未加载、加载失败与已加载返回 `{}` 必须能区分。卸载后不得继续调用旧实例状态。框架生命周期与插件内部状态分别表达，不用一个 `online` 推导设备存在、插件加载和业务可用。SDK 使用 `extraStatus()` 查询生命周期、`extraStatus(name)` 查询内部 JSON，对应 IPC `extra.status` 的无名称与有名称两种请求；加载器通过 `inspect(name)` 调用实例回调。

# 现有三个 Extra 的适配依据

| Extra | 改造前核对的实现 | 已实施适配 |
| --- | --- | --- |
| `channel-gateway` | `extra.ts` 通过 `onRequest("status")` 同步返回 `channels.status` 数组；manager 从各 runtime 复制内存状态 | 改为 `onStatus(() => ({ bots: ... }))`；由插件规范每个 Bot 的 JSON 字段，宿主自行解释 |
| `channel-wecom` | 同样同步返回 manager 的 Bot 状态；已有 `onDispose` 关闭 manager | 独立提供自己的状态 JSON，不强制与 Octo 共享状态模型 |
| `sse-demo` | 没有业务状态接口；已持有 HTTP server、requests、tasks；dispose 中取消请求、关闭连接并等待任务 | 用 `server.listening`、`requests.size` 等内存值提供监听和活动请求状态，不额外进行网络探测 |

两种 IM 实现目前均使用 `config.enabled !== false` 计算 Bot 启用，`start()` 在 `enabled === false` 时直接返回，初始状态是 `stopped`。目标状态必须保留已配置但停用的 Bot，能看到 `enabled: false` 和实际状态；不能把停用项过滤成“未配置”。不必为了示例引入新的 `disabled` 状态码。

`{ bots: [...] }`、监听字段及其含义是对应插件的合同，不是框架统一字段。插件 README 必须描述自己的状态 JSON，Work App / CLI 按插件做定制展示。

# 后续整体架构要求

1. 删除通用 `onConfigure` 原地更新和任意业务 `onRequest` 控制路径；同步调整 SDK、daemon RPC、两个 IM 插件、App 和测试。底层已有的连接管理工具是否保留按内部使用需要决定，不能继续作为宿主通用合同。
2. 保留默认函数入口、`signal` 和 `onDispose`。卸载先通知停止，等待初始化、在途处理及 disposer 完成；清理失败如实返回，宿主不得把失败当作清理完成后继续加载。无需重建另一套 dispose。
3. 宿主按“卸载对应 Extra → 修改并保存完整配置 → 加载最新配置”编排。加载必须能取得宿主刚提交的配置，不能重用旧启动快照。SDK `loadExtra(descriptor)` 接收完整声明并拒绝已加载实例；CLI `extra load` 读取最新文件，`extraset` 只保存并返回 `reload_required`，不必重启 daemon。
4. 同名 Extra 的生命周期操作有序执行；每个实例独立持有状态回调、停止信号和资源清理。某个 Extra 的正常卸载、重载及初始化失败不得连带卸载其他 Extra 或重启共享 Host。这是资源与生命周期隔离，不承诺进程沙箱或恶意代码隔离。
5. runner 恢复使用宿主最新声明；宿主仍是配置的事实来源。账号或授权范围变化不得恢复旧账号配置。恢复不构成框架自主安装、扫描或配置推导的授权。
6. 保存成功、加载成功、内部连接成功分别反馈。`status` 失败不得伪装为健康或静默替换成默认空对象；默认空对象只用于未提供自定义状态实现。
7. Work App 可保留逐 Bot 编辑、停用、删除界面，内部转换为完整配置及对应 Extra 重载。`connectionsEnabled` 现有行为不自动改成 IM 总开关；如需变更产品语义，另行确认并同步合同。
8. 不扩大 Worker 范围；保持 Run=7、Context=v3。HostApp 安装归属、每轮 Context 由业务方决定、身份与权限校验、既有身份及 Home 保护继续遵循基础架构。
9. Work App 将界面数据保存在自身 SQLite，每次加载读取最新数据并生成内存中的完整 Extra config。执行引擎可用性不作为 Extra 加载门槛，不能因一个 Bot 的引擎不可用阻断同插件全部 Bot。执行时由执行层检查并返回真实错误；不将此项探测迁入 Extra。

# 后续验收

## 2026-10-15 dispose 修复计划（当前分支）

审查已复现：两个 IM manager 吞掉 close 异常；建联信号未接入 Extra signal；SDK 将卸载排在未结束的加载之后。用户授权直接在当前分支修复，沿用 signal、onDispose 与 close，不新增业务控制接口。

- Extra 的停止信号传入 IM 内部，manager 关闭先禁止新操作并中止正在初始化的连接，再等待队列和资源清理；停止不能依赖初始化先完成。
- runtime 与 manager 重复 close 等待同一个清理 Promise；每个资源均尝试清理，真实清理失败向上汇总，不把正常取消误判为清理失败。失败实例不得伪装成已释放后允许重载。
- SDK 卸载、退出和账号切换可及时发出停止请求；配置声明和账号状态的最终更新仍有序，不能让被取消的加载恢复为启用，也不能把旧账号的停止请求发到新进程。
- 回归覆盖：建联中卸载、活跃任务取消、内部 close 失败、重复 close 等待、SDK 加载中卸载/退出及恢复。构建后重启受影响进程，通过 im-test/CDP 验证实际加载与清理；模拟故障证据与线上验证分别记录。

当前状态：已在当前分支完成修复，Runtime／App 自动检查与限定范围 im-test/CDP 验证通过；实现、证据和未验收边界见 [dispose 修复记录](../../journal/shared/2026-10-15-extra-dispose-repair.md)。

- 默认状态返回 `{}`；三个插件各自返回有效 JSON，不含凭据；跨进程响应与插件同步回调分别验证。
- 多 Bot 启用与停用均可观察；修改配置只重载目标 Extra，其他 Extra 和共享 Host 保持可用。
- 清理完成前不能重新加载；覆盖初始化失败、在途任务取消、清理失败、重复操作与 runner 恢复。
- App 账号和授权范围切换不复活旧连接；保留 SQLite 及逐 Bot 界面，区分保存、加载和连接结果。
- 同步 INTEGRATION、SDK 合同、插件 README、打包和 CLI 使用说明；按新入口核对正式发行资源。
- 代码实施后运行相应构建与测试，重启受影响进程，通过 CDP 驱动真实 renderer 对着 im-test 验证。有效 Bot 在线、真实 IM 收发、审批和取消分别记录证据，旧方案测试通过不代表新方案已验收。

初次知识记录没有实施代码。后续授权实施后的验证须依据新接口重新执行，不能引用旧接口的通过记录代替；测试和实机范围在实施记录中更新。

---
type: Journal
title: 插件化接入文档与 Octo Work 双向差异审查
description: 对照当前 Extra、daemon SDK 和桌面 App，记录文档错误及插件迁移的能力缺口。
tags: [integration, extra, documentation, review]
timestamp: 2026-10-15T00:00:00Z
---

# 审查范围与结论

审查当前工作区的完整 `INTEGRATION.md`，并以 daemon SDK、CLI、Octo/WeCom Extra 实现和同级 `octo-work-app` 为交叉依据。工作区不存在 `octo-worker-app` 目录，本文使用接入文档已引用的 `octo-work-app`。文件存在其他进行中的修改，本记录只描述读取时的实现，不代表已发布版本。

结论：文档尚不能作为完整的插件化接入指南。CLI 第 1.4 节已经使用 `extraset`，SDK 章节仍以对象式 `modules` 为主要接入方式，并且本地执行示例使用了已失效的公开方法签名。Octo Work 的本地调用已使用统一 `InvokeInput`，但 IM 装配仍使用 `modules`，没有迁移为函数式 `extras`。

`modules` 和 `extras` 当前同时存在于 SDK 类型和 runner 中，不能把现有 `modules` 调用误报为无效 API；问题在于文档没有解释两种合同，且缺少采用统一 Extra 的完整路径。

## 按影响排序的问题

### G1 · P1 · SDK 执行示例不能通过类型检查

- 文档：`INTEGRATION.md:524` 调用 `harness.invoke("codex", request, { protocolMode: "canonical" })`。
- 实现：`packages/octo-runtime-daemon/src/runtime/types.ts:107` 定义 `invoke: InputInvoke`；`daemon-runtime.ts:52` 使用 `createInputInvoke`。旧的三参数形式仍存在于内部 `invokeFrames`，不是当前公开 `invoke` 的形式。
- App：`octo-work-app/src/main/conversation-run-transport.ts:33` 先用 `invocationInput(request, 'canonical', adapterType)` 转换，再调用 `invoke(input, { signal })`。
- 影响：复制文档示例会得到 TS2554；忽略类型检查也不满足统一输入合同。
- 建议：第 2.5 节改为统一 `InvokeInput`，使用 `protocol_mode`，把 `signal` 放在第二参数。内部 `InvokeRequest` 可作为准备过程，但不能直接套用旧公开调用签名。同步更正字段表和方法表。

### G2 · P1 · SDK 章节没有可执行的统一 Extra 装配路径

- 文档：第 0.2、2.2、2.3、2.6 节仍讲 `startModule`、`requestModule`、`stopModule` 和 `createImModule`。第 2.2 节的 `createDaemonRuntime` 示例没有 `modules` 或 `extras` 声明。
- 实现：`runtime/types.ts:42` 支持 `extras: ExtraDescriptor[]`；`runtime/runner.ts:62` 将声明交给 `extraRegistration`，使用插件默认导出。对象式工厂则单独通过 `modules` 加载。
- App：`daemon-runtime-service.ts:54` 明确登记两个 `modules`，`modulePath()` 指向 `dist/daemon-module.js`，导出名为 `createImModule`。
- 影响：读者无法从本文完成函数式插件 SDK 接入；只照示例调用 `startModule` 也缺少注册前置步骤。包名包含 extra 不代表使用了函数式 Extra 加载器。
- 建议：补充 `createDaemonRuntime({ extras: [{ name, module, config }] })` 的完整 Node/桌面示例。明确默认插件入口与 `daemon-module` 是不同合同；参考 App 当前状态应如实标为对象式模块接入。

### G3 · P1 · Extra 不能直接承接 App 现有的逐 Bot 动态管理

- App：`daemon-runtime-service.ts:218` 按需启动模块，再执行 `upsert/remove/status`；`im-channel-service.ts:104` 保存 SQLite 后应用配置，不要求退出聊天或重启整个 Runtime。
- Extra：`extra-channel-gateway/src/extra.ts:6` 仅在 load 时遍历 `config.bots`，返回 `void`；没有暴露管理句柄。WeCom 使用相同结构。
- SDK：公开 `DaemonRuntime` 有模块控制方法，没有对应的 Extra load/unload/reconfigure 方法。服务端已有 `extra.load/unload/status` RPC，但 SDK 尚未提供相应封装。SDK 的 `extras` 声明来自创建 Runtime 时的 options，不是新的磁盘配置扫描。
- 影响：把 App 的 `modules` 直接替换为 `extras` 会丢失现有动态编辑路径。停止再启动同一 SDK 实例也不等于提供了公开的配置更新 API。
- 建议：先确定配置更新合同。若选择重建 Runtime 来应用完整声明，必须说明对在途执行、会话和其他插件的影响；若要求保留当前动态管理体验，需要补充明确的插件控制能力。不能在文档中凭空新增 API，也不能未经决定把业务方法塞进通用 loader。

### G4 · P2 · 插件生命周期状态与 Bot 连接状态没有接通

- 文档：第 2.3 节只返回 `health.modules`，并使用已归档 Worker 的 `state.runtimes[].connected` 解释连接健康。
- 实现：SDK 已提供 `health.extras`；`ExtraStatus` 只有 `phase/error`，`loaded` 不代表 WS 已连接。
- App：`imStatus()` 通过对象模块的 `status` 查询逐 Bot 连接状态；`ImChannelService.#entry()` 使用 `connection_key/state/error` 映射 UI。当前 `EmbeddedRuntimeStatus.cloudConnected` 固定投影为 false，不能用它判断 Bot 是否在线。
- 影响：按统一 Extra 迁移后，现有 UI 无法仅凭 `health.extras` 继续显示逐 Bot 状态。文档也无法指导插件失败与连接失败的区分。
- 建议：文档分别说明本地 Host 就绪、Extra 加载状态和插件业务连接状态。保留插件业务状态的查询方案需要明确实现，不能把 `loaded` 映射为 connected。

### G5 · P2 · 对象模块的租户约束没有在 Extra 路径中等价体现

- 对象模块：`extra-channel-gateway/src/daemon-module.ts:29` 在有 account 时注入 `authorizeSpace`，限制 Bot 认证得到的 Space 必须属于当前账号 profiles。
- Extra：`extra-channel-gateway/src/extra.ts:9` 只注入 Host 和凭据来源，没有同一 `authorizeSpace`；最小 `ExtraContext` 也不包含账号 profiles。
- 影响：两种装配路径的授权行为不同。把 App 改用 Extra 时不能假定原约束自然保留。独立设备的 Bot 自有身份与 App 当前账号授权集合也不是同一事实。
- 建议：明确由插件业务配置或受信宿主能力提供授权作用域，并在原业务边界执行校验。是否要约束为登录账号的 Space 集合，需要保留明确的产品决策；本审查不把当前差异直接判为独立 CLI 的越权漏洞。

### G6 · P2 · 文档把外部接入决策归给了 AdapterHost

- 文档：第 0 节和 0.1 节两次描述 AdapterHost 决策外部连接方式。
- 当前架构：HostApp 决定安装和启用哪些 Extra；Extra 自己管理业务连接，AdapterHost 提供统一执行能力。
- App：宿主服务选择装配的包，IM 服务提供配置；执行内核不选择 Octo 或 WeCom。
- 影响：客户可能在执行内核扩展业务路由或连接注册，形成新的业务耦合。
- 建议：重写这两处责任说明，用 HostApp 装配、Extra 接入、AdapterHost 执行描述当前职责。

### G7 · P2 · 已归档 Worker 能力仍被描述为当前可用接入

- 文档：第 2 节表格仍提供 Worker submit/SSE 路径；第 1.5、2.4、2.8 节要求读者查看第 2.6 节远程接口，但第 2.6 节实际只有两句可选 Channel 说明。第 1.5 节还称 doctor 检查凭据和云端连接。
- 实现：`apps/cli/src/main.ts:356` 的 doctor 只检查 Node、Home 配置、服务程序/管理器/定义、本地 IPC。当前发行物不加载归档的 worker-access。
- App：当前会话 transport 使用本地 Runtime；`AgentWorkClient` 存在旧 enrollment 方法，不等于当前运行链启用了远程执行。
- 影响：读者会沿着缺失章节实施无法闭环的远程接入，并把未检查的云端状态当作 doctor 已验证。
- 建议：将归档能力从当前操作步骤和能力表移出，清理所有悬空章节引用；doctor 按真实检查项说明。若另有远程 Extra，只在其合同和实现确定后补回。

### G8 · P2 · 桌面发行和插件路径准备缺少可复现说明

- 文档：第 2.1 节只安装 daemon/protocol；第 2.2 节用一句话提到 `distribution`，没有给出插件安装、打包和入口路径示例。
- App：`scripts/prepare-embedded-runtime.mjs:44` 部署 daemon 生产依赖，随后单独部署 gateway/wecom 两包到 `sdk/modules`；`daemon-runtime-service.ts:342` 起的发行物装配指定 Node、runner、manifest、Host 入口，并区分开发和打包后的插件路径。
- 影响：纯 Node 最小示例可以使用当前 Node，但不能直接当成 Electron 正式包的完整接入方案。只加包名不能保证 runner 进程能解析宿主自己的 node_modules。
- 建议：分别给 Node 开发与桌面发行示例；说明插件必须已安装且能从 runner 解析，桌面可使用宿主提供的绝对入口。`extras` 应指向默认插件入口，不照搬 App 的 `dist/daemon-module.js`。

### G9 · P2 · App 的 connectionsEnabled 语义不是完整的 IM 总开关

- App：`setConnectionsEnabled(false)` 会停止当前模块，但 `upsertImBot()` 不检查该值；`index.ts:1096` 的 IM ready 条件只看本地 Runtime。`tests/embedded-harness-service.test.ts` 明确覆盖了设为 false 后仍通过 upsert 启动模块的行为。
- 影响：不能在接入文档或 Extra 迁移验收中把此字段当作已生效的全局远程接入策略。显式保存启用的 Bot 是否允许覆盖该开关，当前名称和文档没有解释。
- 建议：明确它控制哪些连接，以及 Bot 启用设置与该字段的优先级。如果产品要求它是 IM 总开关，再修改实际入口和测试。本记录将其列为语义缺口，不直接把已有测试确认的行为判定为回归。

### G10 · P2 · 配置示例未完整说明 Extra 的名称和失败边界

- 第 1.4 节的两个现有名称正确，但未说明声明名必须等于插件导出的稳定 `name`；不能用 `channel-gateway-2` 绕过单实例来配置第二个 Bot。加载器会返回 `EXTRA_NAME_MISMATCH`。
- 保存成功只表示声明写入，插件业务配置在 load 时校验；单个 Extra 失败不必导致本地 Host 失败。应要求查看 `extra status`，并区分 loaded 与真实连接成功。
- 本轮已修正的整体替换、重启生效、`config.bots` 和保存路径与实现相符。`default/extra` 是 CLI 当前存储位置，不表示 Extra 归属于 default profile。
- 建议：补上上述约束及错误观察步骤，并链接统一 Extra 配置指南，避免再次复制出不一致的合同。

## 双向能力对照

| 维度 | Runtime / CLI 当前能力 | Octo Work 当前使用 | 差异 |
| --- | --- | --- | --- |
| 本地调用 | 统一 InvokeInput | 已使用统一输入和 invocationInput | 文档第 2.5 节落后于两端 |
| 函数式 Extra | SDK extras 声明、默认导出、清理加载器 | 未传 extras，使用 modules | App 尚未采用新加载合同 |
| 动态管理 | CLI Extra load/unload，启动快照；SDK 无同等公开方法 | 模块级启停、逐 Bot upsert/remove | 无法直接替换而保持体验 |
| 配置存储 | CLI 私有 JSON；SDK 接受宿主对象 | 按账号 SQLite 保存并恢复 | 来源可不同，不是协议缺陷 |
| 插件健康 | health.extras 生命周期状态 | 模块 RPC 的逐 Bot 状态 | 缺少可复用业务状态通道 |
| 生命周期恢复 | runner 重启重放 extras 声明 | health 触发 SQLite restore | 两种路径不同，不应双重装配同一连接 |
| 授权 | Extra 最小上下文无账号 profiles | 对象模块校验账号租户 | 迁移要明确保留的授权策略 |
| 打包 | 已安装包名或绝对路径 | 独立 deploy 两个模块及固定 Node | 文档缺完整桌面装配示例 |
| 无插件执行 | 支持 | 本地聊天不经 IM 插件 | 一致，内部业务无需强包成 Extra |
| 登录依赖 | 本地 SDK 不要求 Octo Token | App 策略要求先登录 | 是宿主策略差异，不能写成 SDK 要求 |

## 修正顺序建议

1. 先修文档确定错误：统一 invoke、职责归属、归档 Worker 引用、doctor、CLI Extra 约束。
2. 补全 SDK extras 的最小接入与桌面打包示例，如实标出 App 仍使用 modules。
3. 确定 App 必须保留的动态管理、业务健康与授权行为，再决定 Extra 合同如何承接。
4. 实现后的验收分别覆盖无插件本地执行、多个 Bot、编辑停用删除、账号/Space 切换、runner 重启恢复、交互取消、正式包路径与清理。真实调试连接 im-test，按仓库要求使用真实 renderer/CDP。

## 本轮验证与限制

- 通读完整接入指南，对照当前源码、类型和现有测试；没有修改运行时代码或原接入指南。
- 将文档全部 TypeScript 代码块组合为内存中的临时源文件，使用仓库 TypeScript 严格检查；得到一项示例错误 TS2554，对应 G1。没有生成临时源码文件。
- 检查接入指南的本地 Markdown 文件链接，均存在。章节引用到 2.6 的语义错误由人工对照确认，文件存在不代表章节内容正确。
- 没有执行模型请求、启动或重启桌面 App，没有进行 im-test 联调。因此不声明插件化桌面全链路已验证，也不把静态审查当成上线验证。

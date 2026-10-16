---
type: Design
title: Extra 函数接口、宿主装配与动态 Context 时序
description: 明确两阶段调用签名、SDK 同进程装配选型、回调输入范围、替换算法及系统指令生效边界。
tags: [extra, channel, context, typescript, lifecycle]
timestamp: 2026-10-16T00:00:00Z
---

# Extra 函数接口、宿主装配与动态 Context 时序

状态：推荐设计，未实施。需求及范围以[任务简报](brief.md)为准。

## 1. 三类函数各做什么

| 函数 | 同步 / 异步 | 调用次数 | 副作用 |
| --- | --- | --- | --- |
| `extra(context, config)` | 同步，返回 initializer | 每个加载实例一次 | 仅同步检查及构造闭包，不启动连接/定时器，不登记长期资源 |
| `initializer(dependencies)` | void 或 Promise<void> | loader 对该实例恰好调用一次 | 创建连接及内部管理器，登记清理和状态，完成启动 |
| `loadContexts(botConfig, options)` | 数组或 Promise<数组> | 每个接纳的逻辑轮一次 | 业务方决定是否做 IO；不取得插件内部对象 |

外层用同步函数使“构造初始化动作”与“执行初始化动作”可明确区分。异步启动放在内层，不支持外层 Promise<initializer>，不再给 loader 增加入口形态分支。回调必须同时支持同步和异步，统一 await。await 不会把 CPU 工作放到另一个线程。

```ts
const fromMemory: LoadContexts = config => readCurrentItems(config);

const fromService: LoadContexts = async (config, { signal }) => {
  return await fetchCurrentItems(config, { signal });
};
```

上述 readCurrentItems / fetchCurrentItems 是宿主业务函数示意，不是新增 Runtime API。

## 2. 通用接口与所有权

目标公共类型：

```ts
export type ExtraInitializer<D extends object> =
  (dependencies: Readonly<D>) => void | Promise<void>;

export type ExtraPlugin<D extends object = Record<string, never>> =
  (context: ExtraContext, config: JsonObject) => ExtraInitializer<D>;

export interface ExtraPluginModule<D extends object = Record<string, never>> {
  readonly name: string;
  readonly default: ExtraPlugin<D>;
}
```

ExtraContext 保留现有 adapterHost、signal、log、onDispose、onStatus。不加入业务 Context 拉取器，不把所有插件依赖合成通用大接口。依赖对象只作为具名函数参数的容器；不新增 register/get/resolve 或运行时反射机制。

通用 loader 的目标加载方法：

```ts
load<D extends object>(
  module: ExtraPluginModule<D>,
  config: JsonObject,
  dependencies: Readonly<D>
): Promise<void>;
```

保留 `unload(name)`、`inspect(name)` 和整体 lifecycle status。加载直接接收模块及其类型化函数依赖，TypeScript 在调用点检查 D；loader 内部只保存启动后的生命周期资源，不长期保存多种 D 的异构依赖注册表。模块由宿主 import，不引入新的模块 factory。现有 ExtraRegistration 的注册/加载混合合同由该入口替换，不做双接口兼容。

同名只允许一个未清理实例。配置或函数实现改变后，宿主先 await unload，再用完整新配置及函数调用 load。没有无参 reload，不由 loader 保存旧函数以便自动重放。

config 在加载边界按现有 JSON 合同校验并克隆一次。dependencies 不 structuredClone、不序列化；只复制并冻结其浅层具名属性，固定本实例所用函数引用，不递归冻结宿主业务对象。回调内读取宿主最新数据是外部业务选择，不要求插件保存历史结果。

## 3. 内置 Channel 入口

示意代码只展示职责，省略现有业务校验、脱敏和状态字段：

```ts
export default function extra(context: ExtraContext, config: JsonObject) {
  const validated = validateChannelConfig(config);

  return async (dependencies: Readonly<ChannelDependencies>) => {
    assertChannelDependencies(dependencies);
    context.signal.throwIfAborted();
    const channels = createInternalChannels({
      config: validated,
      context,
      loadContexts: dependencies.loadContexts
    });
    context.onDispose(() => channels.close());
    context.onStatus(() => channels.status());
    await channels.start();
  };
}
```

内部类、局部可变状态和连接管理仍可使用。函数式公共 API 不要求把网络状态机重写为递归纯函数。资源创建后立即登记清理，再执行下一项异步动作；未登记清理前不得启动会遗留资源的后台任务。

两个 Channel 各自公开 ChannelDependencies。第一版只有可选 loadContexts，不公开 ImModuleDependencies、sessions、credentials store、manager 或连接控制器。WebUI 没有此业务需求，依赖类型为空，仍迁移两阶段入口。

## 4. SDK 与 CLI 的装配选型

### 已有事实

当前 `DaemonRuntimeOptions.extras` 和 `loadExtra(descriptor)` 接收纯 JSON。supervisor 将 extras 写入 runner session 文件；runner 在子进程将 descriptor 变成 registration，server 创建 ExtraPlugins。仅给 ExtraPlugin 加泛型不能让 HostApp 的闭包出现在 runner 中。

源码依据：[SDK 类型](../../../packages/octo-runtime-daemon/src/runtime/types.ts)、[SDK 加载](../../../packages/octo-runtime-daemon/src/runtime/daemon-runtime.ts)、[supervisor](../../../packages/octo-runtime-daemon/src/runtime/supervisor.ts)、[runner](../../../packages/octo-runtime-daemon/src/runtime/runner.ts)、[server](../../../packages/octo-runtime-daemon/src/server.ts)。

### 推荐选择：Extra 在调用方的 Node 组合层执行

SDK 的目标方法为 `runtime.loadExtra(module, config, dependencies)`。SDK 在 HostApp 的 Node 进程内拥有 ExtraPlugins；依赖是同进程普通函数调用。共享执行端口调用已有 daemon/AdapterHost 执行链。此处不移动 Provider 或 AdapterHost，不改变其进程隔离合同。

```ts
await runtime.loadExtra(channelGatewayModule, jsonConfig, {
  loadContexts: async (botConfig, { signal }) => {
    return await hostBusiness.readContexts(botConfig, { signal });
  }
});
```

module 和 hostBusiness 为宿主显式 import 的代码值；jsonConfig 为宿主已准备的 JSON。运行层不去 renderer 执行插件，不暴露凭据给 renderer。Electron/Node 宿主在 main 组合层运行；其他宿主需有可执行此 TS/JS 的 Node 组合层，不能宣称原生 Rust 内存里的 lambda 可直接注入 Node。

这是一项明确的 SDK 装配改动，尚未证明完成，不包装为现有 API 已支持。M0 必须完成：

1. SDK 本地 loader 使用与 Host 相同语义的执行端口，invoke/cancel/respondInteraction 均按 invocationId 工作。
2. 当前 SDK 的 cancelRun/respondRun 使用 runId，不能直接改名后冒充 ExtraAdapterHost；增加准确的 invocation 端口桥接并验证相应 RPC 处理，不建立历史 runId 映射缓存。
3. SDK stop/account switch/reconfigure 先使本地 Extra 停止接纳并 abort，再等待清理，最后停止执行服务；停止失败如实返回，不自动重建新实例。
4. SDK health 的 Extra 状态归本地 loader；daemon 不再为 SDK 重复加载相同 Extra。CLI daemon 状态仍查询它自己装配的实例，不合并两份互相矛盾的状态。
5. daemon 重启恢复只恢复执行服务。不得借故障恢复自动重放模型调用或复制 Extra 业务状态；业务连接如何面对执行端口暂不可用遵循原合同。
6. 第三方发行包提供实际可 import 的 SDK 及内置 Extra 代码入口，声明文件传递依赖完整；仓外 skipLibCheck=false 编译和执行通过。当前 package.json 的 /extra 主要导出类型，不能把拟新增子路径写成现有入口。

CLI 是另一宿主。CLI 继续读取 JSON descriptor、检查 enabled、import 模块，在 daemon 内调用同一 load(module, config, {})；模块名字必须与 descriptor.name 一致。CLI 默认不提供动态函数，不增加 JS 表达式配置开关。需要自定义函数的代码宿主显式装配。

不采用另一条函数 RPC、回调服务、函数 ID 注册表或生成源码方案。SDK 组合位置不通时，M0 保持未完成并修订装配设计，不靠跨进程代理补齐。

## 5. 生命周期时序

```text
HostApp 准备 module + JSON config + 函数依赖
  -> loader 准入、同名检查、建立本实例 signal
  -> 克隆 config
  -> module.default(context, configSnapshot)
  -> 检查返回值确实是函数
  -> await initialize(dependencies)
  -> 未被取消，标记 loaded

卸载 / 初始化失败
  -> 立即停止接纳并 abort
  -> 等待初始化及受管操作结束
  -> 逆序清理所有已登记资源
  -> 释放 status handler、配置闭包、依赖引用和操作队列
  -> 成功后 disposed；失败则 error，阻止覆盖重载
```

外层同步抛错、缺 initializer、依赖格式错误和内层拒绝均不可标 loaded。旧 async void 插件的 Promise 不作为新接口接受；必须 abort 并走失败清理，不能造成未处理拒绝。加载器不得只 await 外层返回的函数对象。

加载/卸载竞争继续使用每名串行和代次失效机制。排队前被卸载取消的加载不得调用入口；初始化中取消不得随后标 loaded；onDispose/onStatus 不能在实例封闭后登记。清理失败不报告成功、不新起第二组资源，不影响其他 Extra 及共享内核的正常生命周期。

## 6. 动态函数的输入输出

输入第一参数为当前 Bot 的**完整配置快照**，不传整个 config.bots 数组。这样不会因为同插件多 Bot 而误读另一个 Bot。字段仍为 JsonObject，与该 Channel 已有 Bot config 合同一致。

每轮向回调提供独立克隆，回调修改它不改变本实例静态配置。内部一次仅引用这一轮快照；不把 config、context 及所有消息捆进万能参数。Bot config 可能含凭据，回调是可信宿主代码，不记录完整输入。若业务只需部分字段，由宿主函数按其需要读取。

第二参数是本轮加载操作的 AbortSignal；关联 Extra 卸载、该轮实际取消和加载超时。reset 仍不等于取消，已入队旧轮保留冻结身份；迟到结果不得写回新 session 的 binding。不给 options 加 manager、session store 或 arbitrary context bag。

返回必须是有限数组；不接受 envelope、undefined、null、async iterator 或 stream。不提供回调与回调返回非法值分别处理，不能把非法返回当作空列表。允许直接返回 readonly 数组；框架验证并建立自有快照后不再依赖外部数组的后续变化。业务方不得在交付后并发修改结果；代理对象及有副作用 getter 不属于普通 JSON 值合同。

## 7. 调用位置与错误

先完成消息准入、去重和既有队列接纳；真正轮到执行时取得动态加载槽位，调用回调；随后合并静态业务项、追加本轮 Channel 材料，完成最终校验，再提交统一 InvokeInput。不得在每条 socket 消息、typing、重连或状态查询时调用。

Provider 执行重试使用已冻结快照，不重复外部读取。准备失败没有成功快照，不启动 Provider。用户显式再次发起的新尝试是新逻辑轮，可以重新加载；现有自动 Provider 重试不覆盖这类准备失败。

实现时把本轮合并后的配置项作为 buildContext 的显式参数传入，而不是修改 Bot config 再调用原生成器。Gateway 保留 initialSession/mentionGuidance 等已有本轮选项，transport/contexts.ts 以传入列表替代当前克隆 config.context.items 的位置；WeCom 的 transport/channel.ts 同样使用本轮列表。两者只取一次静态基线，不能在生成器末尾再次追加原始 config.context，造成被覆盖项复活或重复 key。两渠道的消息内部合同和 fixtures 一起更新，不把此参数开放为宿主控制接口。

稳定错误建议统一为 Channel 任务诊断：`IM_CONTEXT_LOAD_FAILED`、`IM_CONTEXT_LOAD_TIMEOUT`、`IM_CONTEXT_LOAD_BUSY`、`IM_CONTEXT_LOAD_INVALID`。实际错误码在实现时统一登记；不把外部 exception.message 原样发到状态或 IM，不把本轮失败写成连接断线。展示与准备失败的收尾引用既有统一执行准备任务。

## 8. 合并与验证算法

建议内部小函数 `mergeConfiguredContexts(base, dynamic)`，输入普通 ContextItem 数组，返回新数组；不得修改两输入、读业务状态、执行 IO 或持有跨调用缓存。函数名不是新增公开协议。

1. 两输入分别按 v3 校验；同一输入中重复 key 拒绝。32 项/65,536 字节预算也约束动态返回本身。
2. 用 namespace/name 的有序二元组构造键，避免简单连接字符串碰撞。
3. 按 base 顺序建立新列表及本次调用内的 key-to-index Map。
4. 顺序遍历 dynamic；已有 key 替换该位置整项，新 key 追加。
5. 对合并列表以及追加 Channel 材料后的最终 envelope 校验预算与协议。
6. 返回拥有自有 JSON 数据的快照；临时 Map 随本次调用结束即可回收。

不要直接调用现有协议 `mergeContext`：它对 model、limits、envs、mcp 有特殊字段合并，违反本次“同 key 整项替换”语义。也不改变该函数影响其他消费者。

Channel 已生成的 extra.im 保留项按实际生成器列出冲突名单，沿现有重复/保留项校验拒绝，不能开放 callback 伪造 sender、source 或真实消息。普通业务自定义项可替换其静态同名项。动态执行配置仍受 adapter/权限/mandatory/fixed workdir 检查，函数注入不构成权限绕过。

## 9. 系统指令与每轮提示词

`octo.control/instructions.payload.entries` 是 `{ text: string }[]`。source 移除和单换行拼接由已有任务实现。本任务不复制另一套协议定义。

动态覆盖 instructions 是整项替换，包含默认人设的静态 instructions 不会自动与动态 entries 拼接。推荐业务回调将当轮提示放普通 extra 业务项；确需覆盖系统指令时显式构造完整列表。

准备完成不表示已有 Provider session 接受了新的 system 指令。新会话按 Adapter 合同初始化；续聊是否允许更新 system 按真实 Provider 能力及既有执行合同处理。本任务不自动 reset、不比较指令 hash 后偷偷开新 session。需要全新系统指令时由业务显式新建/reset；验收必须区分调用输入与原生应用结果。

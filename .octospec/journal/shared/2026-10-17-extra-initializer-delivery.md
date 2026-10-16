---
type: Journal
title: Extra 两阶段入口与三个 CLI 插件交付
description: 纯 JSON 配置、独立业务函数、动态 Context、有界生命周期与真实测试环境验证。
tags: [extra, channel, context, testing, lifecycle]
timestamp: 2026-10-17T00:00:00Z
---

# 范围和结果

按[详细计划](../../tasks/extra-initializer-context-dependencies/brief.md)实施，基线 `aad4086`。用户最新明确“实施完之后 commit，当前 CLI 也能生效，SDK 接入先不用改”，并要求 CLI 三个 Extra 都生效。因此本轮覆盖共享 loader、channel-gateway、channel-wecom 和 webui，SDK HostApp 的进程装配迁移延期。未修改现有 Runtime 身份、Home、profile 或已有 Bot 配置。

入口统一为 `extra(context, jsonConfig)(dependencies)`。外层同步，内层可异步，loader 等待初始化完成；CLI 传空依赖。公开 ExtraPlugins 增加同进程 `load(module, jsonConfig, dependencies)`，函数与 JSON 分开，旧 void/Promise 入口明确拒绝。不增加函数序列化、执行字符串或跨进程代理；现有 SDK descriptor 仍只支持 JSON。

两个 Channel 的可选 loadContexts 支持同步数组和 Promise，每个接纳轮次调用一次；每次收到独立配置快照及 AbortSignal。同 namespace/name 的动态项整项替换静态项并保留原位置，新项依序追加；不深合并、不拼接 instructions、不缓存历史结果。Provider 重试复用本轮快照；控制命令不触发回调。Channel 生成的身份、消息来源等保留项不能由动态结果伪造。

WebUI 新增显式 config.context，并与本轮 InvokeInput.contexts 按相同覆盖规则合并；本轮输入优先。三个配置 Schema 和完整使用示例均显式包含固定人设“我是明略科技的Octo助理”。这不是底层自动补齐：已有省略 context 或空 items 仍有效，未自动写入。instructions.entries 仅保留 text，单换行拼接，完整删除 source 的协议支持，无历史兼容解析。

双渠道 dispatcher 改为提交公开 InvokeInput，删除 Extra 内 resolveLocalContext 等重复执行准备，Host 统一解析执行合同。这修复了配置指令后可能在调用 Provider 前出现 LOCAL_CONTEXT_TYPE_UNSUPPORTED 的故障；不将全面准备失败卡片改造或所有 Provider 会话矩阵标为完成。

# 内存、取消和清理

动态加载默认超时 5000ms、最多 8 个实际在途；可配置范围分别为 1..30000ms 和 1..32。没有等待回调的队列；满额拒绝当前轮。超时只终止等待，底层 Promise 真正结束前继续占额，迟到结果不进入模型。抛错、非法结果和取消均不调用 Provider，也不使用上次结果兜底。

外部结果在 clone/stringify 前限制为有限 JSON；预检最多 32 层、262144 遍历/字符预算，拒绝循环、访问器和可执行 toJSON。最终仍按 Context v3 校验，包括 32 项、64KiB 和重复 key。同步用户函数、它自行分配的巨大对象或业务缓存仍属于受信任 JS；这些约束不构成绝对 OOM 隔离。

卸载先 abort，再等待初始化和逆序清理，5 秒宽限；并发 unload 共享同一过程。状态回调和 disposer 引用在清理时释放。失败会汇总，其他插件仍尝试清理；清理失败或不合作 IO 超时保留失败实例并阻止同名重载，避免重载绕过资源额度。声明和已知名称、在途 load 操作均有 64 的准入限额。SDK 整体停止/HostApp 通知装配留待后续迁移。

# 验证证据

- Runtime 全量构建、TypeScript、eslint、名称检查通过。最终 Node 共 1062 项、1053 通过、9 跳过、0 失败；WebUI Vitest 35 项通过。OKF 校验通过：175 个单元、20 条规则、1433 个本地文件链接；git diff --check 通过。
- 强制 GC：动态加载预热 1000 次后再执行 10000 次，保留堆增量 -964312 字节，最终单独复验为 -1520944 字节；Gateway 10000 会话为 -1417608 字节，WeCom 为 40112 字节。受控压力测试未见随累计轮次增长的保留堆；不推断任意业务 IO 或生产长期稳定性。
- 同步/异步回调、整项覆盖、异常不 invoke、超时未结束占额、取消、迟到结果、卸载失败不重载及正常 100 次 load/unload 回归通过。两个 Channel 均验证准备阶段 /stop 能取消回调。
- 发行包离线安装验证通过：公开 /extra 严格 TypeScript、私有入口阻断、外部插件加载、三个内置 Extra 保存声明后实际加载，以及 WebUI HTTP 200。卸载包保留测试 Home；未发布 npm。
- im-test 真实 Gateway 入站到 Codex 完成：动态函数调用 1 次、Provider 调用 1 次，验证控制指令为固定人设加动态指令的 text-only 文本，最终完成并返回预期标记；日志未包含正文和凭据。命令为 `node scripts/verify-im-context-live.mjs --dynamic-contexts`，QA 账号通过本地环境变量指定，未写入提交。
- Worker `make build` 和桌面 `pnpm build:test` 通过。两处源码未为本任务修改；该构建不证明桌面已接入本次 SDK 函数组装，既有桌面进程不宣称已更新。本轮通过隔离 CLI daemon 启停验证新的运行产物。

# 保留边界

SDK HostApp 同进程函数装配、SDK 消费者迁移、全 Provider 新建/续聊/reset/恢复失败矩阵，以及完整准备失败展示仍待验。企业微信完成本地真实插件/模拟协议回归，未做企业微信线上凭据联调；WebUI 完成加载、HTTP、SSE 和 UI 回归，未新增真人浏览器端模型验收。Context v3 的其他简化候选只保留评估，不借本次改造删除必要执行或权限合同。

本机原默认 daemon 未运行；更新 CLI 不自动启用或重启已有 Bot。本机 CLI 使用本次构建的发行包更新，提交后重新生成 build-info 并以 --version 核对提交号；不将覆盖用户配置作为“CLI 生效”的前提。

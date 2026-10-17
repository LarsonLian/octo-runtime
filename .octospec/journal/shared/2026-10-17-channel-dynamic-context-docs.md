---
type: Journal
title: Channel 动态 Context 场景、SDK 方案与核心注释
description: 记录逐轮读取宿主提示词的架构说明、静态动态覆盖合同、SDK 示例验证及延期边界。
tags: [extra, channel, context, sdk, documentation, testing]
timestamp: 2026-10-17T00:00:00Z
---

# 范围与结果

从 `4264258` 开始，按用户要求补充动态加载的核心使用场景：宿主更新 Agent 提示词及业务数据后，下一轮调用已注入的同一个 loadContexts 读取新值，无需重载 Channel Gateway，不开放插件内部 Bot、连接或 manager 控制。

新增[Octospec 专题](../../guides/channel-dynamic-contexts.md)，在 [SDK Channel Gateway 指南第 7 节](../../../SDK_CHANNEL_GATEWAY_GUIDE.md#7-逐轮加载-agent-系统提示词与业务-context)提供同步内存读取、异步 IO 读取、真实同进程 loader 装配和后续 SDK 初始化步骤。同步架构规则、Extra 规则、既有任务、配置指南和 Gateway README。为共享 Context loader 及两个 Channel 装配代码补充中文注释；本轮产品代码仅修改注释，没有修改接口或执行行为。

说明明确区分三类变化：函数读取的宿主数据变化无需生命周期操作；JSON 配置或函数引用变化需整体卸载后加载；可信 system 指令实际应用继续遵守 Provider 会话合同，不因动态取值自动 reset。覆盖规则为同 namespace/name 动态整项替换、保留静态位置、新 key 保序追加；不合并 payload 或 entries，空动态列表保留静态项，加载失败不使用旧值兜底。覆盖 instructions 时须由宿主显式保留固定人设。

# 验证

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 全 workspace build、公开入口和根类型检查通过；WebUI 仍有既有 chunk 大小提示 |
| `pnpm lint` | 通过 |
| 新章节 3 个 TS 示例 | 自动提取后按 NodeNext、strict、skipLibCheck=false 编译通过；ContextItem 正确从 protocol 导入，并说明宿主直接依赖 |
| `node --test test/context-loader.test.js test/im-extra-disposal.test.js test/extra-sdk-disposal.test.js` | 25 通过、1 跳过；跳过项为需 expose-gc 的堆测试，随后单独启用 |
| `node --expose-gc --test test/context-loader.test.js` | 8 项全部通过，包括一万次动态加载、超时占额和不合作回调卸载失败；本次 GC 后 retained heap 差值为 -1,634,024 bytes，不作为任意 JS 的 OOM 保证 |
| OKF / 本地链接 / diff | 以 `uv run --no-project --with pyyaml python .octospec/scripts/lint.py` 和 `git diff --check` 核对；系统及桌面附带 Python 缺少 yaml，使用临时依赖环境，不修改项目依赖 |

# 实际边界

现有 createDaemonRuntime 仍只通过 JSON descriptor 在 runner 加载 Extra。HostApp Node 组合层、invocationId 执行端口、生命周期与状态归属的 SDK 改造此前已明确延期，本轮没有实施。示例区分已可用的共享 loader 与尚不可直接调用的三参数 runtime.loadExtra 目标接口；业务方只负责业务函数，不实现第二套模型执行内核。

本轮无协议、UI 或真实接口行为变化，未发起新的线上调试，也未重启既有进程或修改 Home、身份、profile、配置。此前 im-test/真实 Codex 的动态 Context 验证仍仅按[原交付记录](2026-10-17-extra-initializer-delivery.md)解释，不作为当前 SDK 闭包接入已完成的证据。

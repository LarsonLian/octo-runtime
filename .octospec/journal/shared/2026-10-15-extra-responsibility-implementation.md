---
type: Journal
title: Extra 责任边界收敛实施与验证
description: 删除增量配置和业务 RPC，增加默认状态，记录 SDK、CLI、插件和桌面应用的验证范围。
tags: [extra, lifecycle, validation]
timestamp: 2026-10-15T06:10:00Z
---

# 实施结果

依据[责任边界决策](../../tasks/extra-responsibility-boundary/brief.md)，直接删除 `onConfigure`、`onRequest`、`configureExtra`、`requestExtra` 及相应 RPC，不保留兼容入口。Extra 保留函数入口、`signal`、`onDispose`，新增同步 `onStatus(() => JsonObject)`。未注册时返回 `{}`；框架只校验、复制和转发，不解释内部业务字段。未加载、查询失败与空状态分别处理。

SDK `loadExtra(descriptor)` 接收最新完整声明，拒绝已加载实例；宿主明确卸载后再加载。CLI `extraset` 只保存，`extra load` 重新读取文件，前台启动及显式加载展示内部状态。同名生命周期串行，清理失败阻止重新加载；成功提交的最新声明用于同账号 runner 恢复。

两个 IM 插件删除增量差异计算。停用 Bot 保留状态；错误配置项跳过连接，通过 `bots[].config_index/state/error` 和 `errors` 报告，有效 Bot 继续初始化。无效授权配置不连接。SSE 状态包含监听、活动请求数和错误；配置错误或端口占用不扩大成 Extra 加载失败。卸载继续取消请求并等待资源清理。

Work App 保留账号 SQLite 和逐 Bot 界面，改为宿主卸载对应平台 Extra、保存配置、加载完整 Bot 列表；按插件定义解释状态。账号变更加边界检查。实机排查修正 WeCom 可选 `ws_url` 被写成 `undefined` 导致声明 JSON 校验失败的问题，改为未设置时省略字段。`connectionsEnabled` 沿用当前产品语义，本轮实机为 false，IM Extra 仍可由宿主加载。

文档同步 Extra 合同、INTEGRATION、SDK、CLI 和三个插件 README；未修改 Worker，Run=7、Context=v3 不变。没有删除或重建既有身份、Home 或配置。

# 自动验证

- Runtime `pnpm test`：759 通过、7 跳过，共 766 项；包含 SDK 最新声明恢复、默认状态、状态 JSON 校验、卸载重载、插件隔离、失败清理、错误配置跳过和 SSE 端口占用。
- 最后类型修正后重新构建并重跑 Extra/渠道专项：16 项通过；Runtime 根 TypeScript 与 ESLint 通过。
- Work App 全量：195 个测试文件通过、1 个跳过；1619 项通过、1 项跳过。TypeScript 与生产构建通过。
- `prepare:runtime` 重新构建并装配桌面内置资源；重启真实 Electron 与 renderer。两仓库 `git diff --check` 通过。

期间曾因构建清理 dist 与测试交叉执行产生模块缺失，改为构建完成后验证；CDP 曾因旧端口占用未启动，清理开发进程后重启。以上失败不计为成功证据。

# im-test 实机范围

通过 CDP 驱动真实 Work App renderer，确认登录目标为 `https://im-test.deepminer.com.cn`、daemon 运行。`octo-work-app/scripts/verify-extra-plugins-live.mjs` 创建临时通道并在设置页检查实际 DOM：无效 Octo 凭据报告鉴权失败；停用 Octo 与 WeCom Bot 状态可见；修改一个平台保持另一 Extra 状态及共享 Host PID；停用、删除完成；清理临时配置，原通道 ID 列表保持，renderer 异常数为 0。

`scripts/verify-extra-sse-live.mjs` 通过相同桌面 daemon 的真实 Codex 执行端口完成 SSE Run（`e09f044b-1ae7-452b-816e-050ea844b572`，`run.completed`），校验 Bearer 拒绝、卸载端口释放及共享 Host 继续就绪。

有效 Bot 在线、真实 Octo/WeCom 消息收发、真实审批交互、跨账号/Space 的实机切换和完整安装包启动未在本轮实机验证。账号隔离、取消与重启恢复的自动测试不能代替这些外部场景验收。未向用户或群发送验证消息。

# 后续修正：App 不阻断引擎不可用的 Extra 配置

复查发现 App 的 `ImChannelService` 在生成配置前调用引擎探测，任一 Bot 的引擎不可用会抛出 `IM_CHANNEL_ADAPTER_UNAVAILABLE`，使整个 Extra 无法加载。此行为位于 App，不是 Extra 内部检查，与本次责任约定不符。

已删除该阻断和 ImChannelService 的引擎探测依赖。SQLite 仍保存原始界面数据，加载及恢复重新读取并生成完整配置，不替换用户选择的引擎；实际执行时的引擎校验继续由执行层负责。

新增回归测试先在旧代码复现失败，修复后验证两个 Bot 的完整配置均被传入加载入口，服务重开后从 SQLite 恢复仍保留引擎选择。相关 28 项测试通过；App 全量 1620 项通过、1 项跳过；生产构建与类型检查通过。

重启真实 Electron 后，通过 CDP 对着 im-test 加入指定未注册引擎的临时 Bot：该 Bot 与另一 Codex Bot 均进入插件认证并返回预期的鉴权失败，Extra 保持 loaded。设置页实际可见，修改、停用、删除及跨插件隔离检查通过，共享 Host PID 保持，renderer 异常数为 0；临时通道已删除，原通道 ID 列表保持。本次使用无效凭据，未验证真实 IM 收发，也未触发模型执行或隐式安装。

# 当前工作树提交前验证

按用户要求提交当前工作树。全量构建通过，根 TypeScript、ESLint、`git diff --check` 和 OctoSpec 检查通过。首次全量测试发现 Extra 测试仍调用已移除的 `extra load/status` CLI 命令，已改为调用 daemon 的 `extra.load/status` 接口，验证卸载后用完整声明重新加载并查询状态。CLI 配置继续只通过 `extraset/extraget` 保存和读取。

修正后 Extra 专项 13 项通过；全量重新运行共 811 项，804 项通过、7 项跳过、0 项失败。此轮提交检查未新增桌面、Worker 或真实 IM 收发验收，前文的实机验证范围保持原意。

随后工作区新增失败终态卡片投递回执及文本去重测试，已纳入当前提交范围。构建目录曾被并行构建清理，导致一次专项运行报模块不存在；完成全量构建后重新验证，全量共 812 项，805 项通过、7 项跳过、0 项失败。

---
type: Journal
title: 统一 Extra 的 SDK 与桌面接入实现和验证
description: 完成接入审查 G1–G10 的实现及文档修正，记录 im-test 实机证据和未验证路径。
tags: [integration, extra, lifecycle, verification]
timestamp: 2026-10-15T03:45:00Z
---

# 实施结果

后续用户已调整架构决策：不再要求原地增量配置和通用业务 RPC，改由宿主卸载、修改配置、重新加载，Extra 增加必备状态能力。见 [责任边界决策](../../tasks/extra-responsibility-boundary/brief.md)。本文保留当时实现及验证事实，不作为继续扩展 `onConfigure` / `onRequest` 的依据；新决策尚未实施，不能沿用本文测试结论证明新接口通过。

对应 [接入差异审查](2026-10-15-integration-plugin-gap-review.md) 和 [任务简报](../../tasks/plugin-sdk-app-integration/brief.md)。记录基于当前工作区，不代表发布版本或远端交付。

| 审查项 | 修正 |
| --- | --- |
| G1 | invoke 示例转换为统一 InvokeInput，使用第二参数传递 signal |
| G2、G3 | SDK 增加 configureExtra/loadExtra/unloadExtra/extraStatus/requestExtra；默认函数插件可登记 onConfigure/onRequest |
| G4 | 生命周期与逐 Bot 状态独立查询；loaded 不作为在线证据 |
| G5 | Octo 插件按真实认证 Space 校验 authorized_space_ids；App 传入当前授权集合，集合变化先清除旧动态声明 |
| G6 | HostApp 决定装配；Extra 管理业务连接；AdapterHost 提供执行能力 |
| G7 | 清理当前指南中的归档 Worker 操作和失效 CLI 方法，doctor 按真实检查范围说明 |
| G8 | 补充 Node 与桌面发行布局、默认入口及依赖准备，验证实际发行物 |
| G9 | 保留已有显式 Bot 启用语义，说明历史 connectionsEnabled 不充当 IM 总开关 |
| G10 | 补充稳定插件名、全量覆盖、加载失败和业务失败的观察边界 |

Octo Work 的 IM 接线已从对象模块迁到 Extra 默认入口。宿主保留账号 SQLite 和逐 Bot 编辑、停用、删除及恢复；每次提交对应插件的完整 bots 快照。插件增量更新变化项、移除缺失项，业务查询提供脱敏 status。

同名配置、加载和业务查询串行执行。卸载通知 AbortSignal 并等待处理与清理；尚未创建实例的排队加载也能取消。SDK 保留最新成功声明供同账号重启；logout/account-switch 清除动态声明，恢复构造时声明。初始声明仍由宿主选择，不从旧账号存储自动补配置。配置处理不是事务，失败不保证外部副作用回滚。

App 串行应用 IM 变更；运行代次变化后，旧请求不得把旧 Bot 回滚进新账号。仅切换当前 Space 不重启 Host；账号或授权 Space 集合变化清除动态声明后再启动，由宿主恢复当前配置。Run=7、Context=v3 未改变；未引入运行时隐式安装。

# 自动检查

- Runtime `pnpm test`：738 项，731 通过，7 跳过，0 失败。包含同账号重启保留最新声明、换账号恢复初始声明、配置更新、逐 Bot 增量、授权和卸载清理。
- Runtime `pnpm exec eslint .`：通过；修改文件的定向 ESLint 也通过。
- App `pnpm test`：195 个文件通过、1 个跳过；1616 项通过、1 项跳过。定向 IM/SDK 测试 24 项通过。
- App `pnpm build`：通过，包含 TypeScript 检查。
- `pnpm run prepare:runtime`：通过，准备 darwin-arm64 / Node 24.21.0。核对 Node、runner、manifest、adapter-host 及两个 Extra 默认入口均存在；两个发行物入口均可 import，默认导出为函数。
- `INTEGRATION.md` 全部 TypeScript 示例合并后按严格 NodeNext 合同检查：0 错误；本地 Markdown 文件链接无缺失。
- 两仓 `git diff --check` 通过。

过程中全仓构建与其他正在进行的 OpenClaw 修改短暂交叉，出现缺失 import/依赖；依赖就绪后发行物构建通过。App 测试与其他 Runtime clean/build 交叉时出现 dist 入口暂时不存在，等待构建结束后重新跑完整测试通过。不将这些中间失败当作最终通过证据。

# 实机验证

按仓库约定关闭旧 Electron 与 electron-vite，重新启动 Work App dev。通过 9222 CDP 驱动实际 renderer，确认宿主登录且 server 为 `https://im-test.deepminer.com.cn`，运行 daemon PID 为 3262。

`octo-work-app/scripts/verify-extra-plugins-live.mjs` 验证：

- 经 renderer bridge 保存和编辑临时 Octo Bot，使用刻意无效凭据访问测试服务，不发送 IM 消息。
- Extra 默认入口加载成功；对象 modules 中无同名 channel-gateway；真实鉴权失败在逐 Bot 状态中可见。
- 编辑配置期间 daemon PID 不变；停用显示 stopped；删除后配置恢复原状，本地 Host 仍就绪。
- 验证期间 renderer 无未捕获异常。原账号未保存 IM 通道；临时配置已删除。

`octo-runtime/scripts/verify-extra-sse-live.mjs` 使用同一真实桌面 daemon 和真实 Codex Provider，验证 Bearer 拒绝、请求完成终态、正确回答、卸载关闭监听端口及共享 Host 保持可用。最后验证 Run ID 为 `2c2c37fb-4de2-4c2a-9d1d-2721cde15394`，终态为 run.completed。

# 未验证路径

没有可用的现有 Bot 凭据，因此未验证 Octo Bot 成功鉴权、WS 在线和真实 IM 收发，也未验证企业微信外部服务。两种插件的配置增量、清理和授权边界由自动测试覆盖；这些测试不替代外部连接证据。未生成完整安装包，已验证正式发行资源准备与入口加载；未提交、推送或发布。

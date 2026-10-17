---
type: Journal
title: 群准入合同修复与 CLI、SDK 实时验证
description: 启停与范围分离，省略、null、空群名单统一不限制范围，记录真实测试环境收发和发行边界。
tags: [channel, identity, testing, incident]
timestamp: 2026-10-17T00:00:00Z
---

# 合同与实现

用户在[事故调查](2026-10-17-channel-group-admission-incident.md)后确认修正原语，不做兼容，更新整体设计并实施、提交推送和本地安装。当前准入合同由[处理计划](../../tasks/channel-group-admission/plan.md)与[渠道规则](../../rules/channel-integration.md#本轮输入)定义：groups_enabled 省略或 true 开启群/话题，false 禁用；group_ids 省略、null、[] 不增加范围限制，非空名单校验父群；两个字段都不影响私聊。

修改限制在 Gateway 的配置类型、运行时校验、Schema 和共享准入函数。默认 owner、显式发送者授权、自身、Space、消息有效性和真实 mention 继续校验。发送者名单省略的错误文案已改为仅 owner，[] 仍拒绝所有发送者；不把群范围默认机械推广到身份授权。核心注释引用本专项，整体架构、CLI/SDK 指南、包 README 与 mention 方案已对齐。没有修改 Context/Run 版本、Host/Provider 执行逻辑、第三方 App 或用户配置。

# 验证证据

- 修复前：原有 2 项 mention 测试通过，新增 3 项回归失败；im-test 真实历史重放复现省略群名单被拒绝，显式群通过。保留[历史分析](../../tasks/channel-group-admission/analysis.md)，不把旧 [] 行为作为现行合同。
- 修复后：准入、transport 与配置测试共 11 项通过，包含新旧测试；运行时与公开 JSON Schema 的有效/非法值一致。groups_enabled × group_ids × 群/话题/私聊矩阵及原地址回复通过。
- pnpm typecheck、pnpm lint、pnpm test 通过；Node 1083 项中 1074 通过、9 跳过，WebUI 35 项通过。OKF lint 和 git diff --check 通过。
- [只读真实报文验证](../../../scripts/verify-channel-group-admission-live.mjs)：im-test 既有 QA 群历史重放，默认/null/[]/命中允许，false/名单外/未授权/无 @/错 Space 拒绝；不发送消息、不调用模型。
- [真实入口验证](../../../scripts/verify-channel-group-entrypoints-live.mjs)：只使用 im-test 两个受保护 QA Bot、既有 Channel_QA_ 群和 Channel_QA_topic；分别通过 Runtime CLI daemon run 与 SDK 三参数 loadExtra 连接真实 WS，执行仍走独立 AdapterHost。CLI 默认群及话题均执行并原频道回复，无 @ 不执行；SDK 同时验证 null、[]、显式名单、禁用、名单外和空发送者名单。共发送 12 条测试输入，得到 7 次确定性测试执行和原地址回复；SDK async loadContexts 调用 5 次。禁用/名单外/未授权的每个负例观察 1 秒无执行，完整拒绝语义另有自动化断言。

线上输入来自明确授权的 QA Bot，不是真人 owner；默认 owner 由 transport 自动化验证。执行使用[确定性测试 Adapter](../../../test/fixtures/channel-admission-host.js)，实际 WS、daemon/SDK、IPC、Host 和消息投递均真实，但模型调用为 0，不宣称真实模型或第三方 App 已验收。测试 Home 位于脚本新建的 /tmp 目录，结束后所属进程和临时数据均清理；不改变既有 Home、身份或配置，不输出凭据、正文或完整 Context。

# 发行和恢复边界

代码提交 dc73c28 已推送 origin/feat/open-source-github，未创建 MR。对该提交运行 pnpm pack:release 和隔离 verify-release 已通过：离线安装、公开类型、三个内置 Extra 和外部 Extra 加载、daemon ready，以及卸载保留 Home 均验证成功。通过 npm 全局安装该 tgz 后，版本为 1.0.0、commit:dc73c28a34a8，无 dirty 标记；直接检查已安装 Gateway 的默认/null/[]/显式名单和禁用语义通过。后续文档提交不改变执行代码，最终本地构建号以交付回执为准。没有 npm publish、隐式安装 Provider 或注册系统服务。

发现本机已由用户运行前台 daemon，系统服务仍为 not_installed，活动任务为 0。全局替换不会刷新其内存中的旧模块；保留原前台终端的运行控制，不把它转成后台服务。用户在原终端 Ctrl+C 后执行 octo-runtime daemon run 即可加载新产物，无需重建 Home 或改群名单。SDK 宿主另按自身生命周期更新。

本机现有 CLI Bot 省略 group_ids，按新合同无需改配置；已经运行的旧 daemon 必须重新加载新发行物才会生效。全局安装不更新 Buddy、demo 等第三方宿主自身携带的 SDK 副本，需对应团队更新构建并重启。实际产品恢复、影响部署总数及真人 owner/实际模型闭环仍未核实，因此本专项记录为本地修复已验证，不宣布全部事故关闭。被过滤的历史消息不自动补执行，升级后需要明确重新发送。

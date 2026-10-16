---
type: Journal
title: 配置来源归宿主与 Channel 凭据文件清理
description: 固化配置责任边界，记录凭据文件字段删除与验证结果。
tags: [architecture, extra, configuration, testing]
timestamp: 2026-10-16T00:00:00Z
---

# 决定与实现

用户明确 bf_token_file 属于过度设计：宿主从 JSON、SQLite、Nacos 等来源取得配置并拼装对象；SDK 消费实际值，不管理来源。已写入[基础架构](../../rules/architecture.md#配置来源归宿主sdk-消费配置值)和[Extra 规则](../../rules/extras.md)，作为后续配置设计与评审的通用要求。

两个 Channel 的 bf_token_file / app_secret_file 已从公开 TypeScript 合同、schema、示例与插件取值逻辑删除。插件仅使用宿主传入的 bf_token / app_secret；删除凭据文件检查、读取和来源冲突逻辑，保留实际值类型检查和认证。Gateway 继续按原有合同忽略未知可选字段；WeCom 继续拒绝未知 Bot 字段，不为本次删除新增特殊兼容逻辑。

新增回归验证：给出真实临时凭据文件路径时，SDK 不读取该文件；宿主自行读取并传值后，两插件均取得正确凭据。OpenClaw CLI 环境同步样例改为宿主先解析来源再传入 Bot 配置。CLI 本身的配置读取，以及真实工作目录、会话状态路径和 Runtime 内部存储仍按各自合同处理。

后续新增字段需判断其是否是消费者实际需要的业务值；不得以多来源支持为由添加文件、环境变量或配置中心取值字段。宿主更换配置来源时，SDK 输入合同应无需改变。没有改写现有配置、重置 Runtime 或接管已有 Bot 连接；原文件字段的使用者应由宿主迁移为直接传值。

# 验证

- pnpm test：构建通过，Node 1018 通过、8 跳过、0 失败；WebUI 35 通过。
- pnpm exec tsc -p tsconfig.json --noEmit 与 pnpm lint 通过。
- node scripts/pack-release.mjs 成功；逐一读取 tgz 中三个公开及三个内部 schema，与源码一致、示例独立编译通过，无凭据文件字段或 $ref。两个 Channel 的发行类型无文件字段，凭据取值模块无 fs 读取。
- 只读线上测试：仅 https://im-test.deepminer.com.cn/api，由宿主脚本从受保护测试账号来源拼装 Bot JSON，再经 configuredCredential / verifyBotIdentity 校验；两个账号身份匹配，无效凭据返回 IM_AUTH_HTTP_401。未建立 WS、发送消息或调用模型，不能视为本轮完成 WeCom 实际建联或完整消息执行验收。
- git diff --check 通过。未提交、推送或发布。

本记录补充[最初的 schema 交付](2026-10-16-extra-config-schemas.md)：先前“运行逻辑未变”只描述该次 schema 工作；本次按用户最新决定实际删除凭据文件读取。任务边界见[brief](../../tasks/host-config-source-boundary/brief.md)。

# 后续清理：不考虑旧配置兼容

用户进一步明确：相关读取解析代码也需删除，不考虑旧配置文件兼容。再次检查后，删除两个旧 lifecycle/file-config.ts 模块，将仍需使用的 Bot 列表校验及实际凭据值处理并入现有 configuration.ts；更新 Extra、公开导出及测试引用，不保留旧路径转发。WeCom 中仅服务于旧凭据文件的两个权限错误码分支一并删除。

源码 packages/apps/scripts/public 中已无旧文件字段、来源冲突/文件权限错误码和 file-config 引用。SDK 按宿主传入值工作，CLI 自有配置文件读取仍属 CLI 宿主职责，不因此删除真实工作目录或内部状态读写。

重新运行 pnpm test，Node 1018 通过、8 跳过，WebUI 35 通过；类型和 lint 通过。重建发行包后检查确认旧 file-config 模块不存在，六份 schema 一致，两个插件的入口、类型、配置及连接实现无旧凭据代码。im-test 两测试账号只读认证匹配、无效凭据仍返回 401；没有建立 WS 或发送消息。

## F30 补充：两类宿主与凭据保护归属（仅文档）

术语限定：本节“官方 CLI”专指 Runtime CLI（`octo-runtime` 可执行程序，通过 `npm install -g @mininglamp-oss/octo-runtime` 安装），不指 Agent 调用的业务工具 `octo-cli`。包名按本仓 package.json 核对，npm scope 为 `@mininglamp-oss`。

用户进一步确认接入主次：SDK 是主要接入方式，Buddy 等宿主产品由其他团队维护；官方 CLI 是 Runtime 团队基于 SDK 提供的开箱即用特殊 headless 宿主。本文列举 CLI 和 Desktop 说明责任，不将宿主封闭为两种形态，也不以 CLI 为架构中心。各宿主团队负责自己的产品策略、认证、配置和凭据保护；Runtime 团队维护通用 SDK 与执行合同，另以 CLI 维护方身份承担 CLI 的宿主责任。

CLI 负责自己的目录和 JSON 配置文件，当前 Extra 声明保存于 `<Runtime Home>/extras/<name>/config.json`。其他 SDK HostApp 的 Token 获取、登录授权流程、认证状态、存储、访问保护、更新及撤销由对应宿主团队负责，宿主准备好值后构造 Extra config JSON。官方维护、同仓发行或开箱即用均不使 CLI 的产品约定成为通用 SDK 合同。

Extra 接收的是 config: JsonObject，不拥有宿主配置来源，也不接管宿主凭据库。宿主从文件换到数据库或系统凭据存储时，SDK/Extra 的值对象合同保持不变。CLI 的文件约定不能成为桌面原生接入条件；CLI 与通用 SDK/执行内核即使同仓发行，责任也不合并。

这样设计让宿主复用自身认证和存储机制，避免 Token 复制到另一套 Gateway 文件、插件感知宿主内部结构，以及多套凭据更新流程。旧设计的目录保护措施有其适用背景，但不能因旧仓存在就把对应存储体系下沉到通用 Runtime。后续评审先确定配置来源的宿主，再决定具体存储措施，不把宿主安全核查项记作 Runtime 功能缺口。

SDK/Extra 继续校验配置并按真实接入合同完成认证，工具/服务端继续检查资源 ACL；框架自身的内部状态、IPC、身份和租约保护仍归框架。上述分工不改变 OpenClaw 既有实例环境写入合同，不删除或重建任何配置、Home 和身份。

F30 按该职责目标覆盖 100%、标删除线，新增必要性 0、方案可执行性 100。撤销此前以宿主路径/Windows ACL 证据不完整为由给 Runtime 保留方案扣至 90 分的评价；不表示任意宿主存储已完成安全验收。现行责任表见[架构规则](../../rules/architecture.md#配置来源归宿主sdk-消费配置值)，完整状态见[F30](../../tasks/gateway-august-feature-assessment/assessment.md#逐项-reviewf30-本地文件保护与旧-gateway-目录体系)。

本节仅补充架构文档。上文测试和 im-test 结果属于此前实现记录，本轮只核对 Extra JSON 入口、凭据值消费及 CLI 配置保存代码，没有重新运行功能测试、认证或线上调试。

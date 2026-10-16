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

---
type: Journal
title: 三个 Extra 原始配置 Schema 交付
description: 完整字段合同、业务方自主校验、单一发行包与仓库外安装验证。
tags: [extra, schema, testing]
timestamp: 2026-10-16T00:00:00Z
---

# 合同与交付

按[任务](../../tasks/extra-config-schemas/brief.md)为 Octo IM、企业微信、本地 WebUI 新增独立的 `config-schema.json`。覆盖完整 `{ module, enabled?, config }`，module 固定包名，描述用途、必填条件、省略行为、凭据来源、OpenClaw 目标 Agent 与时限差异。模型 ID 保持字符串，由业务方决定；不增加统一编译器、Zod 依赖、强制加载校验或默认值写入。三个 load 入口及运行逻辑未变。

初次实现曾在 Channel schema 内嵌 Context v3 及其 25 个传递定义。用户后续明确此处不需要详细协议，因此已删除全部内嵌 Context 定义，也不增加共享 schema 的外部引用。当前可选 context 只声明固定的 `schema: octo.context-envelope/v3` 和 `items` 对象数组，item 允许任意 JSON 对象，说明配置项在 IM Channel 执行 AgentRun 时固定附带。item 内部必须遵循整个 octo-runtime 的 Context v3，现有运行时协议校验保持不变；轻量配置 schema 不负责证明内部协议合法。

各 workspace 包提供 `/config-schema.json`，单一公开发行包提供 `/extras/{channel-gateway,channel-wecom,webui}/config-schema.json`。打包器原样携带公开文件与内置依赖中的 schema，发布说明记录公开入口。示例凭据均为占位值。

核对实现发现 WeCom 的 authorized_space_ids 仅被格式校验并形成回调，企业微信连接没有解析与核对 Octo Space 身份。schema 和字段表明确其不构成企业微信 Space 准入；Octo Gateway 的同名字段实际核对 octo-auth Space。本次只澄清已有行为，没有增加或放宽授权逻辑。

# 首次交付验证

- `pnpm test`：workspace 构建通过；WebUI Vitest 35 通过；Node 测试 1017 通过、8 跳过、0 失败，其中新增 schema 回归 16 项。
- `pnpm exec tsc -p tsconfig.json --noEmit`、`pnpm lint` 通过。首次 lint 与 clean/build 并行导致生成包类型暂时缺失；构建完成后独立重跑通过，没有修改无关业务代码。
- `node --test test/extra-config-schemas.test.js`：最终定向回归 16 通过，包括完整/最小示例、不自动填值、字段说明、必填、条件约束、时限、Bot 数量、Token 结构、Context v3 及协议定义快照。
- `node scripts/pack-release.mjs`：生成 `dist/release/mininglamp-oss-octo-runtime-1.0.0.tgz`，未发布。
- 仓库外临时目录以 npm `--offline --ignore-scripts` 安装上述 tgz；三个公开入口与三个内置依赖入口共六份 schema 均与源文件一致，安装后的 schema 可独立编译且全部占位示例通过；临时目录已清理。检查脚本起初使用 require 条件解析 import-only 的 `/extra` 入口失败，改为从 JSON 公开入口解析后通过，未修改原 ESM 导出合同。

# Context 收敛后验证

- `node --test test/extra-config-schemas.test.js`：16 通过。替换协议快照用例，确认 context 非必填、只声明 schema/items、items 接受任意对象并拒绝非对象，以及具体 v3 内容仍由现有插件校验。
- 重新运行 `node scripts/pack-release.mjs`，验证 tgz 中两个公开与两个内置 Channel schema 均与源文件一致，无 ContextEnvelope 定义，items 为开放对象。Gateway schema 当前为 377 行，WeCom 为 251 行。
- 同步字段说明、指南、发行说明及任务规则。本次收敛只涉及原始 schema、测试及说明，未再次运行全量构建或全量测试；首次交付检查结果见上节。`git diff --check` 通过。

本次仅新增声明性资源、导出及打包，不修改接口、Context/Run 协议、UI 或执行行为；未启动真实模型调用、未做线上接口联调、未重启既有进程、未修改 Runtime Home、身份、profile 或配置。线上调试仍须使用 im-test，本记录不构成线上建联验收。尚未提交或推送。

# 字段直接内联

用户进一步要求不使用 `$ref: #/definitions/OctoBotConfig` 等过度拆分。已将 Bot、Adapter 和 Codex 重试字段直接内联到实际配置层级，删除 definitions，合并并保留原字段说明，不改变字段约束。WebUI 原本已是直接内联结构。

`node --test test/extra-config-schemas.test.js` 16 通过，字段说明检查改为按实际 properties/items 层级遍历，并验证三份 schema 都没有 `$ref`、definitions。重新打包后核对 tgz 的三个公开与三个内置 schema 与源码一致，无引用，全部示例可独立编译验证；`git diff --check` 通过。本次仅修改 schema 组织、测试和说明，未再次运行全量构建或测试。

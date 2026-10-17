---
type: Task
title: 三个 Extra 的原始配置 Schema
description: 公开完整声明约束和字段语义，保持业务方自行构造和校验配置。
tags: [extra, schema]
timestamp: 2026-10-16T00:00:00Z
---

# 目标与边界

用户要求企业微信、Octo IM、本地 WebUI 三个 Extra 随包提供完整 `config-schema.json`，包含外层 module 固定值、enabled、config、全部嵌套字段、必填条件与明确 description。尤其说明 provider_agent_id 的实际身份、适用引擎、默认目标和不创建 Agent 的边界。

决定权属于具体业务方：业务方选择配置来源、模型、执行参数和校验工具。框架仅提供原始 schema 和发行入口，不添加统一编译器、不强制 Zod、不改变 JsonObject 加载入口，不因 schema 自动填值、转换配置或发起连接。不更改 Run=7、Context=v3、Provider 安装或 Runtime 身份与存储。绝对路径 SDK 装配仍有效，本 schema 的固定 module 约束用于包名声明。

实施包括三份原始 draft-07 schema、workspace 与单一发行包 JSON 导出、打包携带、说明文档及正反例回归。按用户最新澄清，context 可选，仅声明固定 v3 标识和 items 对象数组，说明执行 AgentRun 时固定附带，不展开 item 内部字段，不嵌入或引用完整协议 schema。非 schema 能表达的文件权限、身份、资源可用性、跨字段动态比较等约束在说明中标明，由既有运行时边界处理。

# 验收

- 三个完整声明的占位示例及最小声明可编译校验；必填、错误 module、字段类型、OpenClaw 条件、凭据冲突、时限和 Bot 上限有反例。
- 两个 Channel 的 context 仅保留 v3 外壳与开放对象数组，无完整协议定义或外部引用；关键配置字段有用途和条件说明，具体 Context 校验继续由运行时承担。
- 原始 schema 随包交付，仓库外安装发行物后可从公开入口读取，引用完整。
- 运行按范围的构建、类型、lint 和回归；本次不修改接口、UI、执行或协议行为，不触发真实模型调用和现有进程重启。涉及真实接口调试时仍只连接 im-test。

# 结果

已完成。构建、类型、lint、1017 项 Node 测试及 35 项 WebUI 测试通过；仓库外离线安装发行包后，三个公开与三个内置 schema 入口、源文件一致性和独立编译示例验证通过。运行逻辑、协议及既有配置未变；未提交、推送或发布，未做线上接口联调。详见[交付记录](../../journal/shared/2026-10-16-extra-config-schemas.md)。

用户后续要求简化 context，已去掉完整协议展开，只保留固定 v3 标识和开放的 items 对象数组。收敛后 16 项定向测试、重新打包及公开/内置文件一致性检查通过；不改变现有运行时 Context 校验。本段替代初次实现的内嵌协议方案。

用户进一步要求避免 `$ref` 过度拆分：三个配置 schema 直接内联 Bot、Adapter 和重试字段，不保留 definitions；保持现有字段说明和约束。

后续配置责任纠偏见[配置来源任务](../host-config-source-boundary/brief.md)：凭据来源归宿主，已删除 bf_token_file / app_secret_file 及对应实际读取逻辑。上文运行逻辑不变仅描述最初 schema 交付，不代表后续清理没有代码改动。

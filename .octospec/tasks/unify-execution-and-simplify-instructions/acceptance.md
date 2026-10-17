---
type: Task
title: 统一执行与系统指令改造验收清单
description: 协议、执行入口、Provider 会话及渠道失败展示的待实施验证要求。
tags: [invoke, context, protocol, testing]
---

# 验收清单

状态：全部功能项待实施、待验收。目标与责任边界见[任务简报](brief.md)。实施后逐项记录命令、版本、输入条件、结果和限制；不能仅将本表全部勾选而省略证据。

## 协议与配置

- [ ] `{ text: "A" }` 合法；两个条目得到精确的 `"A\nB"`，不保留原来的双换行分隔。
- [ ] 原顺序、重复条目、文本首尾空白和内嵌换行保持不变；无 instructions 和空列表得到空字符串。
- [ ] `source`、未知字段、缺失 text、非字符串和空字符串均按目标合同拒绝；所有旧 source 枚举及分支删除。
- [ ] JSON Schema、运行时校验和生成类型一致；持久配置 Schema、配置构造、文档样例及快照不残留旧条目结构。
- [ ] mandatory 继续强制覆盖；defaults 层的既有指令限制与实际写入授权保持有效。删除来源分类不扩大权限。
- [ ] Context 数量及 UTF-8 预算边界有效；接近预算的长系统指令不会被当作未知执行项拒绝。
- [ ] `controlInstructions` 的显式覆盖与 Context 派生优先级在所有入口一致，包括显式空字符串。

## 共享执行准备

- [ ] 静态核对 Octo / WeCom Extra 不再调用 `resolveLocalContext()`，不构造内部 `InvokeRequest`，不进行 request-to-input 往返转换。
- [ ] 含系统指令、普通业务 Context 和执行 Context 的公开输入能够到达 Host；执行 resolver 只接收执行与审批配置，完整 Context 仍交给统一渲染。
- [ ] 通过真实调用链或有代表性的集成测试，确认每次调用只发生一次执行准备；不能仅测试删除后的 helper 名称。
- [ ] 分别覆盖直接 Host、Host RPC、daemon SDK、`agent_run.invoke`、CLI daemon Extra 与 WebUI；相同公开输入得到相同指令语义和执行解析结果。
- [ ] CLI 与 SDK 使用同一构建版本和等价输入复测用户问题；记录原先差异是否来自版本、配置或 Context 内容，不预先认定某一路正确。
- [ ] Octo / WeCom 的原有默认值、固定 workdir、adapter 选择、环境注入、自动材料预算处理、取消和重试行为无回归。
- [ ] 重试快照、session generation、provider epoch、Provider binding 与迟到事件隔离继续有效；准备失败不触发执行重跑。
- [ ] 未知可选 Context 沿既有协议处理，必需项和非法执行项继续拒绝，不以统一执行为由放宽校验。

## 全部 Adapter

每个具体 Adapter 都记录新会话、续聊和适用的既有 fresh fallback 结果。共享 ACP 测试之外，还需核对各具体 Adapter 的调用参数映射。

| Adapter | 新会话指令映射 | 续聊不重复注入 | 既有 fresh fallback |
| --- | --- | --- | --- |
| Codex | 待验 | 待验 | 待核对适用分支 |
| Claude Code | 待验 | 待验 | 待核对适用分支 |
| CodeBuddy | 待验 | 待验 | 待核对适用分支 |
| Hermes | 待验 | 待验 | 待核对适用分支 |
| Kimi Code | 待验 | 待验 | 待核对适用分支 |
| MCode | 待验 | 待验 | 待核对适用分支 |
| OpenCode | 待验 | 待验 | 待核对适用分支 |
| OpenClaw | 待验 | 待验 | 待核对适用分支 |
| Qoder CLI | 待验 | 待验 | 待核对适用分支 |
| Qoder CLI CN | 待验 | 待验 | 待核对适用分支 |
| ZCode GUI | 待验 | 待验 | 待核对适用分支 |
| Antigravity | 待验 | 待验 | 待核对适用分支 |

- [ ] 使用预算内的长指令连续调用两轮，观察 Provider 原生请求；第二轮不再次发送整份 system，也不把它转成用户正文。
- [ ] 续聊中的普通本轮 Context 仍能生效；修改系统指令后只有显式新建或 reset 才按新指令初始化。
- [ ] 已有 fresh fallback 使用本次调用显式冻结的指令初始化新 Provider 会话，不回填历史指令。
- [ ] 缺少 Provider 安装、认证或可测入口时，明确记录待验原因；不将 mock 映射通过写成真实 Provider 已通过。

## 失败展示

- [ ] 逐项覆盖 instructions、Runtime selection、workspace 冲突、重复 Context、预算超限、规则读取失败和快照保存失败；合法输入统一执行，非法输入保留各自安全原因，不全部改写成同一句不可定位的文案。隔离复现结果见[同类排查](../../journal/shared/2026-10-16-im-invoke-preparation-lessons.md#同类错误的补充排查)。
- [ ] 注入非法 Context、无效执行配置或会话准备错误，显示正确阶段和安全原因，并确认没有 Provider 启动或工具副作用。
- [ ] Octo 显示标准错误卡片及普通文本；分别模拟卡片和文本投递失败，另一路仍执行，不递归发送错误卡片。
- [ ] WeCom 使用现有平台失败展示及文本行为；不会因缺少 Octo 卡片格式而吞掉错误。
- [ ] IM 连接保持在线时，准备失败后绿点仍表示在线，任务错误单独展示；不把单轮失败写入连接故障状态。
- [ ] Host 拒绝、Provider 失败和执行结果未知与“尚未发起执行”区分，取消和投递失败保留现有含义。
- [ ] 实际未注册 Adapter 等明确 Host 拒绝不得被统一流 catch 改写为结果未知；真实断流缺少执行结论时仍保留结果未知。
- [ ] 会话存储读取失败不得静默无回复；展示初始化失败不得阻止独立文本回执或被误报为 Provider 已执行后结果未知。
- [ ] WeCom 的任务诊断不写入连接 error；单轮失败后连接状态仍按实际传输连接报告。
- [ ] 卡片、文本及诊断均不泄露 Token、原始错误对象、完整 Context 或系统提示词。

## 工程与真实验证

实施后运行 `pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm lint:names`、`pnpm test` 及 `.octospec/scripts/lint.py`。按失败归属修复或记录既有失败，不把无关并行改动合并成本任务成果。

Runtime 仓内真实 IM 验证按本仓规则使用线上测试环境。Work App 的后续联调按该仓用户决定使用 `https://im.deepminer.com.cn/`，开发及构建显式 `--mode prod`。记录实际环境、Runtime 提交和 submodule 提交；实施并构建后完整重启受影响进程，确认加载最新产物。真实发送仅在对应任务授权范围内进行。

已知消费者必须切换到新结构，并完成构建、实际配置加载与调用验证。不提供旧 source 兼容，不重置身份、Home、profile 或数据来绕开失败。

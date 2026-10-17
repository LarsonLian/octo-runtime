---
type: Journal
title: Plan 与用户提问探索及应用层私有配置撤回
description: 记录 Codex 问答实测边界、撤回的 Provider 配置接线和后续 OKF 计划。
tags: [adapter, interaction, testing]
timestamp: 2026-10-16T00:00:00Z
---

# Plan 与用户提问探索记录

后续纠偏：下文记录当时实验与检查。2026-10-16 用户进一步明确，模式默认、继承和会话策略属于产品；撤回计划中 Runtime 每轮强制恢复 default 等建议。当前边界以[产品意图归属决定](2026-10-16-product-intent-ownership.md)及修订后的探索计划为准，不能从本历史记录推导通用模式策略。

用户确认默认使用 Default，Plan 必须显式指定；调研范围只包含已有 adapters。应用层不应针对 Codex、Claude Code 分支设置 Provider 专属开关，具体 Provider 映射由 adapter 承担。统一启用策略尚待探索，不默认开启实验能力。

已建立 [探索计划](../../tasks/adapter-plan-interaction-exploration/brief.md)，包含 12 个 adapter 和共享 ACP 桥的初始矩阵、四阶段检查和真机用例。本轮没有实施统一 Plan 模式接口。

## 实验与撤回

Codex CLI 0.154.0 的 Default 用户提问开关默认关闭。实验期间临时从 Work App 传入 defaultModeRequestUserInput，再映射 thread 配置 features.default_mode_request_user_input；真实 renderer 经 Runtime 产生问题，选项改选、补充文字和仅填写自由答案均回到原 Run，最终 completed，user 消息仍为一条。详细 ID、截图和测试脚本见相邻 Work App 的 `docs/validation/codex-questions-live/README.md`。

用户指出应用层泄漏后，已完整移除本轮添加的宿主分支、adapter 配置映射和对应测试。Codex adapter 源码、其 README 及原测试文件均无本轮剩余差异。未修改 Provider 全局配置，也未切换 Plan。

Work App 保留通用 question 展示、结构化 answered/cancelled 回传、多问题表单、改选及补充文本支持。恢复 Provider 默认后，不能将临时开关下的截图当作最终架构已完整跑通的证据。后续必须按探索计划完成统一策略和正式验收。

## 检查

- 撤回前曾运行 Runtime typecheck、lint 和 Codex 专项测试；其中 3 项新增开关测试已随接线撤回，不计入最终测试能力。
- 撤回后重新构建 Codex adapter，构建通过；Runtime 无新增功能代码残留。
- Work App 最终全量测试：194 个测试文件通过，1 个跳过；1624 项通过，1 项跳过。
- Work App `pnpm build:test` 通过，含 `tsc --noEmit`；工具有既有 Vite configLoader 提示，不宣称无所有告警。
- UI detector 返回空问题列表；真实截图只覆盖当前桌面窗口与当前主题，未覆盖全主题/窄窗。
- OKF 校验通过：127 个知识单元、20 条规则、889 个本地链接。

没有修改 Run/Context schema，没有部署 Worker，没有迁移或重建数据库。真实问答实验、源码检查、自动化回归与尚未执行的跨 Adapter 体验在此分别记录。

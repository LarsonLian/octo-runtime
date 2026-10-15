---
type: Journal
title: 未消费计划字段删除与验证
description: 两个占位字段的删除范围、跨包检查及真实执行证据。
tags: [protocol, testing, integration]
timestamp: 2026-10-15T00:00:00Z
---

# 实施

按[任务](../../tasks/remove-unused-plan-fields/brief.md)删除 `required_execution_features`、`provider_compatibility` 的 schema 定义、生成类型和校验逻辑。完整有效计划样例移除它们；两条删除回归样例验证 schema 与运行时均以未知字段拒绝。Unicode 回归改用仍存在的 model 字段。版本保持 Run=7、Context=v3、Adapter transport=2。

场景白名单、渠道快照和执行参数的真实用途见[调用链澄清](2026-10-15-protocol-simplification-review.md)，本次未改这三项代码。

## 自动检查

- Runtime `pnpm typecheck` 通过（包含所有包构建）。
- Runtime 全量 Node 测试 777 项：770 通过、7 跳过、0 失败。
- Worker `make build`、桌面 `pnpm build` 通过。
- 本次修改的协议校验文件 ESLint 通过。全仓 lint 失败于当前工作区 Channel gateway / WeCom 的 7 个错误（no-unsafe-return、no-floating-promises），不在本次删除范围内。

## 实机验证

重新启动 Work App 及内置 daemon，CDP 9222 可用。`scripts/verify-extra-sse-live.mjs` 读取真实桌面 renderer，确认测试环境 `https://im-test.deepminer.com.cn`、已登录和 daemon running，新 daemon PID 94165。

通过临时 SSE Extra → 真实桌面 daemon IPC → Host → Codex 执行 Run `26515009-41ad-4bb0-91b9-eb5054b061da`，真实终态 run.completed。未授权请求拒绝，卸载后端口关闭，共享 Host 保持 ready。connectionsEnabled=false，不能据此声称完成远程 Worker 注册。

Worker 当前源码已构建，服务重启验收仍受前次记录的迁移账本冲突阻塞；运行服务为先前保留的旧基线，未修改账本或重建数据库。未重置既有 Home、身份、profile 或 Provider 状态。

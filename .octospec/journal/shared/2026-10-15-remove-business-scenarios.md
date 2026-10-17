---
type: Journal
title: 通用协议业务场景删除验收
description: 删除场景合同与导出，验证统一 Context 执行和业务接入边界。
tags: [protocol, context, testing]
timestamp: 2026-10-15T00:00:00Z
---

# 实施范围

按[任务](../../tasks/remove-business-scenarios/brief.md)删除协议包 scenario.ts、业务场景常量、builder 白名单、assertScenarioRequest、ScenarioRequest schema、生成类型和 Node/browser 导出。删除专用于旧场景合同的测试，保留统一 Context、执行参数一致性和 Host 渲染测试。

Work App 是用户指定的测试程序，本次不调整其旧类型或校验器导入，不为它保留兼容协议。Channel Gateway Extra 是业务接入层，没有依赖此次删除的白名单；本次未改其业务处理。业务边界写入[Context 扩展规则](../../rules/context-extensions.md)。

## 验证

- `pnpm typecheck` 通过，包含 Runtime 所有包及应用构建。
- 全量 Node 测试 781 项：774 通过、7 跳过、0 失败。
- 本次修改的协议 index.ts / browser.ts ESLint 通过。
- 源码检索确认 packages、apps 和 test 不再包含已删除的业务场景合同或白名单；运行时检查 Node/browser 导出、schema 和 dist，确认旧场景入口与 dist/scenario.js 均不存在。
- `scripts/verify-playboard-live.mjs` 连接 `https://im-test.deepminer.com.cn/` 并确认 HTTP 200；以新构建分别启动临时 daemon/Host 调用真实 Codex 和 OpenClaw，两者均返回 run.completed、预期文本和 exitCode=0，输出分别为 18 / 28 帧。临时进程结束后按脚本清理独立目录，未重置既有身份或 Home。

此实测证明统一执行入口不需要场景合同，不证明远程 Worker 注册。按用户要求，本次未构建或修改 Work App；没有重启 Worker，也不宣称已完成 Worker 新版服务验收。Run=7、Context=v3、Adapter transport=2 保持不变。

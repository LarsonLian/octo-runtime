---
type: Journal
title: F4 删除 Codex computer-use 标签专用探测
description: 删除配置扫描、同步异步 helper 及专用依赖，记录回归、真实 Codex 与 im-test 只读验证及动态 MCP 遗留问题。
tags: [adapter, testing, ownership]
timestamp: 2026-10-16T00:00:00Z
---

# 范围与实现

按用户“每次一个 Feature，修复完直接 commit”的要求，先实施[清理计划](../../tasks/remove-execution-features/brief.md)的 F4。基线为 `ce9df82`。这项探测只生产标签，无执行消费者，可以先于最终字段删除单独交付。

- 删除 Codex 创建时读取 `config.toml` 并声明 `tool.computer_use` 的逻辑，同步删除 `detectComputerUseProvisioning` / `detectComputerUseProvisioningSync`、解析类型和标签常量。
- 删除专用 `smol-toml` 依赖及 lockfile 项，更新 Codex README。生产代码不再引用上述符号。
- 已复核本仓源码、公共导出、Work App 和 Worker，无上述 helper 的外部引用。geely 独立副本不在本次范围。Codex 包是 private，本次没有新增公开入口。
- 真实 `CODEX_HOME`、原生 MCP 加载及请求映射、审批和取消实现未调整。不修改既有身份、Home、profile、认证或运行状态，不发布服务。

`executionFeatures` 其余字段、数组、发现及 Host 判断仍在，待其他 Feature 逐项清理；本次不能记为整个能力机制已删除。

## 验证

| 检查 | 结果与边界 |
| --- | --- |
| `pnpm typecheck` | 通过，包含全仓 build |
| `pnpm lint` / `pnpm lint:names` | 通过；首次 lint 与 pnpm 自动 prepare 重建重叠，构建结束后重跑通过 |
| import/创建回归 | 独立子进程拦截目标配置读取；启用配置、缺失、拒绝读取三种响应均不触发读取，也不生成标签 |
| Adapter/MCP 针对性回归 | 62 项通过，包含真实 Home 路径、请求映射与配置不改写断言 |
| 全量回归 | 938 项，930 通过、8 跳过、0 失败，约 34 秒 |
| 原生 Codex HTTP MCP | `OCTO_RUN_MCP_LIVE=1 node --test --test-name-pattern='native Codex' test/context-mcp-live.test.js` 通过；临时 Home 中真实 app-server 发现并认证本机 MCP，配置不改写，无模型 turn |
| 真实 Codex 与线上测试环境 | `node scripts/verify-codex-forwarding-live.mjs` 通过；真实 Home、真实模型和原生命令工具执行，固定 GET `https://im-test.deepminer.com.cn/` 返回 200，模型返回工具生成的随机值，唯一终态 `run.completed`，一个完成工具事件，无 computer-use 标签 |

实测脚本只在自身临时目录写校验回执，关闭 Host 后清理该目录。没有发送 IM、操作真实桌面或测试 computer-use 工具本身；这项删除不代表相关工具已获系统授权或可用。没有 Worker 登记/远端部署证据，也不将 MCP 本机连接检查描述为线上 MCP 接口验收。

## 已发现的独立问题

尝试以真实 Home 注入本轮 stdio MCP 时，`thread/start` 拒绝回传配置：`invalid type: string "", expected f64 in mcp_servers.node_repl.tool_timeout_sec`，执行失败被分类为 `PROVIDER_TIMEOUT`。定位到 Codex `app-server.ts` 中读取有效配置后合并并回传 MCP 的现有路径；尚未确认该空字符串具体产生位置，不推定用户磁盘配置已损坏。

这是额外 MCP 注入路径的问题，未在 F4 中修改配置或夹带修复。原生 HTTP MCP 的隔离配置检查通过；真实 Home 的原生命令执行与 im-test 请求也通过。该问题仍需单独修复并回归真实 Home 的 MCP 注入，不能宣称这条链路已通过。

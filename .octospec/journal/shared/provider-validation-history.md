---
type: Journal
title: Provider 与桌面联调的历史证据摘要
description: 提炼旧 docs 的真实验证、失败和未验收边界，不冒充本次验证。
tags: [validation, history, provider]
timestamp: 2026-10-15T00:00:00Z
---

# 历史验证摘要

以下仅归纳旧文档在其记录日期的结果。本次知识整理没有重新启动 Provider、桌面、Worker 或 IM。其结果不能作为当前 `df63c8f` 及后续工作树的发布证明。原始测试数、Run ID 和日志位置保留在 Git 中，按原文日期解释，不依赖临时目录仍存在。

## 证据与边界

| 原记录 / 日期 | 当时确认的结果 | 未证明或失败项 |
| --- | --- | --- |
| 思考强度，2026-10-11 | Codex xhigh 完成，未应用提示经当时 Worker 持久化并在 renderer 展示；OpenClaw/OpenCode 降档有原生参数断言 | MiniMax 最终 failed；全量桌面测试当时有 1 个合同断言失败；未逐 Provider/模型/档位实测 |
| envs，2026-10-13 | 共享 fixtures、并发隔离、真实 Codex app-server + stdio MCP 值传递；真实模型 shell 读取指定变量；桌面 im-test 登录及本地注册 | 全仓 ESLint 当时未通过；未通过桌面业务链提交完整 envs Run；其他 Provider 未逐一实测 |
| native/canonical，2026-10-13 | Codex 与 Claude 四种组合 completed；native 转换次数为零；当时 Work App 事件与自身存储一致且刷新可回放 | 真实 IM 收发、真实审批、取消后进程清理与切 Space CDP 尚未完整验收；远端 native 未启用 |
| MCP，2026-10-14 | Codex/Claude/Kimi 本机原生 HTTP MCP 工具发现和合成鉴权；MCode 收到 tools/list；构建和合同回归通过 | MCode 模型调用受额度失败；未证明 tools/call、全部 stdio/恢复凭据刷新；未做云端端到端工具调用 |
| OpenClaw 工作区忽略，2026-10-14 | metadata.workspace=false，指定不存在的目录未创建；真实本机 Gateway 返回 OK/completed | 准备回执仅 HTTP fixture 与 Worker 测试；不是线上 im-test OpenClaw Run |
| OpenClaw 连接统一，2026-10-14 | 多 profile、私密连接、无 main 探测与参数传递回归；重启后真实 renderer/本地 Gateway 执行 completed | 没有新建云端业务 Run；多 Gateway、token 轮换等由隔离测试覆盖 |
| 纯执行 / SQLite 移除，2026-10-14 记录 | 构建、限并发回归、无数据库及重启不恢复旧 Run；重启内置 Runtime 后真实 Codex 完成，未写遗留数据库 | 一轮默认并发曾挂起，独立及限并发复跑通过；IM 注册不等于 Worker Runtime 注册；记录早于后续拆包 |
| Extra SSE，2026-10-15 | 经真实桌面 daemon/Codex 返回 SSE，缺失 Bearer 拒绝，卸载释放端口且共享 Host 保持 ready；统一输入拆包后复验 | 原始 DTO 教程已被 InvokeInput 替代；HTTP 200 不等于执行成功；WeCom 未用真实账号实测 |
| 废弃链接清理，2026-10-15 | 主 checkout 旧链接清理、Runtime/图标包检查；真实 renderer 本地 Context A/空/B/重复 B 四轮完成 | cloudConnected=false，只证明本地调用；不是云端 Worker 执行链路 |

## 原始材料的 Git 定位

在仓库根执行 `git show df63c8f:<路径>` 可读取整理前原文：

- `docs/reasoning-level-mapping.md`
- `docs/27-native-canonical-protocol-contract.md`
- `docs/15-stateless-executor-design.md`
- `docs/openclaw-runtime-unification-validation.md`
- `docs/validation/context-envs-2026-10-13.md`
- `docs/validation/run-mcp-context-2026-10-14.md`
- `docs/validation/openclaw-workspace-ignored-2026-10-14.md`
- `docs/validation/extra-sse-demo.md`
- `docs/validation/obsolete-package-cleanup-2026-10-15.md`

## 现在如何验证

当前复跑入口见 [运维指南](../../guides/operations.md)、[开发规则](../../rules/engineering.md) 及具体规则引用的测试。真实接口联调使用 im-test。重新验收时记录实际提交、Provider 版本、请求入口、是否真实模型、终态和未验证范围；不直接复制本页的“通过”。

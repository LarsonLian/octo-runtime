---
type: Journal
title: 业务能力标签和执行目标预留合同删除验证
description: 记录 Runtime、Worker 与桌面消费端的合同清理及真实内置执行证据。
tags: [architecture, adapter, context, protocol, testing]
timestamp: 2026-10-15T08:15:00Z
---

# 实施范围

依据[任务简报](../../tasks/remove-business-capability-contract/brief.md)，删除 SDK 与 Host 类型中的 capabilities、各 Adapter 固定 react 标签、loader 的标签硬校验、注册日志字段、协议常量、执行计划 required_capabilities、整个 ExecutionTarget schema / 导出 / 校验器和对应占位测试。重新生成 TypeScript 合同，更新 fixtures；保留一个负例证明已删除的执行计划字段会被严格字段检查拒绝。

桌面主进程及共享类型同步删除字段、旧执行目标透传和 AbilityProvider 拒绝分支；移除其固定 react Agent fixture 和解析要求，不新增标签匹配逻辑。Worker 当前工作树原有另一项改造已删除 Agent / Run / Context 相关实现，本次保留这些修改，仅移除剩余 RuntimeAdapter 标签及校验，更新无标签发现测试，按现有源码重新生成 OpenAPI。未恢复被其他工作删除的文件，未进行删库、重建或旧数据回填。

当前规则收敛到[执行元数据](../../rules/adapter-metadata.md)，同步规则索引、架构、Context、Schema、开发指南、README 及知识目录。生态 37 / 44-01 / 59-01 历史方案增加撤回说明，保留原讨论历史，不能再作为新 Runtime 实现依据。

## 自动检查

- Runtime `pnpm typecheck`（包含全 workspace build）、`pnpm lint` 通过。
- Runtime 全量 Node 测试：771 项，764 通过、7 跳过、0 失败。未启用的真实 Provider 用例仍记为跳过。
- 补充发现断言并完成 fixture 排版收敛后，发现及 Context 协议专项测试 238 项通过。
- 桌面 `pnpm build`（包含 tsc）及全量 vitest 通过：195 个文件通过、1 个跳过；1620 项测试通过、1 项跳过。
- Worker `go test ./...`、`make build`、`make openapi-generate` 通过；生成 OpenAPI 不再包含 ExecutionTarget 或 required_capabilities。
- 系统 Python 缺少 PyYAML，使用仓库规定的 `uv run --with pyyaml python .octospec/scripts/lint.py` 检查通过；最新工作树为 65 个知识单元、20 条规则、565 个本地文件链接，包含同期其他工作的知识更新。三个代码仓库 `git diff --check` 通过。
- 清理最后一组桌面 Agent fixture 的固定 react 标签后，相关 6 个文件、63 项测试再次通过。

## 真实环境证据

启动重新构建的 Work App，CDP 读取真实 renderer：服务地址为 `https://im-test.deepminer.com.cn`，已有登录有效，内置 Runtime 为 running；daemon PID 为 63667。12 个已加载 Adapter 的桌面发现结果均不含 capabilities，Codex 可用。通过真实 bridge 读取机构列表返回 4 项，renderer 非空；不记录凭据或机构内容。

运行 `scripts/verify-extra-sse-live.mjs`，经临时 SSE Extra → 桌面内置 daemon IPC → AdapterHost → 真实 Codex 执行，Run `5fd8d41c-5b55-48b0-a374-b26c8377843d` 返回 `run.completed`，精确回复本次随机标记。未授权 SSE 请求返回 401，卸载后端口关闭，共享 Host 保持 ready。临时 Extra 使用独立临时目录并在结束时清理，既有 Home、身份、profile 和 Provider 状态未重置。

## 验证边界

Worker 新版本重启未通过，不能记为新服务运行成功：当前其他改造删除了旧服务配置字段和 `002_shared_execution_controls.sql` / `003_dispatch_queue.sql`，本机实际 YAML 与迁移账本仍属于旧基线。尝试以受保护备份暂存原配置并去除已退出的配置字段后，严格迁移校验仍拒绝未知历史账本；没有删除账本、修改数据库或绕过校验。已恢复原本机 YAML，并从本仓 HEAD 在独立临时源码目录构建兼容旧基线的服务，使用受保护原配置恢复本机服务，`http://127.0.0.1:8392/health/ready` 返回 ready。临时服务目录与配置备份保留供运维接续；当前运行的是旧基线服务，不宣称已应用本次 Worker 修改。新基线切换需要与正在进行的 Worker 收窄改造一并制定保留数据的迁移方案。

当前本地 SDK 不提供 Worker WS 注册工厂，桌面 connectionsEnabled 为 false；本次验证的是内置 Adapter 注册/发现与真实执行，不宣称云端 Worker 注册或远程调度成功。没有部署线上 Worker，也没有对真实 IM 用户发送测试消息。独立 CLI 与其他测试 Home 的既有进程不作为本次内置 Runtime 的验收证据，未为此重置其身份或配置。

Provider 原生 ACP / MCP / Codex capabilities 仍用于其原协议；Runtime 顶层已有的 capabilities JSON 发现容器不是 Adapter 业务标签，此次仅删除其中 Adapter 对象的标签字段，不做无关存储列改名。真实执行特性、来源、审批、图片输入和协议支持继续按原合同校验。

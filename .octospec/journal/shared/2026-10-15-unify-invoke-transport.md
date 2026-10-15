---
type: Journal
title: Host 与 RPC 统一输入及 CLI 实机验收
description: 记录 Host 唯一执行准备、signal 贯通，以及 Playboard 和 Work App 的可重复验收。
tags: [protocol, invoke, ipc, testing]
timestamp: 2026-10-15T00:00:00Z
---

# 实施结果

按[任务简报](../../tasks/unify-invoke-transport/brief.md)实施。AdapterHost、RPC Client 和 daemon SDK 共用 `invoke(input, environment)`，`signal` 保留在 environment。RPC 传输 InvokeInput；客户端只补关联 ID，执行默认值和内部 InvokeRequest 只在 Host 解析一次。native/canonical 是同一源流的输出视图。

删除三参数 HostInvoke/createHostInvoke，以及失去生产消费者的 HostInvokeWireOptions、serializeHostInvokeOptions、resolveHostInvokeWireOptions、对应 Schema、生成类型和样例。内部 invokeFrames 也接收原 input/environment；其存在用于源帧身份、回执、序号和续流，不产生第二条执行准备路径。Host 的 prepare 为私有实现。

signal 不序列化。提前取消阻止发送与启动；执行中取消通过原 invocationId 发送 cancel，服务端 AbortController 接入 Host。服务端在等待接纳回执期间也保存控制器。Host 首个 running 源帧提供接纳身份，Provider 在继续消费时启动；客户端 ACK、终态、消费者关闭和断流清理保持既有合同。

Work App 清除 ScenarioRequest/scenarioBuilders 的遗留导入和传参，文档评审仍直接构造业务 Context。新增 `octo-work-app/scripts/verify-invoke-live.mjs`，从命令行经 CDP 驱动真实 renderer，检查登录环境和内置 Host，提交个人测试对话并核对模型终态及本轮随机标记。脚本会保存测试对话，不输出凭据。

# 自动化证据

按顺序完成 Runtime 构建后，再运行 lint、测试和 Work App 构建，避免清理 dist 与其他检查并发。

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| Runtime 构建与类型 | `pnpm typecheck` | 通过，包含 Schema 类型重新生成及各包构建 |
| Runtime 静态检查 | `pnpm lint` | 通过 |
| Runtime 全量回归 | `node --test test/*.test.js packages/octo-runtime-protocol/test/*.test.js` | 778 通过，7 跳过，0 失败 |
| 同输入与取消 | `node --test test/invoke-parity.test.js` | 本地/RPC native、canonical 输入及默认值一致，原输入不变；提前取消和执行中取消通过 |
| Work App | `pnpm build`、`pnpm exec vitest run` | 构建通过；195 文件、1620 测试通过，1 文件/测试跳过 |
| Worker 构建 | `go build ./cmd/server ./cmd/migrate` | 通过；本轮未修改 Worker 的 Run/Context 接口 |
| OctoSpec | `uv run --with pyyaml python .octospec/scripts/lint.py` | 77 个 OKF 单元、20 条规则、615 个本地链接通过；系统 python3 缺少 PyYAML，使用临时依赖执行 |

全量回归包含临时 daemon 的 Ctrl+C、消费者关闭、接纳身份、Host 重启、断流续订与执行超时，不将这些 fake Provider 测试当作真实模型证据。

# CLI 与真实桌面证据

| 入口 | 可重复命令 | 结果 |
| --- | --- | --- |
| CLI 输入说明 | `node apps/cli/dist/index.js playboard --help` | 保留 InvokeInput 和进程信号取消说明 |
| CLI Playboard | `node scripts/verify-playboard-live.mjs` | im-test 可访问；Codex 18 帧、OpenClaw 46 帧，均 exitCode=0、run.completed、本轮标记匹配 |
| Work App renderer | 在 Work App 仓库执行 `node scripts/verify-invoke-live.mjs` | 登录 im-test；内置 runtime=running、adapterHostReady=true、10 个可用 Adapter；真实 Codex 对话 completed，标记匹配 |

Work App 已重启 dev Electron、内置 daemon 和 Host，CDP 使用 9222。测试复用既有 Home、profile、身份、配置及 Provider 状态，没有重新初始化 Runtime。

# 验证边界

本次验证本地执行协议、CLI Playboard、真实桌面 renderer 和两种实际 Provider。没有验证全部 Adapter 的真实模型执行，也没有将内置 Host 就绪等同于云端 Runtime WSS 已登记成功。外部连接开关保持既有设置；没有为本任务开启云端连接或修改身份。

Run=7、Context=v3、Adapter transport=2 保持不变。Worker 已构建，但当前运行的旧基线服务未切换到工作树产物：此前迁移账本与源码不一致，启动新产物失败后已恢复旧基线；本次未重建数据库或再次尝试迁移。本轮本地 wire 修改不依赖 Worker 服务升级。

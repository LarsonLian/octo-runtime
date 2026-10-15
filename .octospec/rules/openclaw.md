---
type: Rule
title: OpenClaw 连接与执行合同
description: profile 连接、已有 Agent、原生工作区及目标解析。
tags: ["openclaw","adapter","workspace"]
timestamp: 2026-10-15T00:00:00Z
implementation_baseline: df63c8f
id: runtime-openclaw
tier: repo
priority: 90
load_bearing: true
inject_when:
  paths: ["packages/octo-runtime-adapter-openclaw/**","packages/octo-runtime-core/src/invoke-input.ts","apps/cli/**","test/openclaw-*"]
  touches: ["openclaw","adapter","workspace"]
source: self
supersedes: []
---

# Runtime 与 OpenClaw 连接统一合同

本文说明当前连接配置、Provider 目标与执行边界。Run=7、Context=v3 保持独立。

本地身份与云端登记独立，见 [Runtime 合同](runtime-lifecycle.md)。OpenClaw 的认证 Gateway 连接是 Provider 执行依赖，与 Worker 设备在线或 IM 频道连接是不同链路。

## 概念定义

| 概念 | 定义与归属 |
| --- | --- |
| 本地 Runtime | 本地初始化即存在的执行对象，以稳定 `runtime_id` 标识；注册与远程寻址可选。一个 Runtime 对应 Runtime Home 中的一个 profile；多个 Runtime 可以共用本地控制服务和 Adapter Host。 |
| Provider Runtime | 实际执行任务的引擎或服务。OpenClaw、Codex 等处于同一执行层；Provider 可以由进程启动，也可以通过认证连接访问。 |
| Provider 类型 | 标识执行实现，例如 `openclaw`。当前协议沿用 `adapter_type` / `provider_type`；本次不新增含义重复的 `provider_id`。每个 本地 Runtime 对每个 Provider 类型保存一份连接配置。 |
| Adapter | 把 Provider 的执行协议转换成统一 Host 事件的实现。OpenClaw 使用认证 WebSocket Gateway RPC，不使用 SSE。 |
| Provider 连接配置 | 属于 本地 Runtime 的本地信息，包括连接来源、地址、凭据引用和设备身份。由本地宿主管理，不属于 Agent 定义或模型上下文。 |
| 目标 Agent | Provider 内的执行目标，由 Context 的 `provider_agent_id` 指定。多个 Agent 可共享一个 Runtime 的同一连接。 |
| Agent 来源 | `preset` 表示调用已有 Agent；`provisioned` 表示按该来源合同执行。来源与传输方式、连接配置相互独立；来源声明不意味着 Runtime 可以隐式安装 Runtime 或创建 OpenClaw Agent。 |

Runtime 的安装决策继续归 HostApp。OpenClaw Agent 的人格、记忆、插件和原生 workspace 继续归 OpenClaw 管理。

## 本地初始化与连接配置

1. SDK 在本地初始化 Runtime 并保存身份，不要求 Worker 注册。CLI 的 login 初始化本地 Home，不执行云端 enrollment；当前 Worker 接入包已移除。
2. 初始化该 Runtime 的 OpenClaw 连接来源，探测 Gateway 可用性。OpenClaw 缺失、未启动或认证失败只影响该 Provider 的可用状态，不阻止本地 Host 就绪或其他 Provider 执行。
3. 本地配置保存到 `<runtime-home>/<profile>/adapters/openclaw/connection.json`。内置 Runtime 使用账户目录下对应的 profile，不能退回另一账户或默认 Home 的连接。
4. 本地探测和实际执行读取同一 Runtime 配置。外部业务若报告可用状态，不得上报 Gateway token 或私钥；本地探测本身不需要云端上报。

支持两种连接来源：

- `home`：保存 OpenClaw Home 的绝对路径。每次探测和执行重新读取其中的 `openclaw.json`，使端口和 token 轮换生效。默认路径为用户目录下的 `.openclaw`；支持显式 `--openclaw-home PATH` 或首次初始化时的 `OPENCLAW_HOME`。
- `gateway`：保存显式 `ws://` / `wss://` 地址与本地凭据引用。token 通过 stdin 或 `OPENCLAW_GATEWAY_TOKEN` 提供，存入该 profile 的 `credentials` 目录。非回环地址必须使用 `wss://`。

显式命令参数优先。无显式参数时复用已保存来源；首次初始化才读取环境变量或默认路径。`OPENCLAW_GATEWAY_URL` 与 `OPENCLAW_GATEWAY_TOKEN` 必须成对提供，不能与 OpenClaw Home 同时配置。显式来源不可用时不得悄悄改用默认实例。

凭据文件以 `0600` 创建，设备身份保存到该 profile 的 `credentials/openclaw-device.json`。切换显式地址/token 时先写入新凭据，再原子替换连接描述，避免并发调用读到新地址与旧 token 的组合。既有调用继续使用已经解析的连接，新探测和调用读取新配置。启动、注册及探测不得重置 Gateway token，不自动改写 OpenClaw 配置。

## 统一执行合同

```text
业务方提交 Context（Provider 类型 + provider_agent_id）
  → 本地 SDK 或业务扩展提交共享 Host
  → Runtime 读取自己 profile 的 Provider 连接配置
  → Adapter 建立认证连接、验证目标 Agent、发起执行
  → 统一 Host 事件、审批、取消和终态回传
```

目标引用示例：

```json
{
  "schema": "octo.context-envelope/v3",
  "items": [{
    "namespace": "octo.execution",
    "name": "adapter",
    "payload": { "type": "openclaw", "provider_agent_id": "researcher" }
  }]
}
```

`provider_agent_id` 随执行计划解析和冻结，不进入模型提示词。本地连接配置不得设置或覆盖目标 Agent。Gateway 探测检查协议与公开执行能力，不要求存在名为 `main` 的 Agent；执行时验证本轮指定的目标。目标缺失必须明确失败，不切换到其他 Agent。

统一执行接口不表示各 Provider 能力相同。OpenClaw Adapter 声明 `metadata.workspace: false`，忽略 `octo.execution/workspace` 和 `workdir`，不检查或创建本地工作区、不分配随机目录、不覆盖目标 Agent 的原生工作区。本地调用不增加 Worker 回执门槛。Context 快照不改写，审批模式、环境变量和恢复等能力按实际支持范围校验。业务上下文由每轮发起方决定，显式重复照常传递，不自动补齐、缓存或追加。

## 操作入口

```sh
# 已初始化本地 Home/profile：自动发现，或复用已保存来源
octo-runtime --home /path/to/runtime --profile work adapter connect openclaw

# 指定 OpenClaw Home（包含 openclaw.json 的目录）
octo-runtime --home /path/to/runtime --profile work adapter connect openclaw \
  --openclaw-home /path/to/openclaw

# 显式 URL；stdin 只包含 Gateway token
octo-runtime --home /path/to/runtime --profile work adapter connect openclaw \
  --gateway-url ws://127.0.0.1:18789 --token-stdin
```

`login` 仅初始化本地 Home，也可提交 OpenClaw 连接参数；它不执行云端 enrollment。Gateway token 由 stdin 或环境提供，不作为命令行明文参数。`adapter list`、`adapter probe openclaw` 与 `playboard --home ... --profile ...` 使用选定 profile 的连接。

连接命令返回保存结果和探测状态；`available: false` 表示连接尚不可用，不表示本地 Runtime 身份初始化失败。已删除的 `--binding-id`、`--agent-id` 和 `--workspace` 连接参数不再接受；目标 Agent 必须放在 Context 中。旧 `config.json.adapters.openclaw` 外部绑定不自动转换，需删除旧配置并通过上述入口设置连接。

## 目标省略的当前实现

严格 Context adapter 校验和 OpenClaw Adapter 要求目标 Agent。统一公共输入解析在 OpenClaw adapter item 省略 `provider_agent_id` 时补入 `main`；这是当前输入入口的执行默认值，不是本地连接配置自动覆盖目标。需要确定目标的业务方应显式传值，`main` 不存在时执行失败，不查找其他 Agent。

## 核对入口

[连接解析与私密文件](../../packages/octo-runtime-adapter-openclaw/src/local-gateway.ts)、[Gateway 执行](../../packages/octo-runtime-adapter-openclaw/src/index.ts)、[公共输入默认值](../../packages/octo-runtime-core/src/invoke-input.ts)、[目录准备](../../packages/octo-runtime-adapter-host/src/execution-preparation.ts)、[连接测试](../../test/openclaw-runtime-connection.test.js)。

每次 invoke 创建隔离的执行 session，通过 `sessions.messages.subscribe` 取流、`agent.wait` 确认终态、`sessions.abort` 取消。连接验证、执行完成和渠道投递分别判断；`deliver: false` 的本地验证不证明 IM 发消息成功。

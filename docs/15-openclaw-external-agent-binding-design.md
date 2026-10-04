# OpenClaw 外部 Agent 接入方案

## 1. 文档目的

本文定义 OpenClaw 在 Octo 体系中的产品和技术边界，以及把一个位于用户内网的 OpenClaw Agent 接入 Octo Work 的完整流程。

本方案要解决的不是 OpenClaw provider 协议解析问题。当前 Harness 已经具备 OpenClaw Gateway protocol v4 adapter、Agent Worker WSS、adapter-host、事件回传和本地 credential 存储能力。本次方案解决的是更基础的概念问题：

1. 不把 OpenClaw 误认为与 Codex、Claude Code、CodeBuddy、Hermes 同类的 Base Runtime。
2. 不把外部 OpenClaw Agent 的人设、skills、memory 或 workspace 复制成 Octo 的 AgentRevision。
3. 不要求云端直接访问用户内网中的 OpenClaw Gateway。
4. 把“添加设备”和“接入 OpenClaw Agent”定义为两个独立且完整的流程。
5. 让 Octo Work 能发现、绑定和调用外部 Agent，但不主动管理外部 Agent 的内部配置。

本文中的“外部 Agent”均指已经由 OpenClaw 管理、可以通过其 Gateway 调用的 Agent。Octo 不负责创建其业务人格，也不负责维护其 skills。

## 2. 结论摘要

OpenClaw 应归类为 `external` Agent，而不是 `provisioned` Agent。

```text
provisioned Agent
  Octo 拥有执行环境、Runtime、workspace、instructions 和 skills

external Agent
  外部系统拥有 Agent；Octo 只保存绑定引用并发起调用
```

OpenClaw 的网络路径为：

```text
Octo Work / Agent Worker
        |
        | AgentRun command over WSS
        v
octo-harness daemon (用户内网主动出站)
        |
        | authenticated WebSocket
        v
OpenClaw Gateway
        |
        v
OpenClaw Agent
```

云端不直接连接 OpenClaw Gateway。`octo-harness daemon` 是内网出站桥，也是唯一需要同时看到 Octo Worker 和 OpenClaw Gateway 的组件。

OpenClaw 在 Octo 中是黑盒：Octo 可以提交输入、接收 canonical events、执行超时和取消，但不主动读取、修改或同步 OpenClaw 的人设、skills、memory、工具配置和内部 workspace 状态。

## 3. 概念边界

### 3.1 Base Runtime / Provisioned Agent

本地 CLI、ACP 或 stdio 型 provider 可以作为 Harness 的基础执行 Runtime。典型特征是：

- Harness 可以发现或启动 provider 进程；
- Harness 可以控制工作目录、执行超时和进程生命周期；
- AgentRevision 可以向 Runtime 提供 instructions、model、skills、workspace 等执行配置；
- provider 的 native stream 或 ACP 事件由 adapter 转换为 canonical events。

这类 Agent 可称为 `provisioned` Agent。其执行环境和部分配置由 Octo 管理。

### 3.2 OpenClaw External Agent

OpenClaw 不满足上述基础 Runtime 语义。它通过 Gateway 暴露外部 Agent，Agent 的实际人格和能力由 OpenClaw 侧管理。Octo 只依赖公开 Gateway protocol v4 能力：

- 建立认证连接；
- 创建或恢复一次执行 session；
- 发送 AgentRun 输入；
- 接收过程和终态事件；
- 发送取消；
- 在连接失败时重连并对账。

OpenClaw Agent 在 Octo 内使用 `external` 类型表示。其 Octo AgentRevision 只能引用外部绑定，不得携带一份声称拥有最终解释权的 system prompt、skills 或 memory 配置。

### 3.3 Ability Provider 与 Execution Provider

现有 `AgentRevision` 中的 `abilityProvider` 表示云端能力提供者，不能直接承担 OpenClaw 内网连接语义。建议在概念模型中区分：

```text
AbilityProvider
  云端模型、工具或能力提供者

ExecutionProvider
  实际执行 AgentRun 的 provider

AgentSource
  provisioned | external
```

如果现阶段不新增字段，也必须至少增加 `agent_kind` 和 `external_binding_id`，避免用 `abilityProvider` 的值隐式推断 OpenClaw 的连接设备、Gateway 或 provider agent。

## 4. 两条独立流程

### 4.1 流程 A：添加设备

“添加设备”只解决设备身份和本地连接器上线问题，不代表已经接入任何 OpenClaw Agent。

```text
Octo Work 创建 Device Enrollment
  -> 生成一次性 enrollment grant
  -> 用户在目标主机执行 octo-harness login / connect
  -> daemon 创建或恢复 Runtime/Connector 身份
  -> daemon 连接 Agent Worker WSS
  -> Octo Work 显示设备 online
```

设备可以承载 provisioned provider，也可以承载 OpenClaw external connector。设备本身不是 Agent，也不等于 OpenClaw Agent。

### 4.2 流程 B：接入 OpenClaw Agent

“接入 OpenClaw Agent”只解决一个外部 Agent 的认领和绑定问题，必须在设备已添加后进行。

```text
Octo Work 创建 External Agent Binding
  -> 选择 OpenClaw，填写名称和目标 agent id
  -> 生成一次性 pairing token/命令
  -> 用户在 OpenClaw Host 执行连接命令
  -> daemon 读取本地 OpenClaw host token
  -> daemon 连接指定 Gateway
  -> 验证 Gateway protocol、目标 agent 和必要能力
  -> daemon 使用 pairing token 完成 claim
  -> Octo Work 将 Binding 标记为 connected
```

这两个流程不能合并成“setup 一个 Runtime 顺便创建 Agent”。设备可以先上线，Agent 可以稍后绑定、解绑或重新绑定到另一台受信任设备。

## 5. 用户旅途（Octo Work）

### 5.1 添加设备

用户进入 Octo Work 的“设备”页面，点击“添加设备”：

1. 选择设备用途或直接创建通用 Harness Connector。
2. Octo Work 展示一条短期、一次性的命令或安装指引。
3. 用户在目标主机执行命令，并通过 stdin 输入 enrollment grant。
4. `octo-harness daemon` 启动并连接 Agent Worker。
5. 页面显示设备名称、设备 ID、连接状态和最后心跳时间。

此时页面不显示任何 OpenClaw Agent，除非用户继续执行“接入外部 Agent”。

### 5.2 接入外部 OpenClaw Agent

用户进入“Agents”，点击“接入外部 Agent”：

1. 输入 Octo 中显示的名称，例如“内网研究助手”。
2. 类型选择 `OpenClaw`。
3. 选择已在线的 Harness Connector 设备。
4. 输入 OpenClaw Gateway 地址和目标 Agent ID/slug。
5. Octo Work 生成一次性配对命令。
6. 用户在 OpenClaw Host 执行命令，并按提示提供本地 host token；长期 token 不出现在命令行、聊天记录或 AgentRevision 中。
7. daemon 连接 Gateway，验证目标 Agent，完成 claim。
8. Octo Work 显示“已接入”，并展示可调用状态和有限的 capability 摘要。

从用户视角，最终只看到一个可以选择的 Agent。这个 Agent 可以被用于 Chat、Task 或其他上游触发，但其内部人设和 skills 不在 Octo Work 中编辑。

### 5.3 使用外部 Agent

用户在 Octo Work 中选择该 Agent 并发送任务：

```text
Octo Work 创建 AgentRun
  -> Agent Worker 选择 ExternalAgentBinding
  -> 通过 WSS 下发 run.start
  -> daemon 连接 OpenClaw Gateway
  -> OpenClaw Agent 执行
  -> daemon 将事件转换为 canonical events
  -> Worker 更新 AgentRun
  -> Octo Work 展示结果
```

用户可以看到运行状态、输出、错误、超时和取消结果，但不需要也不能在 Octo Work 中编辑 OpenClaw 的内部配置。

## 6. 建议的数据模型

### 6.1 ExternalAgentBinding

建议由 Agent Worker/云端控制面持有以下绑定对象：

```ts
interface ExternalAgentBinding {
  id: string;
  agentId: string;
  source: "external";
  provider: "openclaw";
  connectorDeviceId: string;
  gatewayUrl: string;
  providerAgentId: string;
  providerAgentName?: string;
  capabilitySnapshot?: Record<string, unknown>;
  status: "pending" | "pairing" | "connected" | "offline" | "revoked" | "error";
  credentialRef: string;
  lastVerifiedAt?: string;
}
```

云端只保存连接所需的引用、状态和受限 capability 摘要，不保存 OpenClaw 的完整 Agent 定义。

### 6.2 本地 connector profile

daemon 的受保护 profile 保存本地连接所需的秘密：

```text
binding_id
gateway_url
provider_agent_id
connector_device_id
gateway host token / device credential
OpenClaw device identity
```

本地 token 必须继续遵守现有 credential 规则：只写入 owner-protected 文件，不进入 argv、日志、AgentRevision、事件 payload 或普通配置导出。

### 6.3 AgentRevision 引用

External Agent 的 revision 只需要表达绑定和执行策略：

```text
agent_kind = external
external_binding_id = binding_xxx
timeout_policy
cancellation_policy
allowed_input_policy
```

不得把 OpenClaw 的 persona、skills、memory 或 workspace 快照写入 revision，避免云端产生一份与外部系统冲突的“影子定义”。

## 7. daemon 的职责

daemon 负责网络桥接和执行事实，不负责外部 Agent 的主动治理。

### 7.1 负责

- 保持到 Agent Worker 的 WSS 连接；
- 保存并使用本地 connector credential；
- 主动连接内网或受保护网络中的 OpenClaw Gateway；
- 验证 protocol version 和必要方法/事件；
- 验证配置中的目标 provider agent；
- 将 OpenClaw native events 转换为 canonical events；
- 执行本次 AgentRun 的超时、取消和重连对账；
- 回报 connector 和 binding 的在线状态。

### 7.2 不负责

- 创建或修改 OpenClaw 的 persona；
- 写入或同步 OpenClaw skills；
- 管理 OpenClaw memory；
- 修改 OpenClaw tools、模型路由或 workspace 内容；
- 代替 OpenClaw Control UI 做交互式问题回答；
- 把 OpenClaw 内部 transcript 当成 Octo 的 Session 权威；
- 通过定时任务主动修复外部 Agent 的配置漂移。

发现外部配置不满足调用合同，只允许本次调用 fail closed 并报告原因，不执行自动修复。

## 8. 黑盒交互合同

OpenClaw adapter 只暴露 provider-neutral 的执行能力：

```text
probe / describe
invoke
cancel
```

一次 invocation 的边界为：

```text
打开认证 WebSocket
  -> 验证 protocol/capabilities
  -> 验证目标 agent 可调用
  -> 创建唯一 session key
  -> 发送用户输入和允许的执行上下文
  -> 接收并转换事件
  -> 等待确定终态
  -> 关闭连接
```

Octo 可以传递本次任务所需的输入和有限的运行上下文，但不能宣称这些字段会覆盖 OpenClaw 的 system prompt 或内部配置。对于 OpenClaw 不支持的能力，adapter 应返回明确的 capability/unsupported 错误，而不是模拟一个本地 Runtime。

## 9. 安全和撤销

### 9.1 配对

- pairing token 为短期、一次性、绑定目标设备和 binding 的 grant；
- token 只能用于 claim，不是长期 OpenClaw token；
- 命令行中不应放置长期 Gateway token；
- 配对成功后立即作废 pairing token；
- daemon 必须证明自己拥有已添加设备的 credential。

### 9.2 调用权限

- Worker 只允许已经绑定且未撤销的 `ExternalAgentBinding` 接收 AgentRun；
- daemon 不信任 run payload 自报的 agent、profile 或 credential；
- OpenClaw Gateway URL、provider agent id 和 credential 来自已验证的本地 binding；
- 取消操作只作用于当前 AgentRun，不提供 OpenClaw 全局管理接口。

### 9.3 撤销

Octo Work 可以撤销设备或 external binding：

- 撤销 binding：停止向该外部 Agent 派发新 Run，并清理本地 binding credential；
- 撤销设备：使该设备承载的所有 binding 离线，等待重新配对；
- 不自动删除 OpenClaw Gateway 中的 Agent，不修改其内部数据。

## 10. 状态与错误

建议最小状态集合：

```text
pending       已创建绑定，尚未执行配对
pairing       daemon 正在完成 claim
connected     最近一次验证成功，可调用
offline       connector/daemon 暂时离线
error         配置或协议验证失败
revoked       已由用户撤销
```

典型错误应区分：

- `CONNECTOR_OFFLINE`：设备未连接 Worker；
- `GATEWAY_UNREACHABLE`：daemon 无法连接 Gateway；
- `GATEWAY_AUTH_FAILED`：本地 host token/device credential 无效；
- `PROVIDER_AGENT_NOT_FOUND`：目标 OpenClaw Agent 不存在；
- `PROVIDER_AGENT_UNAVAILABLE`：Agent 存在但当前不可调用；
- `PROTOCOL_UNSUPPORTED`：Gateway 缺少必要的公开能力；
- `BINDING_REVOKED`：云端绑定已撤销；
- `CONFIG_DRIFT`：调用合同不满足，daemon fail closed。

错误只描述调用为什么不能完成，不触发对外部 OpenClaw 的自动修复。

## 11. 对现有仓库的影响

### 11.1 可以复用的部分

- `apps/daemon` 的 Agent Worker WSS transport；
- `packages/octo-harness-adapter-host` 的动态 adapter 加载和 RPC；
- `packages/octo-harness-adapter-openclaw` 的 Gateway protocol v4 adapter；
- 现有 profile credential store 和受保护文件；
- canonical event、AgentRun terminal、cancel、reconnect 和 outbox 机制；
- provider capability/probe 的通用合同。

### 11.2 需要新增或调整的部分

1. Agent Worker 增加 `ExternalAgentBinding` 和 pairing API。
2. `AgentRevision` 能表达 `provisioned` 与 `external` 两种来源。
3. daemon profile 从“OpenClaw setup 配置”迁移为“external binding 配置”。
4. CLI 增加设备配对和 external agent claim 命令。
5. OpenClaw setup 不再隐含创建一个 Base Runtime；它只完成外部 binding 的本地落盘和验证。
6. Octo Work 增加设备、绑定、在线状态和撤销页面。
7. 事件和审计记录增加 `connector_device_id`、`external_binding_id` 和 `provider_agent_id` 的安全引用。

### 11.3 不需要做的事情

- 不需要为 OpenClaw 重写 daemon transport；
- 不需要把 OpenClaw 内部 session/memory 导入 Core；
- 不需要为 OpenClaw 增加一套本地 AgentRevision 执行模型；
- 不需要云端直接打通 OpenClaw 内网；
- 不需要实现 OpenClaw persona、skills、tools 的 Octo 管理页面；
- 不需要为配置漂移增加自动修复器。

## 12. 分阶段实施

### Phase 1：最小闭环

- 一个已添加设备；
- 一个 OpenClaw Gateway；
- 一个 external binding；
- 一个 provider agent；
- 完成 pairing、invoke、canonical events、terminal、cancel；
- 页面展示 online/offline/error。

验收标准：用户可以在 Octo Work 创建绑定，在 OpenClaw Host 执行一次命令完成接入，然后从 Octo Work 发起一次 AgentRun 并看到结果。

### Phase 2：生命周期和安全

- 设备和 binding 分离撤销；
- credential 轮换；
- 重配对；
- 多 binding 复用一个设备；
- connector 离线时的可靠排队与恢复；
- 审计和错误码完整化。

### Phase 3：多 provider external connector

抽象通用 external connector 合同，为其他外部 Agent Gateway 复用：

```text
ExternalConnector
  pair
  verify
  invoke
  cancel
  describe
```

OpenClaw 仍然只是其中一个实现，不能反向污染 provisioned Runtime 的模型。

## 13. 最终用户效果

最终用户在 Octo Work 中看到的是两类 Agent：

```text
Octo 托管 Agent
  由 Octo provision，拥有 Octo Runtime 和执行配置

外部接入 Agent
  由 OpenClaw 托管，Octo 只负责连接和调用
```

外部接入 Agent 的用户旅途只有三步：

```text
添加设备
  -> 执行一次性命令完成 OpenClaw 配对
  -> 在 Octo Work 中像使用普通 Agent 一样发起任务
```

但在系统边界上，它始终是黑盒。Octo Work 不主动接管 OpenClaw 的人设、skills、memory、工具和 workspace，也不把外部 Agent 伪装成 Octo 的 Base Runtime。

这正是本方案要建立的稳定概念：

> Octo 负责执行编排和连接事实；OpenClaw 负责外部 Agent 的内部智能和配置。两者通过本地 daemon 的出站 connector 边界协作，互不夺取对方的控制权。

## 14. 当前分支实现状态

本分支已先落地 Phase 1 的本地 connector 闭环：

- 新增 `octo-harness adapter connect openclaw` 命令；
- external profile 配置包含 `kind: "external"` 和 `binding_id`；
- connect 只要求目标 Agent 已存在，并拒绝通过 `agents.create` 创建它；
- connect 不调用 `config.patch`，不清空或冻结外部 workspace；
- OpenClaw adapter 对 external binding 跳过 Harness-managed runner 的隔离配置校验；
- 已补充 CLI 配对状态和 adapter 黑盒调用测试。

当前尚未伪造云端 `ExternalAgentBinding` API。`--binding-id` 代表未来由 Octo Work 生成的绑定 ID，现阶段可以作为本地 connector 与云端模型对接前的稳定引用。下一步应在 Agent Worker/Octo Work 实现一次性 pairing grant、claim、binding 撤销和在线状态投影，然后让 connector 使用该 grant 完成真正的云端绑定。

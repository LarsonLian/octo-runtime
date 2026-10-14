> 历史快照：2026-10-14 文档统一前的方案与验证叙述，仅保留当时含义，不作为当前接口、职责或实施状态。现行说明见 [当前文档](agent-identity-runtime-registration-ipd-se.md)。

# Agent Identity 与 Runtime 引导注册：IPD-SE 设计

版本：0.2；日期：2026-10-14（Asia/Shanghai）；实施分支：各仓库当前 main。状态：身份与注册首批实现已通过构建及测试；IM 云端接线与完整实机验收待完成。

## 1. 决策与边界

用户确认采用破坏性更新：删除 Agent 默认定位中的 purpose/personal_work，不保留兼容读取、双写或回填。业务身份为 `(octo_space_id, subject_type, subject_id, identity)`。默认个人助理 identity 为 `main`；分身 identity 可直接使用稳定 bot_id。name 只负责展示，可以修改和重名。agent_id 继续作为系统内部关联及执行快照中的业务 ID。

注册 Runtime 时 create-if-not-exists 一个 Agent，不创建 AgentRun。首次创建初始化 Context 配置；重复注册只复用，不改名称、提示词、MCP、禁用状态或已配置执行目标。Runtime 身份与 Agent 身份独立，多台 Runtime 可引用同一 Agent。分身专用 Runtime 和 Adapter 通过 Agent Context 或本轮 Context 选择，不把 runtime_id 塞进 Agent 唯一键。

独立 Agent Access 已从本工作区基线退出；本文的“Access 入口”指 Worker 现有鉴权 HTTP 入口，不重建独立服务。Run=7、Context=octo.context-envelope/v3 不变。已有会话/reset 改动继续保留。

## 2. 需求追踪

| RR | SR 系统要求 | FEAT | AC |
| --- | --- | --- | --- |
| RR01 去掉 purpose，采用 identity | 四元组唯一，默认 main，展示名不参与定位 | F01 身份模型 | AC01–04 |
| RR02 Runtime 自动创建分身 | 可选 agent_identity/agent_name，首次初始化，重复只读 | F02 注册 | AC05–08 |
| RR03 Event 无须预知 agent_id | 按四元组解析并授权，冻结解析后的 agent_id | F03 Event | AC09–12 |
| RR04 云端默认 MCP/提示词生效 | 使用 agent_context_configurations，mandatory 最终覆盖 | F04 Context | AC13–16 |
| RR05 IM 使用完整执行配置 | 统一 Event 入口及 Runtime 调度，不直连绕过云端配置 | F05 IM 接线 | AC17–19 |
| RR06 破坏性更新 | 同步源码、生成合同、配置、测试，不做历史格式转换 | F06 交付 | AC20 |

## 3. 身份与数据

Agent identity 限 1–191 个 ASCII 字符：首字符字母/数字，其后字母、数字、点、下划线、冒号或短横线；区分大小写，不 trim 或改写。main 是默认助理的保留身份。不同 IM 平台可能重号时由业务方提供平台前缀。OpenClaw provider_agent_id 与 Octo identity 独立，OpenClaw 连接参数缺省 main。

删除 agent_bootstrap_slots，将 identity 直接保存在 agents，唯一约束为 `(octo_space_id, owner_subject_type, owner_subject_id, identity)`。保留表内自增物理 id；agent_id 仍指向 agents。删除 agents 的 owner/name 唯一约束。查询按完整作用域进行，不通过列表扫描或 name 查询。首次初始化 Agent 与 Context 配置必须同一事务提交。INSERT ON DUPLICATE KEY UPDATE 使用不改变现有行的赋值，随后按四元组 SELECT FOR UPDATE；只有本次插入的新 Agent 初始化 Context。手工创建接口可显式提供 identity，未提供时使用新生成的 agent_id 作为稳定 identity。

槽位表原来负责“默认用途 → Agent”的映射和并发占位。identity 已成为 Agent 自身的属性后，这两个职责分别由作用域查询、唯一索引与事务承担。继续保留槽位表会产生两份身份映射及一致性维护成本，因此一并删除对应实体、Repository 方法和活动表清单。agent_context_configurations 仍保存提示词、MCP 等配置，与被删除的槽位表职责不同。

身份解析只读：不存在返回 AGENT_IDENTITY_NOT_FOUND，不在 Event 内隐式创建。禁用 Agent 不自动复活。身份结构不是授权凭据；Space 必须与认证租户一致，subject 必须通过现有 owner 授权。Actor 仍是事件发起者，与目标 Agent 的 subject 分开。

## 4. 接口合同

### 4.1 Runtime 注册与 CLI

`POST /v1/runtime/register` 增加可选 `agent_identity`、`agent_name`。省略 identity 为 main；显式空值或非法格式报输入错误。owner/Space 取已认证、已持久化 Runtime；客户端不能通过扩展参数指定任意 owner。返回 runtime、created 及 agent 引导结果（agent_id、identity、配置版本、created、状态）。

CLI 支持 `--agent-identit=bot_123 --agent_name=云端助手`，并提供规范拼写 `--agent-identity`、`--agent-name`。重复或相互矛盾的参数报错。这些是同一新能力的拼写入口，不是旧 purpose 的兼容。profile 保存 agent_identity/agent_name；首次注册、带身份参数的重复 login、daemon 重连、SDK 注册使用同一配置，不能重连后回到 main。已登录且未传新参数的 login 沿用现有行为，不额外触发注册。

### 4.2 Event

在现有 `/v1/events` 增加目标字段 `octo_space_id`、`subject_type`、`subject_id`、`identity`。采用身份目标时四项必须齐全；与显式 agent_id 二选一，不能同时传入。显式 agent_id 仍服务于已经持有实体 ID 的管理/编排调用方，不自动转换旧 purpose。

入口先验身份格式和认证租户，解析目标 agent_id，再按现有 Agent owner/actor/服务委托规则授权，最后进入既有 Event 幂等账本和 Run 提交流程。原始四元组及解析后的 agent_id 随 Event 冻结，重投不漂移目标。不接受未授权跨租户/跨用户解析。

现有 Event HTTP 返回执行回执，Worker 通过 Runtime 通道交付冻结的执行 payload；不把“HTTP 接纳”描述成“已执行”。不新增一个只读合并接口再在本地另建 Run，避免两份执行身份和两套终态。

### 4.3 Context 合并

入口本地默认值与本轮显式项组成 submitted Context；Worker 使用云端 Agent defaults 与 submitted 合并，最后应用 mandatory。mandatory 同项以云端值为准，不因本轮选择不同报冲突。model/limits 按已有一级字段合并；MCP 按 server 名覆盖整项；envs 按变量名覆盖；adapter、workspace、runtime selection 等整项替换。未被 mandatory 指定的配置保留。

格式、资源权限和最终能力校验仍有效。MCP 不支持不能伪造成功；控制提示词仍由可信 Agent 配置提供，普通用户不能提交 octo.control 来冒充。模型材料保持本轮业务顺序，不从历史 session 补齐或去重。

## 5. 模块改造点与工作包

| WP | 模块 | 改造点 | 验证 |
| --- | --- | --- | --- |
| WP01 | Worker domain/repository/migrations | Agent 增加 identity；删除槽位表；事务幂等创建；去 name 唯一；作用域查询 | 身份隔离、并发 create-if-not-exists、改名后解析 |
| WP02 | Worker Runtime handler/service | 参数验证，可信 owner，返回 Agent，保留既有配置 | 重复注册、不同 identity、禁用、无权 owner |
| WP03 | CLI/managed-profile/embedded SDK | 参数解析、持久化、注册/重连透传；OpenClaw 缺省 main | CLI 等号/空格、profile 重载、SDK 重注册 |
| WP04 | Worker Event handler/domain | 身份目标解析后进入既有授权与提交链路 | 缺字段、歧义目标、跨租户、幂等 |
| WP05 | TS/Go Context resolver/fixtures | mandatory 覆盖，更新共同 fixtures 和执行测试 | MCP/env/model/runtime/adapter 同值与异值 |
| WP06 | IM Channel/daemon | 用注册身份组成 Event；连接现有云端提交/事件流/取消，维持原回复与 reset；去本地直接 invoke 旁路 | 云端提示词和 MCP 到达 Host；重试不重复 Run；断线不得退回本地绕过 |
| WP07 | Work App/OpenAPI/docs | 保留当前只读默认助理查询；同步 identity 返回和合同 | 类型、构建、默认入口及切 Space |
| WP08 | 集成验证 | 构建并重启受影响本地组件，对接 im-test 身份 | 注册→Event→冻结配置→实际 Host；实测与未测分开记录 |

## 6. 验收条件

AC01 同一四元组返回相同 agent_id；AC02 不同 identity/owner/Space 隔离；AC03 相同展示名允许；AC04 purpose 不再出现于活动定位合同或表结构。
AC05 省略注册参数得到 main；AC06 指定 identity/name 创建分身；AC07 重试不覆盖云端配置；AC08 并发注册仅创建一份资产，失败事务无残留。
AC09 Event 四元组解析正确；AC10 不存在不自动创建；AC11 越权、错租户、双目标被拒绝；AC12 幂等重投保持执行身份。
AC13 默认提示词和 MCP 出现在有效执行配置；AC14 mandatory 覆盖异值不报冲突；AC15 未强制项保留；AC16 格式、授权、实际能力校验仍有效。
AC17 IM 通过云端 Event；AC18 Host 使用已冻结配置且不二次覆盖；AC19 reset/取消/回复归属不回归；AC20 构建、真实验证和剩余事项有证据，不将设计状态写成完成。

## 7. 交付与风险

按当前分支实施，保留其他任务的未提交修改。源码和 schema 可破坏性更新，但本轮不擅自删除共享运行数据库或既有业务数据；需要重建的本机 Worker 库固定 octo_agent_worker，执行前核对当前运行进程与备份。无旧字段回填、兼容读取或双写。

重点风险：相同 Runtime 在重连时漏传 identity 导致误创建 main；Event 四元组未经认证直接查询导致越权；本地默认覆盖云端 mandatory；IM 创建本地 Run 与云端 Run 导致重复执行。对应验收分别为 AC05–08、AC11、AC14、AC17–18。

## 8. 实施证据

### 8.1 本次实现

| 工作包 | 当前结果 |
| --- | --- |
| WP01 | 已实现 agents.identity、作用域唯一索引、幂等创建事务及按身份查询；已删除槽位表的建表语句与运行时代码 |
| WP02 | 已实现注册参数、可信 Runtime owner/Space 推导、Agent 返回结果；重复注册保留名称、状态和 Context 配置 |
| WP03 | 已实现 CLI 参数及 profile、embedded SDK、worker-access 重注册透传；OpenClaw provider agent 缺省 main |
| WP04 | 已实现 Event 四元组目标校验、解析、授权和冻结；进入既有提交链路；尚未完成真实 Runtime 端到端验收 |
| WP05 | 已同步 TS/Go mandatory 覆盖语义及共享 fixtures；默认项、提交项、强制项继续使用现有 Context 合并入口 |
| WP06 | 待实现。当前 IM 仍走本地 invoke；尚未把 IM 入口改为云端 Event 提交、订阅和取消，不能宣称 IM 已应用云端 Agent 配置 |
| WP07 | 已更新 Work App 默认 Agent 合同与校验、Worker OpenAPI 和使用文档；真实桌面运行态验证待完成 |
| WP08 | 已完成构建、定向回归及固定 MySQL 的并发事务测试；进程重启、im-test 身份与真实 Host 执行验收待完成 |

### 8.2 本次实测（2026-10-14）

- Worker：`go test ./...`、`go build ./cmd/server ./cmd/migrate` 通过；`make openapi-gen` 成功。
- Harness：`pnpm build` 通过；CLI enrollment、Context fixtures/MCP、Runtime options、embedded SDK 定向测试合计 62 项通过。
- Work App：`pnpm build` 通过；默认 Agent 查询、服务、聊天与 Agent Work client 定向测试合计 44 项通过。
- 固定数据库：只读确认 `127.0.0.1:3306 / octo_agent_worker` 已有 `agents.identity` 且无 `agent_bootstrap_slots`。本次未执行删库重建或线上 DDL。
- `TestAgentIdentityLiveMySQL` 在上述固定库通过：16 个并发请求只创建一个 Agent；同 owner 下两个 identity 可以同名；修改名称、禁用状态、默认 MCP 和 mandatory 提示词后重复初始化保持不变；错误 Space/owner/identity 查不到目标。测试只创建独立测试作用域的记录，并在结束后清理这些记录。

真实数据库测试只证明存储和事务行为，不代表 HTTP 注册、IM 收消息或 Host 调用已端到端通过。当前运行服务的健康状态也不作为新源码已部署的证据。工作区原有的会话/reset 与 AgentRevision 精简改动予以保留。

### 8.3 下一实施里程碑

将 IM 接入现有 Worker Event 生命周期，先明确 Runtime 凭据与 Event 发起者的授权合同，再实现提交、结果订阅、取消和回复归属。现有 `/v1/events` 使用用户或已授权服务身份，不能直接把 Runtime token 当作用户凭据；HTTP 接纳回执也不能充当可直接本地 invoke 的 payload。完成接线后，同步重启 Worker、Harness 和 Work App，在 im-test 身份下验收云端提示词/MCP 到达 Host、mandatory 生效和重复投递不产生双份 Run。

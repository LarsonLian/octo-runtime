---
type: Rule
title: 渠道接入与业务投递
description: Channel 显式调用本地 Host，自己管理上下文、会话与投递。
tags: ["channel","delivery","session"]
timestamp: 2026-10-15T00:00:00Z
implementation_baseline: df63c8f
id: runtime-channel
tier: repo
priority: 90
load_bearing: true
inject_when:
  paths: ["packages/octo-runtime-extra-channel-*/**","test/im-*","test/channel-*"]
  touches: ["channel","delivery","session"]
source: self
supersedes: []
---

# 渠道接入与业务投递

Octo 与 WeCom 使用各自的可选 Extra 包，通过注入的共享 Host 执行。代码分别有默认函数式 Extra 入口和对象式 daemon module 工厂；两者参数不同，不能混用。宿主显式携带和启用包，不要求 Worker 注册。

## 本轮输入

Octo 与 WeCom 的 Bot 配置不包含渠道 `type`；平台由加载的 Extra 包确定。`adapter.adapter_type` 继续用于选择执行引擎，状态和执行元数据中的平台由插件自身输出。

Octo 插件配置只校验已识别字段，未知扩展字段保留并忽略，不使用字段白名单拒绝整个配置。可选 `bot_name` 为本地展示名称，省略时使用 `bot_id`，不参与身份或授权。CLI/daemon 统一经 Extra 声明装配，不提供渠道专用命令或文件读取。`extraset` 原样保存并替换整份插件声明，多机器人由插件自己的 `config.bots` 数组表达；Bot 校验、默认值与连接管理属于插件。

业务渠道决定 Actor、Trigger、Target、Input 和本轮 Context，并在调用前处理业务 defaults/mandatory。Octo 的可选 GROUP.md、历史读取和消息 selection 属于渠道业务选择，不是 Host 的自动采集能力。

渠道使用公共 InvokeInput 并显式选择 canonical，保存 Provider binding，处理交互与 reset。源事件及 payload 必须完整交给消费应用；UI 展示过滤不应裁剪原始历史数据。

Octo Channel Gateway 的本地引擎省略 `adapter.workdir` 时，由渠道入口使用并创建 `~/octo-runtime/channels/{bot_id}`，不随配置 Home 或会话变化。显式目录必须是绝对路径；Context workspace 仍按执行配置解析规则覆盖默认值。OpenClaw 保留 Provider 自有工作区。

## Octo CLI 的渠道执行环境

本节仅约束 `channel-gateway` 发起的执行如何使用 `octo-cli`。已实现独立执行覆盖及 CLI OpenClaw dotenv 同步；改造内容与验收范围见 [任务方案](../tasks/channel-octo-cli-environment/brief.md)，真实验证边界见 [记录](../journal/shared/2026-10-15-channel-octo-cli-design.md)。

- gateway 使用 `OCTO_BOT_TOKEN` 和 `OCTO_API_BASE_URL` 为 octo-cli 提供身份与地址。普通子进程 Adapter 每轮使用接收消息的连接已解析并通过身份校验的 Bot 凭据；OpenClaw 使用下述 CLI 预配置例外。API 地址取对应渠道配置的 `api_url` 并移除末尾 `/api` 和尾部斜杠。不得从 WS 消息、正文或请求 `envs` 获取这两个强制值。
- 这两个值属于 gateway 为工具调用提供的执行环境，不追加到发起方 Context、控制指令、模型输入、业务快照或运行元数据。Context 的 `envs` 保持额外执行配置的既有语义；gateway 的两个强制值覆盖其中及设备环境中的同名值，其他变量保持原有规则。
- 普通子进程 Adapter 的覆盖必须按调用隔离并实际到达 Provider 及其启动的 `octo-cli`，不得修改全局 `process.env` 或把某个 Bot 的凭据设置到共享 AdapterHost 进程环境。无法按轮应用时，必须在工具执行前明确失败，不得声称覆盖成功。
- 普通子进程 Adapter 的 Token、API 地址及连接代次必须绑定同一连接。重连或配置替换后，新执行使用新连接配置；旧连接排队消息不得改用新 Bot 凭据。凭据不写入日志、状态、错误详情或提交。
- OpenClaw 例外：由 CLI 编排层按当前渠道配置，把这两个变量写入目标 OpenClaw 实际读取的全局 `.env`（通常为 `~/.openclaw/.env` 或 `$OPENCLAW_STATE_DIR/.env`）。复用 CLI 发现来源，必要时调用只读 `openclaw config file --json` 确认实例；不得在 Adapter/probe/invoke 中扫描或写文件。不同目标目录分别写入；同一文件按配置处理顺序后写覆盖前写，不拒绝多个 Bot 使用同一目标。只更新这两个变量，保留其他内容。Gateway 重启由人工处理，写入完成不表示正在运行的 Gateway 已生效。此路径使用实例共享身份，不承诺逐轮或逐 Agent 隔离；不向 OpenClaw 的每轮调用传入那两个内部覆盖项。
- Host/Adapter 只承载按调用传递的执行值，不读取 gateway 配置、不理解 OCTO 变量的业务来源。实现所需的内部传递扩展不得改变 Context v3、Run 7 或桌面调用方自行选择身份并使用 `envs` 的合同。
- `octo-cli` 是否安装及版本由 HostApp 决定。gateway 不因收到消息而隐式下载或安装工具。本节不保证 Provider 专用配置或工具显式重新设置环境后仍使用相同身份，也不把 workdir 当作凭据隔离沙箱。

## 回执与恢复

invoke/cancel/respond 保留命令回执，源流不增加逐事件 durable ACK。断流从同一 stream 的连续游标修复，不重新执行。Host 重启或窗口过期后如实报告失败，由业务方决定下一步。

Run 完成不等于 IM 发送成功。需要可靠投递的应用自行定义发送意图、目标消息 ID、重试与持久化，不要求 Host 增加传输数据库。当前内存会话及消息去重仅在容量和 TTL 窗口内生效，不承诺重启后恰好一次投递。

## 当前能力与验证边界

执行失败统一使用 CanonicalEvent run.failed。Host 的分类补充 failure，但保留 Adapter 返回的 message/error 等错误信息；执行状态整理不得只留下 failure 而裁剪原始错误。卡片统一显示“执行失败”，优先展示脱敏后的实际原因，错误码与诊断编号置于详情；没有实际原因时才使用目录摘要。不同 Adapter 不分别建立展示错误码表。

Node 的 spawn ENOENT 不能单独证明命令缺失；工作目录不存在也产生同一 errno。Host 遇到此类失败时核查 cwd，分别补充工作目录不存在、不是文件夹或没有进入权限的原因，不自动创建显式配置的目录。卡片长度和字节预算继续生效，不将凭据或完整配置作为诊断正文。失败终态卡片成功投递后不再重复发送错误文本；卡片不可用、超预算或终态投递失败时保留最终文本兜底。进度卡曾经送达不代表终态送达。

Octo 实现私聊、显式群/话题触发、可选规则与历史读取、typing、进度卡及最终文本；WeCom 使用自身 stream 回复协议。代码存在不表示这些场景均已完成线上闭环验收。

私聊、群聊、话题、卡片按钮、取消、真实审批和多端同步分别验收；fixture 或普通模型执行不能代替 IM 真实收发。Work App 的数据库格式、批写策略与唯一 preload 桥由宿主项目维护，不写成 Runtime 的存储实现。

## 核对入口

[Octo Extra](../../packages/octo-runtime-extra-channel-gateway/src/extra.ts)、[WeCom Extra](../../packages/octo-runtime-extra-channel-wecom/src/extra.ts)、[Octo 会话](../../packages/octo-runtime-extra-channel-gateway/src/application/im-channel.ts)、[im-runtime.test.js](../../test/im-runtime.test.js)、[im-wecom.test.js](../../test/im-wecom.test.js)、[channel-packages.test.js](../../test/channel-packages.test.js)。

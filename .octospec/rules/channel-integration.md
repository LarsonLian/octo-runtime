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

## 回执与恢复

invoke/cancel/respond 保留命令回执，源流不增加逐事件 durable ACK。断流从同一 stream 的连续游标修复，不重新执行。Host 重启或窗口过期后如实报告失败，由业务方决定下一步。

Run 完成不等于 IM 发送成功。需要可靠投递的应用自行定义发送意图、目标消息 ID、重试与持久化，不要求 Host 增加传输数据库。当前内存会话及消息去重仅在容量和 TTL 窗口内生效，不承诺重启后恰好一次投递。

## 当前能力与验证边界

Octo 实现私聊、显式群/话题触发、可选规则与历史读取、typing、进度卡及最终文本；WeCom 使用自身 stream 回复协议。代码存在不表示这些场景均已完成线上闭环验收。

私聊、群聊、话题、卡片按钮、取消、真实审批和多端同步分别验收；fixture 或普通模型执行不能代替 IM 真实收发。Work App 的数据库格式、批写策略与唯一 preload 桥由宿主项目维护，不写成 Runtime 的存储实现。

## 核对入口

[Octo Extra](../../packages/octo-runtime-extra-channel-gateway/src/extra.ts)、[WeCom Extra](../../packages/octo-runtime-extra-channel-wecom/src/extra.ts)、[Octo 会话](../../packages/octo-runtime-extra-channel-gateway/src/application/im-channel.ts)、[im-runtime.test.js](../../test/im-runtime.test.js)、[im-wecom.test.js](../../test/im-wecom.test.js)、[channel-packages.test.js](../../test/channel-packages.test.js)。

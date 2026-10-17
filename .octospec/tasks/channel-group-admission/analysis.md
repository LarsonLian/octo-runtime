---
type: Review
title: 群消息静默拒绝的事故根因与证据
description: 区分已证实的准入错误、部署影响和仍待核实的客户端收发结果。
tags: [channel, identity, testing, incident]
timestamp: 2026-10-17T00:00:00Z
---

# 修复前的结论与影响

本文保留调查时的行为与证据；当前目标合同以[处理计划](plan.md)为准，旧 [] 拒绝群的含义已经被用户否决。

**Gateway 的群范围判断将可选 group_ids 当成必填允许名单。** 不填写时，所有群/话题消息在调用模型前静默丢弃；私聊提前通过，不进入该判断。CLI 和 SDK 复用同一 GatewayTransport/acceptsImMessage，均受影响。它是 Channel 的配置与准入合同错误，修复归 Channel；没有证据要求修改 Context、loadContexts、SDK 桥接、AdapterHost 或 Provider 权限。

用户截图在 2026-10-17 的客户端时间 10:51、10:55 展示群中显式点名无响应，随后报告 CLI 同样发生。截图证明客户端展示了点名和未见响应，不独立证明实际下发的 mention 元数据。本次已用 im-test 真实历史报文隔离复现相同拒绝条件，未请求生产环境，也未读取或输出截图群正文。

| 条件 | 修复前行为 | 影响 |
| --- | --- | --- |
| 私聊，发送者已授权 | 沿原准入处理 | 用户已观察可以回复；不代表每个 Provider 均可用 |
| 群/话题，省略 group_ids，发送者和真实 @ 均合法 | 一律拒绝 | CLI 默认示例及同格式 SDK 配置均命中 |
| 群/话题，group_ids 为 [] | 拒绝 | 调查时旧合同如此定义；新合同改为不限制范围，禁用另用 groups_enabled |
| 群/话题，非空名单包含父群，其他准入合法 | 通过 | 可作为保持原权限的临时止损方式 |
| 未授权发送者、错误 Space、缺失真实 @ 或自身消息 | 拒绝 | 正常边界，不能为了恢复群聊而移除 |

本机 CLI 安装提交为 `6a4397d51091`，配置在不输出凭据的条件下确认省略 group_ids；服务地址指向正式环境，因此没有对该服务发起排障请求。SDK 宿主的实际完整配置、进程加载版本及截图消息原始元数据尚未核实；不推断所有无回复都只由这一处引起。显式空名单或名单外群本来就会被拒绝，需分别核对。

# 直接原因

[normalize.ts](../../../packages/octo-runtime-extra-channel-gateway/src/transport/normalize.ts) 当前逻辑：

```ts
if (message.channelType === 1) return contentSupported();
if (
  ![2, 5].includes(message.channelType) ||
  !config.group_ids?.includes(groupScope(message.channelId).groupNo)
)
  return false;
```

group_ids 省略时，可选链求值为 undefined，取反变为 true，触发拒绝。代码还没走到 mentionsBot 就已返回，后续 Context 准备、Host.invoke、typing、卡片和最终回复均不会启动。[channel.ts](../../../packages/octo-runtime-extra-channel-gateway/src/transport/channel.ts) 在准入失败时直接 return，因此用户只看到 Bot 在线却没有响应。

[配置 Schema](../../../packages/octo-runtime-extra-channel-gateway/config-schema.json) 明确写着“省略不按本项限制，空数组拒绝所有群/话题”。[CLI 示例](../../../CLI_USAGE_GUIDE.md)省略 group_ids，文档和实际执行互相矛盾。当前条件至少在历史提交 `ea1486fe` 中已经存在，早于本轮 SDK 函数装配提交 `28aa061`；不能将这次发现写成 loadContexts 改造引入的新回归。Schema 说明可追溯至 `0b00e4e0`，这里只记录可核对的历史，不以 Git 作者归因个人责任。

# 为什么此前测试没有发现

- 原有 mention 测试、图片准入和富文本准入 fixture 显式填写 group_ids，验证了名单命中后的 @ 行为，遗漏默认示例的字段省略路径。
- 既有真实测试脚本也显式填写测试群 ID，未按 CLI 文档的最小配置验证默认群聊。
- 此前安装验收中两个 Bot 是停用配置，只验证插件加载和配置错误；SDK 自动化验证函数、源流和生命周期，未完成真实 IM 收发。这些证据不能覆盖群消息入口。
- 生命周期 loaded、连接 online 只证明初始化/连接状态，不能证明任务被接纳。此次恰好在连接成功之后、执行之前静默拒绝，状态表面上仍正常。

相邻问题：Schema/README 将 allowed_sender_ids 省略写成“不限制”，实际代码和 F25 已确认设计为“仅 owner”。应纠正说明，保留现有 owner 默认；不将两个可选字段机械地改成相同默认权限。

# 本轮复现结果

1. [准入与 transport 回归](../../../test/im-mention-trigger.test.js)：当前实现共 5 项，原有 2 项通过，新增 3 项失败。失败覆盖省略/空/显式群范围、明确授权的非 owner，以及真实 GatewayTransport 转交和原地址回复；传输回归中私聊通过，随后群消息未进入回调。
2. [im-test 只读验证](../../../scripts/verify-channel-group-admission-live.mjs)：从已有 Channel_QA_ 群读取历史，选择包含当前 Bot 有效 mention 的非自身文本消息，保持其真实 payload；在重放配置中显式授权真实发送者，仅隔离群范围差异。显式群 ID 通过，省略群 ID 拒绝；空名单、名单外群、无授权、缺 @ 和错误 Space 均拒绝。
3. 线上验证发送消息数为 0，模型调用数为 0；没有新建群、连接生产 Bot 或修改服务端配置。该证据是“真实历史 payload 在本地准入函数重放”，不是实时 WS 入站或模型回复闭环。

复现命令（账号文件是受保护的本机文件，只传路径）：

```bash
node --test test/im-mention-trigger.test.js
OCTO_CHANNEL_QA_ACCOUNTS=/absolute/protected/accounts.md \
  node scripts/verify-channel-group-admission-live.mjs --expect-blocked
```

上面是修复前的历史复现命令，第二条当时成功表示验证了旧实现的拒绝缺陷，不代表事故已修复。当前验证脚本已经移除 --expect-blocked，直接验证新合同。第一条的 3 项失败是已登记的修复前结果，修复阶段必须全部转绿。

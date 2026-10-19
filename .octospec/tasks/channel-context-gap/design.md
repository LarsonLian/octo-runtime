---
type: Design
title: 群与话题缺口的固定API准备设计
description: 将缺口历史作为模型前固定业务输入，保留15条硬窗口、取消和有界状态合同。
tags: [channel, context, history, architecture, session]
timestamp: 2026-10-19T00:00:00Z
---

# 1. 架构定案

2026-10-19用户明确：模型工具调用走octo-cli；模型前固定流程走现有TypeScript API。ChannelGateway是业务Event发起方，历史与群/话题规则均在`build_im_contexts`中准备。API层只鉴权、传输、解码，不组装prompt；Host只消费已准备的快照，不管理历史。

不再生成`octo-cli message sync`的argv或“按需决定是否取材”的指引，不新增工具调用、子进程或关键词路由。额外历史调查、资源读取与副作用仍归Agent工具循环，不扩大固定准备职责。

# 2. 范围与真实输入

- 启用群/话题type 2/5，保留完整话题channel ID、认证Space/Bot及当前token；不扩大到父群或其他身份。
- 真实入站`messageSeq`与SENDACK/自身RECV的位置来自服务端同频道序号域，不把客户端发送计数或message ID当seq。
- 未 @ 只观察范围内的metadata，不创建binding、不延长TTL、不执行任务、不抓正文；执行准入继续按原sender和mention合同。
- 位置必须为1..4294967295的安全整数；缺失/回退不生成伪精确范围。部署域与可见性仍需M0证明，fixture不能替代。

# 3. 范围计算与固定请求

设本轮冻结触发位置为U，上次准备边界为L。队列在接收时冻结U，在开始准备时读取当前代次L，不以最新观察max替代U。

1. 候选区间为开区间`(L,U)`；若跨度全部由已确认同代次自身输出解释，输出none，不发历史请求。
2. 有待补边界时与L取较小值；未知基线或显式fresh_fallback使用bootstrap。序号跨度不是可读文本条数。
3. 已知缺口`limit=min(15,U-L-1)`；未知基线和冷启动`limit=15`。上限共用`IM_HISTORY_MESSAGE_LIMIT`。
4. 模型前直接调用`getChannelMessagePage`，POST `/v1/bot/messages/sync`：

```json
{
  "channel_id": "原始群或完整话题ID",
  "channel_type": 5,
  "limit": 2,
  "start_message_seq": 103,
  "end_message_seq": 101,
  "pull_mode": 0
}
```

此例L=101、U=104；start包含、end排除，只能保留102、103。未知下界end=0，不表示历史完整；U=1不请求，禁止将start=0当作正常冻结上界。

5. 群/话题本轮冷启动与缺口只走同一个读取分支，最多一次HTTP请求。10秒取消信号、1 MiB响应字节限制、禁用429自动重试，无分页或自动扩大范围；DM继续原30秒及429重试合同，不套用本次群/话题新策略。
6. 返回后按有效seq及冻结开区间过滤，按seq/ID去重，最新优先排序，再由代码截至15条；服务端忽略limit也不会把更多条目送入模型。
7. 只注入纯文本，不下载历史媒体或复制原始payload。旧到新展示，最新优先保留，总计1500 Unicode码点；边界裁剪加标记。

# 4. Context 与结果

`extra.im/history`保存真实来源、冻结上界、范围、裁剪后文本和truncated，仍是不可信背景。`extra.im/history-gap`只报告加载事实，不包含命令、凭据或要求模型修补固定流程的指令。

| status | 含义 |
| --- | --- |
| provided | API成功且实际正文进入当前快照；不等于模型已阅读 |
| partial | 正文已提供，但more未知/为true、更早记录省略、过滤/非文本或文本裁剪使覆盖不完整 |
| empty | API成功但无可用文本；不声称整个讨论区间不存在 |
| unavailable | 位置不可用，或API拒绝、超时、协议/网络错误；不把错误原文、token写入Context |
| omitted | 有可用正文但被显式同名项或Context预算排除；不声称已提供 |

完整状态项最多4096 UTF-8字节；压缩状态最多1024字节，再超预算可省略。显式业务项不截断、不覆盖，保留保留键冲突检查。执行默认项合并后若移除history，必须把剩余状态改为omitted/materialProvided=false，不重新读API。

# 5. 有界状态与提交点

- 复用现有binding的1024条/4 MiB/24小时及10秒清理；metadata也计入序列化预算，无旁路无限Map或正文持久库。
- `processEpoch/revision`隔离进程与原子更新；`latestObservedSeq`仅观察，`preparedTriggerSeq`仅表示本地交接；`localOutputSeqs`最多32条。
- `pendingAfterSeq`区分已知下界number和未知下界null。API失败、正文省略或Run失败时保留/合并；不是模型“未读债务”。删除旧advertised/unverified工具读取状态，不拦截工具输出。
- 第一次实际host.invoke交接处提交一次。只有API成功的正文仍在最终快照，或API确实返回无可用文本时，才清除待补边界；状态项存在本身不算成功。
- 取消/准备失败不推进交接边界。准备结束后冻结实际计划经身份/epoch校验的有效afterSeq，未知下界保留null，无需查询的none计划也保留已知下界。Run失败恢复该有效边界而非只恢复preparedTriggerSeq，避免补取成功清除旧pending后丢掉更早范围；下一次依旧只取最近15条。
- 原子patch合并最新观察字段，校验session/generation/epoch，不用旧session拷贝覆盖新位置，不创建已淘汰binding、不续TTL。

# 6. 并发、生命周期与重试

- SENDACK沿原始turn token及地址归属；旧输出、旧卡片或reset前回调不得更新新代次。自身RECV只观察，不执行任务。
- 同代次卡片重试沿现有有界occurrence复用原Context和输入，不读API、不重跑宿主动态Context、不推进新位置；过期快照按原合同拒绝。
- reset/重启/TTL/容量淘汰后不恢复旧游标。fresh_fallback只影响下一条新输入，不追加本轮API或模型调用。
- `/stop`取消准备阶段API并阻止host.invoke；API自身10秒超时则记录unavailable并继续本轮任务，不能混同用户取消。
- 自定义store无可选原子patch能力时保守走未知基线窗口，不虚构精确状态；DM与其他Channel合同不变。

# 7. 证据与上线门槛

自动化只使用本地fake API、加密WS和fake Provider，验证真实调用顺序、冻结输入、限制及错误传播。部署环境的未 @ 可见性、WS/sync同域、端点、more及自身卡片位置仍待授权im-test验收。真实Agent验证的是使用已提供Context并如实说明缺口，不再要求它先调用CLI。详见[矩阵](test-plan.md)与[实施](implementation.md)。

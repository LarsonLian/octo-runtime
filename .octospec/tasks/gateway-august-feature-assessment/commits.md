---
type: Guide
title: 旧 Gateway 2026 年八月非合并提交台账
description: 保存比较窗口内的完整提交身份与时间，用于追溯特性演进和已替代的中间方案。
tags: [channel, assessment, git, history]
timestamp: 2026-10-16T00:00:00Z
---

# 提交范围

参考仓：`/Users/lvsijia/codex.mlamp.cn/dmwork/octo-agent-gateway`。

HEAD：`79c08e51e1676c9795ae7c44eb22755e4a081d83`；7 月末基线：`1b7305f9097cd7bd6ce23720d89f2e6469641400`。本地 main 的可达历史中，按提交时间筛选北京时间 2026 年 8 月，去除 merge，共 **170 条**。保留作者时间与提交时间，避免把 8 月 17 日编写、后续提交的 DSH 变更排错。顺序为 Git reverse 遍历顺序，不承诺按作者时间严格排序。

类型统计（按提交标题，不等于特性数量）：feat=62，fix=61，docs=35，test=6，refactor=2，chore=3，perf=1。

合并提交不重复计入特性；最终合并节点仍固定在上述 HEAD。完整特性判断见[评估表](assessment.md)，范围与当前授权见[简报](brief.md)。本台账不是历史使用方锁定依赖版本或线上部署证据。

复核命令（在参考仓执行）：

```bash
git log 79c08e51e1676c9795ae7c44eb22755e4a081d83 --no-merges \\
  --since=2026-08-01T00:00:00+08:00 \\
  --until=2026-09-01T00:00:00+08:00 \\
  --format='%H%x09%aI%x09%cI%x09%s' --reverse
```

## 全量台账

| SHA | 作者时间（原时区） | 提交时间（原时区） | 提交标题 |
| --- | --- | --- | --- |
| `eb25042310bdc04111c74511a2368e73909e3268` | 2026-08-01T10:20:51+08:00 | 2026-08-01T10:30:30+08:00 | feat(openclaw): 接入 agent 工具流 → 进度卡(#19) |
| `3dc8a2b67a0d082ef45eb8fbbb1e268394e8ada8` | 2026-08-01T11:55:25+08:00 | 2026-08-01T11:55:25+08:00 | feat(feedback): 接入实时反馈——已读回执/typing/REST 心跳 |
| `bd14d7c89c5a45a8a6f1be6149243c748528f3a2` | 2026-08-01T12:02:35+08:00 | 2026-08-01T12:02:35+08:00 | fix(feedback): 硬化 best-effort 边界——同步抛/异步拒绝/心跳重入全隔离 |
| `369823ae8d0b579cb281d25f6e13cf565444e422` | 2026-08-01T12:02:35+08:00 | 2026-08-01T12:02:35+08:00 | feat(inbound): 入站引用/回复注入本轮上下文 |
| `64e0e63fda619a39a9ab6e8a0d1266532a633513` | 2026-08-01T12:08:03+08:00 | 2026-08-01T12:08:03+08:00 | fix(feedback): 用 Promise.resolve 收编任意 thenable,吸收无 catch 的拒绝 |
| `297e804e2c30f3634f898bf723ef44c4e817764d` | 2026-08-01T13:05:24+08:00 | 2026-08-01T13:05:24+08:00 | feat(memory): 群史注入 /new reset watermark(重置点为界) |
| `dcc30c5afcda95e97670a3be901b42fec7926bed` | 2026-08-01T13:14:04+08:00 | 2026-08-01T13:14:04+08:00 | fix(memory): reset watermark 有界 LRU + 查询异常隔离 + ts 溢出防护 |
| `1140335b40bc4613ceb2d75a87c6a46a017ae596` | 2026-08-03T10:09:27+08:00 | 2026-08-03T10:09:27+08:00 | feat(inbound): 多模态消息文本归一(图片/语音/文件/富文本/合并转发/交互卡) |
| `6c6f10b5031582fad95a8a8c22e455bb4a6025fc` | 2026-08-03T10:16:42+08:00 | 2026-08-03T10:16:42+08:00 | fix(inbound): 多模态归一硬化——递归上限/脏数据不抛/位置别名/命令解析范围/前缀互斥 |
| `944818e47627f423390cba15afcbc2b2197b58e3` | 2026-08-03T10:41:40+08:00 | 2026-08-03T10:41:40+08:00 | feat(inbound): 媒体提取 + 透传基础(B1b-1,为四家读图/PDF 铺路) |
| `524e805313707ea1397f2fd156268cc9e46dc438` | 2026-08-03T10:50:29+08:00 | 2026-08-03T10:50:29+08:00 | feat(cc): cc 读图片——下载媒体作 Claude 视觉附件(B1b-2) |
| `38481291f632dd5c7eccce00792c3be5d7581da3` | 2026-08-03T11:08:20+08:00 | 2026-08-03T11:08:20+08:00 | fix(media): 下载流式防 OOM/泄漏 + cc 附件限额 + PDF 判定/mime + cc 读 PDF(B1b-2 硬化 + B1b-3) |
| `9599ebdc3bd9b79171c1598664a8d73831f3af2d` | 2026-08-03T11:24:18+08:00 | 2026-08-03T11:24:18+08:00 | feat(openclaw): openclaw 读图/PDF——agent 请求带 attachments(B1b-4) |
| `22bd51cdc48ae7a7f09a33d2183b58039a10f737` | 2026-08-03T11:41:15+08:00 | 2026-08-03T11:41:15+08:00 | feat(outbound): octo_send_file 发任意本地文件(图片 type=2 内联/其它 File type=8)(B1b-7) |
| `d391ff4bfd09dd3771f9d659e988cf5db2f2caa6` | 2026-08-03T11:46:51+08:00 | 2026-08-03T11:46:51+08:00 | feat(codex): codex 读图/PDF——app-server localImage input 项(B1b-4) |
| `b875724cc785435ddab367f04b4a733e2daa7f57` | 2026-08-03T12:11:30+08:00 | 2026-08-03T12:11:30+08:00 | fix(media): B1b 媒体能力硬化(静态审查 5 blocker) |
| `788c6ccec86743ba74dfb3feca9bd742a8dc29c1` | 2026-08-03T14:13:01+08:00 | 2026-08-03T14:13:01+08:00 | fix(codex): 去 PDF 本地路径 fallback,收窄跨会话越权向量(B1B-003 收窄) |
| `e8a1266710aec08a34d0425a8b8fe1ed83f83885` | 2026-08-03T14:13:51+08:00 | 2026-08-03T14:13:51+08:00 | docs(b1b): 落地状态 + tracked 后续(读图3/4/上传/hermes阻塞/above-benchmark加固) |
| `8acce4fc4aee2129f8741c39999956aaf3f73306` | 2026-08-03T14:18:08+08:00 | 2026-08-03T14:18:08+08:00 | fix(codex): 媒体下载接入取消——AbortController 登记 mediaAborters,cancel 中止(B1B-004) |
| `920cab456e49900379511c1a5bfd97d695ffce8d` | 2026-08-03T14:31:16+08:00 | 2026-08-03T14:31:16+08:00 | feat(openclaw): 入站图片经 agent RPC attachments 下发,openclaw 原生读图 |
| `296c641d367ec70e6e20f9dde47ddf39430136d2` | 2026-08-03T14:48:04+08:00 | 2026-08-03T14:48:04+08:00 | fix(octo): postJson 对 429 限流按 retry_after 退避重试 |
| `93d60f8a2ef5a09aa65052739dedebf373e07c8c` | 2026-08-03T14:53:08+08:00 | 2026-08-03T14:53:08+08:00 | docs(b1b): openclaw 读图 live 验证通过 + 运维前置(模型 input 加 image/gateway restart) |
| `b2cd95adee536f3fb5474276ab9972a59c2ef128` | 2026-08-03T16:14:11+08:00 | 2026-08-03T16:14:11+08:00 | docs(capability): #36 收尾 spec——原子切换/逃生舱/红队 + 待拍板安全姿态 |
| `7cb37cb0acc69ec7c62c962608a360170eb1a592` | 2026-08-03T17:06:17+08:00 | 2026-08-03T17:06:17+08:00 | docs(capability): 锁定安全姿态(保守/opt-in)+ R1 红队清单 + R3 runtimeNative 定界 |
| `2114438ec85037869afd6a49134a059d5af5a10b` | 2026-08-03T17:40:56+08:00 | 2026-08-03T17:40:56+08:00 | test(capability): 补红队测试缺口 + allowSenders 非空 schema 加固 |
| `5f95f4b7dfd71bfffe8360eb61335fd947a421c6` | 2026-08-03T18:18:00+08:00 | 2026-08-03T18:18:00+08:00 | refactor(capability): 原子切换——去 OCTO_RETIRE 门,活跃/锁死只由 capability.tier 决定 |
| `1cd12b16b23489a8a18b1a26a0a219e56b386e92` | 2026-08-03T18:18:58+08:00 | 2026-08-03T18:18:58+08:00 | docs(capability): 标记 R2 原子切换完成 + R1 代码级红队通过 |
| `c6bb5c393b250726795e70beb3405c79e43310f6` | 2026-08-03T20:22:39+08:00 | 2026-08-03T20:22:39+08:00 | feat(card-action): PR4 dispatch 闭环 + 端到端启用(dormant,flag 默认关) |
| `fa7ecd5f82cbd1cb7c21b11850e47663635dd620` | 2026-08-04T09:55:03+08:00 | 2026-08-04T09:55:03+08:00 | feat(card-action): 跨进程单写者锁实现(dormant,activation barrier 用) |
| `2c6c9b06a6dc035ea55b9b6efd2c7a6d9a24cd26` | 2026-08-04T10:07:54+08:00 | 2026-08-04T10:07:54+08:00 | feat(card-action): store node fs 适配 + cursor 持久化(dormant) |
| `3b2167dce0e53dde871fad003ece74b90070d3aa` | 2026-08-04T17:58:29+08:00 | 2026-08-04T17:58:29+08:00 | feat(card-action): 共享 CardSessionStore 的 slice 装配工厂(dormant) |
| `df6a1e5ea6a2c308704afbd96bcffaaa5db78892` | 2026-08-04T18:30:07+08:00 | 2026-08-04T18:30:07+08:00 | docs(card-action): T5 authoring 工具 + host-service 注入 spec(让 card_action 可用) |
| `b9655a270a61371df0adc046b4953273bc3b6a46` | 2026-08-04T18:38:47+08:00 | 2026-08-04T18:38:47+08:00 | feat(card-action): T5-1 REST InteractiveCardTransport + caps 适配(dormant,纯新增) |
| `1a33262dfe7c1810628afc19d07014dfc9ca3202` | 2026-08-04T18:43:59+08:00 | 2026-08-04T18:43:59+08:00 | feat(card-action): T5-2 senderUid 链路——入站穿到 ExecCtx(加性,dormant) |
| `abec44496d6e61ff6c479cab6b06d8a1bf29f360` | 2026-08-04T18:52:36+08:00 | 2026-08-04T18:52:36+08:00 | feat(card-action): T5-3 host-service 注入收敛四 adapter(加性,dormant) |
| `81c1284b5a852e3d0a3e8b03514ea0050570fe1b` | 2026-08-04T19:18:07+08:00 | 2026-08-04T19:18:07+08:00 | feat(card-action): T5-4 交互卡 authoring 工具 + authPolicy gateway 生成 + flag gating |
| `3f012af059d4c711eaf808642f4a789233232635` | 2026-08-05T10:34:25+08:00 | 2026-08-05T10:34:25+08:00 | chore: 移除误提交的 node_modules 符号链接 + .gitignore 收紧防复发 |
| `3717bd56b3a46432a6aa20c772f3b8a5ed0c5800` | 2026-08-05T11:09:53+08:00 | 2026-08-05T11:09:53+08:00 | feat(card-action): codex/hermes broker 注入 authoring service(加性,dormant) |
| `33df79f42755d1674045745a62d340197e060ff6` | 2026-08-05T14:31:30+08:00 | 2026-08-05T14:31:30+08:00 | docs(parity): 桌面真源 vs 实现覆盖审计(2026-08-05)+ 刷新 parity TODO 状态指针 |
| `7d114f76ea46998c85d816828b7a08b73fab0aeb` | 2026-08-05T14:37:44+08:00 | 2026-08-05T14:37:44+08:00 | docs(b2): 主动发送/跨会话目标路由 spec(照 openclaw 复刻 + 显式化 bot-membership 作用域) |
| `c4a8c6ec036626fd4a9e16337c0d4cbd259a4e2e` | 2026-08-05T14:43:29+08:00 | 2026-08-05T14:43:29+08:00 | feat(b2): 出站 target 解析纯函数(照 openclaw parseTarget,dormant) |
| `4aba806db5bbf2c5874c4d47c5c853b7ef1583fc` | 2026-08-05T14:49:55+08:00 | 2026-08-05T14:49:55+08:00 | feat(b2): thread→父群泄漏护栏 applyThreadParentGuard(照 openclaw,dormant) |
| `67bd6aa279d2b9f6d1e06a7c6e36dfe822eb4ae9` | 2026-08-05T15:14:22+08:00 | 2026-08-05T15:14:22+08:00 | feat(b2): send-side bot-membership 作用域校验 checkOutboundScope(照 openclaw 显式化,dormant) |
| `4138e7a152d6b607e2f35d243fd68cb974185d86` | 2026-08-05T15:21:07+08:00 | 2026-08-05T15:21:07+08:00 | feat(b2): 多附件部分失败语义 sendMediaBatch(照 openclaw failedMedia,dormant) |
| `a76cdca598222399ad0bb06a417f28cc7bf08827` | 2026-08-05T15:25:19+08:00 | 2026-08-05T15:25:19+08:00 | feat(b2): 出站 @mention 渲染 + sanitize(照 openclaw mention-utils,dormant) |
| `745b8289dc4f186d04fe820b2cbe247200347467` | 2026-08-05T15:26:48+08:00 | 2026-08-05T15:26:48+08:00 | docs(b2): 记录 B2-1..B2-5 落地 + B2-6 接线决策待定 |
| `8aa7cefdd2f6638e4c842d56e4ea2bd9d665ea30` | 2026-08-05T17:33:29+08:00 | 2026-08-05T17:33:29+08:00 | test(mention): 补数组索引非空守卫,恢复 type-check 全绿 |
| `02766359a180ffdcbc7ffec81590c55e0858de06` | 2026-08-05T17:33:29+08:00 | 2026-08-05T17:33:29+08:00 | feat(b2): 跨会话主动发送工具 octo_message_send_to(照 openclaw,flag-gated dormant) |
| `f84c115484b35db55cf234daf6c11658eecffbe7` | 2026-08-05T17:34:23+08:00 | 2026-08-05T17:34:23+08:00 | docs(b2): 记录 B2-6 落地(flag-gated dormant 跨会话发送工具) |
| `40bd1dc42af5fc2998fdafb506c7b51f867ebb24` | 2026-08-05T18:22:25+08:00 | 2026-08-05T18:22:25+08:00 | fix(b2): 跨会话发送加固——执行边界 flag 门控 + DM 歧义护栏 + 输入校验 |
| `c399f0bbcda6e1c3a224dd180e909acf064d3829` | 2026-08-05T18:45:10+08:00 | 2026-08-05T18:45:10+08:00 | fix(octo): harden cross-session send gating with in-code double-gate + fail-fast |
| `8217c8cf19c5f7b6a9ae99186b66a5713d3b3a8a` | 2026-08-05T19:06:33+08:00 | 2026-08-05T19:06:33+08:00 | fix(octo): fail-fast malformed targets + empty content, skip needless member prefetch |
| `75156bb2a6e1ecdfb74918b86ca55d4dc347c045` | 2026-08-05T19:16:36+08:00 | 2026-08-05T19:16:36+08:00 | fix(octo): reject empty DM/group targets in structure validation before owner bypass |
| `45d2cc451cca89b270471f476ef067043e9f586d` | 2026-08-06T16:20:43+08:00 | 2026-08-06T16:20:43+08:00 | docs(layout): gwHome 目录布局收敛 + workspace 落地方案 |
| `338f4a8aea1065f107d9a44bc667eedf2826e391` | 2026-08-06T16:28:59+08:00 | 2026-08-06T16:28:59+08:00 | docs(layout): 注入性/权限落地/单写者锁/codex engine root 分离 |
| `44b208647bfb9365783326d997cf0b2f7e890fa6` | 2026-08-06T16:38:01+08:00 | 2026-08-06T16:38:01+08:00 | docs(layout): 原子认领标记/受管根语义/pidfile 单实例/PR 顺序修正 |
| `d8daff1aa13d6dcd54f6918d9ca37d067cda670a` | 2026-08-06T16:49:26+08:00 | 2026-08-06T16:49:26+08:00 | docs(layout): 威胁模型修正/link 发布标记/launcher 准入/pidfile 去自动接管 |
| `b939a35fec368c77402b8ff82dfc7f95969d1209` | 2026-08-06T17:08:42+08:00 | 2026-08-06T17:08:42+08:00 | docs(layout): 收口范围——会话锚点保留 runtime 后缀,进程互斥与 stop 协议移出本设计 |
| `65e4d844d1b77c5bc3568cbc0e8809aca6922708` | 2026-08-06T17:13:39+08:00 | 2026-08-06T17:13:39+08:00 | docs(layout): runtimeId 闭集校验 / 安全异常不被降级吞掉 / launcher 先认领再建日志 |
| `01a22306c2fb0aac999d43814d67723459660877` | 2026-08-06T17:16:06+08:00 | 2026-08-06T17:16:06+08:00 | docs(layout): 修正 runtimeId 校验点的现状描述 + 统一非目标措辞 |
| `dbf359a7943f66a0cf8721cb6ce5a4e6229a5208` | 2026-08-06T17:19:57+08:00 | 2026-08-06T17:19:57+08:00 | feat(deploy): 新增 gwHome / workspace 路径派生模块 |
| `d582e58042b0dc4c2172e205dced493e7b74eabd` | 2026-08-06T18:08:32+08:00 | 2026-08-06T18:08:32+08:00 | docs(agent-exec): octo 能力面交给 agent 自执行(octo-cli + 内嵌 skill)方案 |
| `fc2430e8eca4cec5c76a0482dc12f0092518ddfe` | 2026-08-06T18:22:14+08:00 | 2026-08-06T18:22:14+08:00 | docs(agent-exec): 按目标重定范围(长尾交 agent / 核心留网关) |
| `6d6fdc60eea7b90df08b69c00d724df2d3808426` | 2026-08-06T18:24:53+08:00 | 2026-08-06T18:24:53+08:00 | feat(deploy): secure-fs——受管根内的安全目录/文件创建 |
| `e2d9558a17b83cdfddf00931336809ba1a3f88d9` | 2026-08-06T18:26:26+08:00 | 2026-08-06T18:26:26+08:00 | docs(agent-exec): 修 deny-shim 的绕过面 —— api passthrough 与真实二进制直调 |
| `5ca2dc498ad605559af0ef2c307b4b49891611cf` | 2026-08-06T18:27:57+08:00 | 2026-08-06T18:27:57+08:00 | docs(agent-exec): 记录本设计顺手关掉的两个 parity 缺口 |
| `5519de2825b0c4f75a333564ddcb7a64b90c17cd` | 2026-08-06T18:31:00+08:00 | 2026-08-06T18:31:00+08:00 | feat(deploy): 目录归属认领 —— 明文进路径必须自带的那层校验 |
| `0d59d825f85af9a42545a79fbd1d34c2ac4e8364` | 2026-08-06T18:34:30+08:00 | 2026-08-06T18:34:30+08:00 | docs(agent-exec): 按 openclaw 逐项事实收窄到"出站消息与文件" |
| `666e1c9e564aa58bf41d721bb7821b938072366b` | 2026-08-06T18:45:35+08:00 | 2026-08-06T18:45:35+08:00 | docs(agent-exec): 收敛到最小真实范围(仅 message send,openclaw 排除) |
| `fc91aa999668c64531cc7326190e5c99a41a6340` | 2026-08-06T18:56:34+08:00 | 2026-08-06T18:56:34+08:00 | docs(agent-exec): 两条目标在 shim 层存在结构性矛盾,方案按服务端能力分支化 |
| `4326302f277d2646d523807940b3fbd65bf17566` | 2026-08-06T19:10:14+08:00 | 2026-08-06T19:10:14+08:00 | feat(octo): 补 5 项 openclaw parity 缺口(resolve / voice-context / thread 删除) |
| `67dab52eb585e2491e2b1553148025e67ad34693` | 2026-08-06T19:14:24+08:00 | 2026-08-06T19:14:24+08:00 | feat(octo): 发图片带 width/height —— 补最后一处文件发送 parity 差 |
| `eb4d0e39f43d10640e3f018af12e4b166520f18e` | 2026-08-06T19:19:35+08:00 | 2026-08-06T19:19:35+08:00 | feat(deploy): agent 侧 octo-cli shim 的准入决策(默认拒绝 + 出站发送放行) |
| `b2eba5c6702adb84d23c44ea3b42617de491c601` | 2026-08-06T19:20:51+08:00 | 2026-08-06T19:20:51+08:00 | feat(deploy): shim 的 --data 取值解析器(inline / @file / @-) |
| `87bfa16ba23ff221a1f0d53d772b08a097693f7e` | 2026-08-07T09:53:45+08:00 | 2026-08-07T09:53:45+08:00 | feat(session-store): 锚点文件名带 runtimeId + 归属校验 fail-fast + 安全异常不被降级吞掉 |
| `6cce3e75fc9f8b95b4992f813a2b5e4da4b36db5` | 2026-08-07T09:57:18+08:00 | 2026-08-07T09:57:18+08:00 | feat(history-store): 历史落 bots/&lt;botUid&gt;/sessions/history/ + 安全异常不被 sticky 降级掩盖 |
| `a54fef0f1388ed00747f3c7d74e85822b9a2be4a` | 2026-08-07T10:01:03+08:00 | 2026-08-07T10:01:03+08:00 | refactor(deploy): shim 策略从默认拒绝翻为默认放行 + 极小黑名单 |
| `47b182f06a7c839ba564fb39009def826012224f` | 2026-08-07T10:04:30+08:00 | 2026-08-07T10:04:30+08:00 | feat(deploy): shim 可执行体 + 端到端测试(策略真正落地为可用的 octo-cli) |
| `0907f9571781d3693f05343b9aeaeaefc876239b` | 2026-08-07T10:07:09+08:00 | 2026-08-07T10:07:09+08:00 | feat(secure-env): agent-exec 的单一追加点(shim 进 PATH,凭据仍不进 env) |
| `30864a1150893fd72472d49427b2f98c147ef3a0` | 2026-08-07T10:10:56+08:00 | 2026-08-07T10:10:56+08:00 | feat(deploy): agent-exec 装配期物化(shim 软链 + agent profile 下发) |
| `7a6a400cd0f0add96f9fc227b1930ebf89caf750` | 2026-08-07T10:19:43+08:00 | 2026-08-07T10:19:43+08:00 | feat(slice): 接通 agent-exec —— agent 可真敲 octo-cli(OCTO_AGENT_CLI=1 opt-in) |
| `65fe0c4c9d9aa4a8ce134fd4a67a3beb56e92516` | 2026-08-07T10:25:49+08:00 | 2026-08-07T10:25:49+08:00 | feat(deploy): skill 索引注入 —— agent 知道能用 octo-cli、文档在磁盘哪儿 |
| `dfe196d22cf5b2b9c328849ab7e982ba8fe02beb` | 2026-08-07T11:07:34+08:00 | 2026-08-07T11:07:34+08:00 | feat(config): agentCli 开关落 config.json(agent 自执行 octo-cli 的权威开关) |
| `1c2743b23bef99a2431930d2215a53e82092571a` | 2026-08-07T11:19:34+08:00 | 2026-08-07T11:19:34+08:00 | fix(runtimes): 转发子进程 stderr,别把 agent-cli 审计行丢掉 |
| `20e170a93c3e0b16d292304f3f57924d89be33c8` | 2026-08-07T11:25:33+08:00 | 2026-08-07T11:25:33+08:00 | fix(shim): 收口子进程 env —— 抵御 shell rc 把 OCTO_* 注回来 |
| `e7a5395432b334a87454f4eed8c90839c626781d` | 2026-08-07T11:28:07+08:00 | 2026-08-07T11:28:07+08:00 | perf(shim): 导子路径而非 barrel —— 单次 CLI 调用少 ~180ms |
| `1ef14d9d75fa10068e82550bb7d0b5cec54b9245` | 2026-08-07T11:43:44+08:00 | 2026-08-07T11:43:44+08:00 | docs(agent-exec): 去掉 CLI shim,agent 直接用真实 octo-cli |
| `2536b98e9ecda69a88b7792c86ccdd05d2067c1b` | 2026-08-07T12:19:33+08:00 | 2026-08-07T12:19:33+08:00 | docs(agent-exec): 方案改为无策略 wrapper —— 钉死身份与地址,不做准入判定 |
| `2a07c21a8c9097f67f1476d9f8dd646c16261102` | 2026-08-07T12:45:24+08:00 | 2026-08-07T12:45:24+08:00 | docs(agent-exec): wrapper 只用 shell 内建;修正与 openclaw 的暴露面对比 |
| `dd0bebdcc1e6423ae637e2ffed6346db6b71fa26` | 2026-08-07T12:54:17+08:00 | 2026-08-07T12:54:17+08:00 | feat(agent-exec): 去掉准入层,agent 直接用真实 octo-cli(经无策略 wrapper) |
| `f8155894d6863ad143e231a23f69d0ac1d491ab1` | 2026-08-07T12:58:32+08:00 | 2026-08-07T12:58:32+08:00 | fix(agent-exec): unset 列表改用源码派生的权威全集;畸形值前置校验 |
| `1e4d029af4beaabcd906228a898deb629878e40b` | 2026-08-07T13:03:13+08:00 | 2026-08-07T13:03:13+08:00 | fix(secure-fs): 写入循环到写满;临时文件用 dev+ino 绑定;build 前清 dist |
| `93fd2ff0d9caf0253dc93153da1063f27f7d9e6e` | 2026-08-07T13:06:17+08:00 | 2026-08-07T13:06:17+08:00 | fix(agent-exec): 补 PATH→wrapper 端到端覆盖;守卫跟着数据走;PATH 分隔符校验 |
| `8bd161ca7b7f4768480ea609eb3d7ad0569e7687` | 2026-08-07T13:12:04+08:00 | 2026-08-07T13:12:04+08:00 | fix: 更正 tmp 残留的注释;收紧 wrapper 无外部命令的不变式 |
| `d0a610fa5168f6effc0df625bb93ef28a0cf759a` | 2026-08-07T14:21:28+08:00 | 2026-08-07T14:21:28+08:00 | fix(agent-exec): 指引改给 CLI 绝对路径 —— PATH 前置在 macOS 上不可靠 |
| `a0fcde4c8f0c364487156a91a0e4cc2706227e78` | 2026-08-07T14:36:25+08:00 | 2026-08-07T14:36:25+08:00 | feat(agent-exec): openclaw 也纳入 —— 排除它的前提已不成立 |
| `0230109d1122c99770c15be856031b01c706a495` | 2026-08-07T14:45:46+08:00 | 2026-08-07T14:45:46+08:00 | fix(agent-exec): 导出的 skill 文档就地改写为 wrapper 绝对路径 |
| `89c56e088b3019e13087bae702cdf872e28f7583` | 2026-08-07T15:07:08+08:00 | 2026-08-07T15:07:08+08:00 | feat(config): botUid 大小写折叠唯一性校验 |
| `d11b396ca284da85196d12e614a00417e9adae3f` | 2026-08-07T15:15:43+08:00 | 2026-08-07T15:15:43+08:00 | feat(deploy): slice 日志按 bot 落盘 —— bots/&lt;botUid&gt;/logs/slice.log |
| `675d25e86da659535e6f10b7217a41e99006f075` | 2026-08-07T15:20:25+08:00 | 2026-08-07T15:20:25+08:00 | feat(capability): host.workspace 解析与校验(消费闸按 runtime 分别解) |
| `38f8cd433d7e81ab30de16003c65f48e514c03b5` | 2026-08-07T15:33:17+08:00 | 2026-08-07T15:33:17+08:00 | feat(cc): 逐会话工作目录 —— cwd = &lt;workspaceRoot&gt;/&lt;botUid&gt;/&lt;会话目录名&gt; |
| `b11a360325800a20a9ce880c71ad5e75ba169a73` | 2026-08-07T15:52:50+08:00 | 2026-08-07T15:52:50+08:00 | feat(codex): 逐会话持久 workspace 与 engine 临时根分离 |
| `6cfe3e8c6e04186946f759f1138449bfd63a2c48` | 2026-08-07T15:59:24+08:00 | 2026-08-07T15:59:24+08:00 | feat(hermes): 逐会话工作目录;HOME 与 cwd 解耦 |
| `1a8dafdaab651dcc777f72ff58ce0aa1097e9515` | 2026-08-07T16:03:52+08:00 | 2026-08-07T16:03:52+08:00 | feat(sendFile): 禁发根跟随实际 gwHome,并对根做 realpath 规范化 |
| `c451b88df454466756f23d9dcf0ec12c25a7c9b6` | 2026-08-07T16:07:50+08:00 | 2026-08-07T16:07:50+08:00 | test(deploy): workspace 隔离的验收门 + spec 与实现对齐 |
| `cb15c7e289c06a0e4488795d8477b4383d33c029` | 2026-08-07T16:22:51+08:00 | 2026-08-07T16:22:51+08:00 | fix(codex): 主动 kill 兜底后按取消收束,不把内部诊断当失败原因 |
| `ea60cc6d98ac71a0073e3a513e027d079c6c272d` | 2026-08-07T16:27:19+08:00 | 2026-08-07T16:27:19+08:00 | chore: 清理遗留的过程痕迹(全局硬规则) |
| `bb7079df44be83c454faebd4e8507f33b3b66c48` | 2026-08-07T16:37:18+08:00 | 2026-08-07T16:37:18+08:00 | docs(capability): 入站门禁改 groupPolicy 的方案 |
| `cc70e7c7ed154956d71d56f6c4ca96a874a3bbd9` | 2026-08-07T16:44:14+08:00 | 2026-08-07T16:44:14+08:00 | feat(capability): 入站门禁改 groupPolicy —— 消除"拉进新群就哑" |
| `431fc042b40be44247e07dc9fdee96fb4377abc5` | 2026-08-07T17:16:19+08:00 | 2026-08-07T17:16:19+08:00 | feat(octo): 启用跨会话主动发送,移除网关侧成员域门 |
| `b7af32001ba000625afb0bb927d572406e5229b5` | 2026-08-07T17:53:36+08:00 | 2026-08-07T17:53:36+08:00 | fix(gateway): 恢复发布门禁 —— stop 等资源释放 + 测试发现范围收口 |
| `1ab61f18f37456b43de48517b47e040976750b15` | 2026-08-07T18:03:40+08:00 | 2026-08-07T18:03:40+08:00 | fix(memory): 子区历史与父群隔离 —— 历史按会话 channel 缓存 |
| `883946c51794fcd9cfeca9352d0ffaac4dd97d55` | 2026-08-07T18:08:42+08:00 | 2026-08-07T18:08:42+08:00 | fix(memory): 历史刷新链必须与软超时 race,失败走负缓存 |
| `f2934de6a5150f73e591d8e1712f02bd0d97ff57` | 2026-08-07T18:18:30+08:00 | 2026-08-07T18:18:30+08:00 | feat(deploy): per-bot 单实例锁 + launcher ready 门 + 身份校验的 stop |
| `fabb31e2e7c795790e8b4323835c94b384dda0a9` | 2026-08-07T18:37:19+08:00 | 2026-08-07T18:37:19+08:00 | feat(gateway): 单轮上限 + 有界队列 + 过载带外反馈 |
| `4f147637d01e09cd1876b31a693a383dce4d383d` | 2026-08-07T19:10:08+08:00 | 2026-08-07T19:10:08+08:00 | fix(deploy,gateway): 锁的接管必须互斥;停机不发信号;上限覆盖准备阶段与出站 |
| `596950c1d600edc31d84b9a14fd925cb7b945df3` | 2026-08-07T19:24:19+08:00 | 2026-08-07T19:24:19+08:00 | fix(deploy,gateway): 接管锁不按时间强抢;停机不发裸信号;预算耗尽即超时 |
| `ee80dfb3816ad8f647b8e916584bf18a3ef43dda` | 2026-08-07T19:39:17+08:00 | 2026-08-07T19:39:17+08:00 | fix(deploy,gateway): stop 不删接管锁;准备阶段抛错也要有终态;超时后归还串行屏障 |
| `155e8675bd5662e8f18fc1cf50260d0e89bed0d5` | 2026-08-10T10:16:11+08:00 | 2026-08-10T10:16:11+08:00 | fix(deploy,gateway): 停机先关入站;launcher 部分失败回滚;历史读失败不再伪装成空 |
| `cdbf27b1c909d91666794c20fae885c5c1ab382b` | 2026-08-10T10:23:58+08:00 | 2026-08-10T10:23:58+08:00 | fix(octo): artifact 出站收口到会话 workspace(正向 allowlist) |
| `ea1579477c269174970f9a4dc9c282403495533b` | 2026-08-10T10:42:06+08:00 | 2026-08-10T10:42:06+08:00 | feat(qa): 首测入口成型 —— 可用配置样例 + 唯一 runbook + readiness 等真握手 + 回滚所有存活 slice |
| `29e310c8b9b2a1d9ec10226f18a21cd2504b7c4b` | 2026-08-10T10:46:09+08:00 | 2026-08-10T10:46:09+08:00 | fix(gateway): 重置是否生效与本次交互终态分离;注入已知 bot 名单 |
| `ea0987ec7c9a15fbf491350244ba13b94c9bfafe` | 2026-08-10T10:47:26+08:00 | 2026-08-10T10:47:26+08:00 | docs: 记录首测入口的三个 P0 整改与 live 验收结论 |
| `34af293367c3bba5daa04455d4fb371697ab8f0b` | 2026-08-10T11:22:26+08:00 | 2026-08-10T11:22:26+08:00 | docs: 记录落盘布局与自身契约的不一致,并在 runbook 加"每 runtime 一个 bot"约束 |
| `8e0b3b76751fe6e419261c387e08cf83bcbcf1e2` | 2026-08-10T11:31:47+08:00 | 2026-08-10T11:31:47+08:00 | fix(deploy): 就绪预算统一;连接态不再 latch;回滚覆盖 spawn 中途与无锁存活;身份强校验 |
| `36d74eba8c3fcca0c572f98fcc7efbad99fc53d9` | 2026-08-10T11:45:55+08:00 | 2026-08-10T11:45:55+08:00 | fix(deploy): 预检纳入就绪预算;收尾要求真连着;spawn 异步失败与并发 launcher 隔离 |
| `ac53ea37e24a0a7c9ba528e1c7f94094969899d2` | 2026-08-10T11:48:51+08:00 | 2026-08-10T11:48:51+08:00 | docs: 补各 runtime 的模型凭据来源(readiness 查不到的那一步) |
| `8afdc37989b14ed03a844a43d74c82ddf2b8f445` | 2026-08-10T14:25:21+08:00 | 2026-08-10T14:25:21+08:00 | fix(deploy): 回滚不越权停 silent 锁;就绪超时校验;补 launcher 黑盒测试 |
| `57a06ef66b06fb2c121749dbd5744ccba46415ea` | 2026-08-10T14:40:09+08:00 | 2026-08-10T14:40:09+08:00 | chore: gitignore 挡住仓库根的真实 config.json(只跟踪 config.example.json) |
| `6e3bb596db501dcd686d176676456f62d0b915ab` | 2026-08-10T14:43:34+08:00 | 2026-08-10T14:43:34+08:00 | docs: README 基线改为指向 gitlab/main 最新(钉死 commit 无法自洽) |
| `5131dc50856831cdf839a1c5e47fc48122c92fc8` | 2026-08-10T14:57:11+08:00 | 2026-08-10T14:57:11+08:00 | docs(qa): 首轮验收清单 —— 标注哪些已自动验过、哪些必须人工,并说明为什么 |
| `f60b0f4a7f3b51cc4c30ba74376c570acf179ab3` | 2026-08-10T15:22:25+08:00 | 2026-08-10T15:22:25+08:00 | fix(codex,octo): artifact 名字不再拼进 [object Object];拒发通知说清原因与下一步 |
| `8b9b5f6fa70f2de94442a80920affc1e3a3a3c3f` | 2026-08-10T15:25:47+08:00 | 2026-08-10T15:25:47+08:00 | fix(octo): 失败通知去掉内部函数名前缀(这句是给群里的人看的) |
| `8368fd35319001b37fb79e8cf9ea4f8780ddbf66` | 2026-08-10T15:35:28+08:00 | 2026-08-10T15:35:28+08:00 | fix(octo): 纠正"发文件"的工具说明 —— agent 被明确告知了一条不存在的限制 |
| `6d950797b887a35cbd1beb3d53225f277dfa7705` | 2026-08-10T16:07:51+08:00 | 2026-08-10T16:07:51+08:00 | fix(outbound): 工作区外的自动 artifact 只记日志,不发群内失败通知 |
| `efd63dc89401a29db4d415583e25fe7afe31cc77` | 2026-08-10T16:46:09+08:00 | 2026-08-10T16:46:09+08:00 | docs(readme): 改为对外正式口吻,去掉内部测试语汇 |
| `505a400d851c32c8f63982133327aff260b34e6a` | 2026-08-10T17:22:07+08:00 | 2026-08-10T17:22:07+08:00 | feat(guidance): skill 按名合并 builtin + 用户目录,内置只留 octo-core |
| `933e42faafee59a1d1c1679bc8e1e1bba3f24b86` | 2026-08-10T17:40:37+08:00 | 2026-08-10T17:40:37+08:00 | fix(guidance): octo-core 无条件加载且不可被覆盖;消除与 OCTO_CLI 段的矛盾指令 |
| `353cb93682e36310789a0f193301899ef6823b7a` | 2026-08-10T18:02:29+08:00 | 2026-08-10T18:02:29+08:00 | fix(guidance): OCTO 段随实际能力生成,不再与 OCTO_CLI 段和跨会话工具对撞 |
| `b3f9271f98642665bcfaa7d70cd7a29ed3be71de` | 2026-08-10T18:09:45+08:00 | 2026-08-10T18:09:45+08:00 | fix(guidance): 卡片边界随 flag 派生;加"点名的工具必须存在且可达"守卫 |
| `b3c3b56be4c98a5639771166f96abd5d752e2b63` | 2026-08-10T18:12:16+08:00 | 2026-08-10T18:12:16+08:00 | docs(guidance): 跨会话目标改说"目标标识",不再说窄成群号 |
| `b1932f169ec703c02c4253c9cf6a59003ad27cf6` | 2026-08-11T11:04:46+08:00 | 2026-08-11T11:04:46+08:00 | fix(agent-cli): 导出改写覆盖 reference 文件;索引改由 CLI 输出决定 |
| `181a79b0b0ff2b17f16ba3388b09314b432e4ee7` | 2026-08-11T18:22:58+08:00 | 2026-08-11T18:22:58+08:00 | feat(agent-cli): agent 侧改用外部可升级 CLI,经 per-bot launcher 钉死身份 |
| `94999a0452fca412b99a5c017c2e709c6c678def` | 2026-08-12T10:27:57+08:00 | 2026-08-12T10:27:57+08:00 | fix(agent-cli): 修终审发现的事务残留、超时误判与 env 泄漏 |
| `bd6c74dc1ead60f7e2cb8a567164f10ea1eb5521` | 2026-08-12T10:40:45+08:00 | 2026-08-12T10:40:45+08:00 | fix(agent-cli): 修 noShell 恒真告警、事务测试假绿与守卫误报 |
| `e08e6f4c17681052b58d0ebb73b93fd9b9618891` | 2026-08-12T10:47:52+08:00 | 2026-08-12T10:47:52+08:00 | fix(agent-cli): 补 codex 沙箱禁网告警;守卫扩到目录级并覆盖传递依赖 |
| `62360f74f20f61ceac3e8508b788c6672309a56d` | 2026-08-12T11:25:14+08:00 | 2026-08-12T11:25:14+08:00 | fix(agent-cli): 内联反引号命令与子目录 reference 也改写为 launcher 路径 |
| `82457ba0404e24f6c5913b4a6104999764af2ba8` | 2026-08-12T11:43:20+08:00 | 2026-08-12T11:43:20+08:00 | fix(agent-cli): 裸 octo-cli 改判词边界 + 提交前 fail-closed 复查 |
| `4d736660a3043f8055d0029b1706689bd3325efd` | 2026-08-12T14:33:02+08:00 | 2026-08-12T14:33:02+08:00 | fix(agent-cli): 复查改为反向判据(证明不了惰性即拒起)+ 覆盖引号/续行形态 |
| `9cf1a15a10ee6664f49f2efa930f557637c17663` | 2026-08-12T14:59:27+08:00 | 2026-08-12T14:59:27+08:00 | fix(agent-cli): 反斜杠转义的命令名也算命令(`\octo-cli`) |
| `29573c810430d2d721ac410ff38ce1f425073dfd` | 2026-08-12T15:17:04+08:00 | 2026-08-12T15:17:04+08:00 | fix(agent-cli): 带路径的调用也当命令,连路径一起换成本 bot launcher |
| `47bdf98eb3b643deef3357f4432f183e218968ef` | 2026-08-12T15:36:07+08:00 | 2026-08-12T15:36:07+08:00 | feat(agent-cli): 身份绑定从改写文本改到运行时 env,不再靠枚举写法 |
| `613fcbfca6aba72a616cd7993d10076c3c3eba66` | 2026-08-12T15:56:27+08:00 | 2026-08-12T15:56:27+08:00 | fix(agent-cli): per-bot ZDOTDIR 收口 dotfile 覆盖;openclaw 例外单独说明 |
| `161e691ad167dfd7b5f37d74b0b0ab77922741fd` | 2026-08-12T16:23:35+08:00 | 2026-08-12T16:23:35+08:00 | fix(agent-cli): rc 补 unset 与 ZDOTDIR 钉回;openclaw 远端档改为拒起 |
| `2bb6092ed6d2bd9d270edeb0f04dd4e52e5a72ea` | 2026-08-12T18:48:18+08:00 | 2026-08-12T18:48:18+08:00 | fix(agent-cli): openclaw 同机前提改人工断言;rc 修 ZDOTDIR 三处缺陷;CI 消除假绿 |
| `1d4ce720dda3e0d210f992992ee36a60ccff9e83` | 2026-08-13T10:39:38+08:00 | 2026-08-13T10:39:38+08:00 | fix(agent-cli): rc 按 zsh 规则找 .zshenv;样例不再代替测试人员断言前提 |
| `0b488bb0b500a000dbea794d59af68663d708ca6` | 2026-08-13T11:27:52+08:00 | 2026-08-13T11:27:52+08:00 | fix(agent-cli): ZDOTDIR 变更逐份 rc 传递;探针与开关口径全文对齐 |
| `1472b1e6791117f4df221118ca76f398cb12e47b` | 2026-08-13T11:41:14+08:00 | 2026-08-13T11:41:14+08:00 | fix(agent-cli): 用户清空 ZDOTDIR 时照原生语义回落 $HOME |
| `5d62bc0054552cbbe717a001594ac70eea7cbb76` | 2026-08-18T10:33:49+08:00 | 2026-08-18T10:33:49+08:00 | fix(ci): e2e-test job 补 npm run build——黑盒 spawn run-from-config.mjs 需 dist/index.js,不 build 则全量 ERR_MODULE_NOT_FOUND(unit-test job 同款修复的遗漏,main 连红至少 10 条) |
| `d076d0666720060e38690ac08c7362e07a2f5a95` | 2026-08-17T11:59:49+08:00 | 2026-08-25T06:33:58Z | feat(dsh): runtime 初版——engine/adapter + 契约扩展 + slice 装配 |
| `464c7f9af4039eadf54e12b517c4f0b875b97cca` | 2026-08-17T16:43:06+08:00 | 2026-08-25T06:33:58Z | feat(dsh): capability 接线——CapRuntime 加 dsh(minimal 无工具面;host 档 fail-fast P-1) + 样例计数断言对齐 |
| `525ea8125b34b852679197c52c59f00152af32a0` | 2026-08-17T16:56:04+08:00 | 2026-08-25T06:33:58Z | fix(dsh): resolveDshBin POSIX 也验存在——盲取首个 PATH 目录致 spawn /usr/local/sbin/dsh ENOENT(WSL live 实证);全未命中回退裸名交 spawn 兜底 |
| `b32ffe5b8237971d130711b44b6f440aa09da554` | 2026-08-17T17:00:30+08:00 | 2026-08-25T06:33:58Z | fix(dsh): ensureRuntime 先建会话 cwd——目录不存在时 spawn 报二进制 ENOENT(误导性;WSL live 第二轮实证 spawn /usr/bin/dsh ENOENT 而文件存在) |
| `058996ab1078052c53560f427d657aed009815fb` | 2026-08-17T17:37:40+08:00 | 2026-08-25T06:33:58Z | test(dsh): M-dsh-3 单测——engine 12 条(FakeHarness:事件翻译/收束判定/cancel/缓存复用/启动参数) + adapter 7 条(FakeEngine:context 拼接/reset 后缀/subtask id/capabilities 快照 P-1) |
| `034557e621dcb821ebc14d570daba7be7aeab86f` | 2026-08-24T19:03:44+08:00 | 2026-08-25T06:33:58Z | feat(config): support per-account runtime environments |
| `ea3f17ca222c611d1bbe43f8d9abad1e78dddce5` | 2026-08-25T19:16:25+08:00 | 2026-08-25T19:16:25+08:00 | feat(gateway): add single-process multi-bot host |
| `620b6e15f5eac2616530b284341e09634d0720f5` | 2026-08-26T11:11:17+08:00 | 2026-08-26T11:11:17+08:00 | fix(gateway): harden single-process lifecycle |
| `89a41f51eca21a89710e78abfdb0b0686bbf3de1` | 2026-08-26T14:26:31+08:00 | 2026-08-26T14:26:31+08:00 | test(gateway): cover known-bot removal |
| `20c5169e70be040802fd1172538740f36a43ce1a` | 2026-08-26T14:50:13+08:00 | 2026-08-26T14:50:13+08:00 | fix(gateway): close pre-lock shutdown race |
| `8ddc89e0fcb15cd5797f82102f6ed73b9c97ccef` | 2026-08-26T15:34:51+08:00 | 2026-08-26T15:34:51+08:00 | test(gateway): cover pre-lock shutdown race |

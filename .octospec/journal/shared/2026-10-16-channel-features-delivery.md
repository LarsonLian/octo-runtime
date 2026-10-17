---
type: Journal
title: Channel 六项决策实施与测试环境验收
description: 当前分支分批交付图片、一次历史及 Mention，记录固定目录与内存边界、真实测试证据和未覆盖项。
tags: [channel, multimodal, context, mention, testing, architecture]
timestamp: 2026-10-16T00:00:00Z
---

# Channel 六项决策实施与测试环境验收

## 交付范围

用户授权在当前 main 分支开发并分批提交。实现均位于 Channel Gateway；没有为这些业务能力修改通用 Host、Adapter 或 Context 协议，没有增加持久化。原工作树内另一个 Adapter 装配任务的修改保留，不混入本次提交。

| 专项 | 本次结果 |
| --- | --- |
| Codex 独立图片 | type=2、每条一张，PNG/JPEG/WebP、2 MiB；先准入，再受限下载，原字节成为 inputs image part。非 Codex 在下载前明确拒绝。 |
| 新会话历史 | Channel 在 await 前占用会话初始化资格；最多 15 条、1500 Unicode 码点，边界保留尾部并加标记。失败/空结果消耗资格、继续当前任务，续聊不重拉，重试使用冻结输入。 |
| 不持久化 | 一次标记复用现有有界 binding；图片、Context、成员校验结果、投递转换不新增本地持久库。 |
| 限流重试 | 复用已有 REST 和 Codex 有界重试，没有再造用户/会话限流器。 |
| 固定 workdir | 架构约束；IM 请求入口拒绝任务 workspace 改变 Agent 目录，reset 只换会话。其他 invoke 调用方仍可显式配置目录。 |
| Mention | 入站认 UID/纯 ais 元数据；出站普通回复不自动 @。模型 final 标记经 mdast 解析、真人成员校验和 UTF-16 entity 转换，原 WS 统一发送；失败降级普通文本。 |

首次 mention guidance 与历史资格分开：新逻辑 session 或尚无 Provider binding 时，由 Channel 显式提交短指引；后者不重新获得历史补取资格。Host 不缓存、不补齐、不去重业务 Context。模型出站 Bot 目标和广播未开放。

## 自动化验证

- workspace 构建及 `pnpm typecheck` 通过；最新 Gateway 单包构建通过。
- `pnpm lint`、`pnpm lint:names` 通过。lint 必须在构建结束后运行，避免 clean-dist 期间的跨包类型暂时无法解析；这不是源码错误豁免。
- `node --test test/*.test.js packages/octo-runtime-protocol/test/*.test.js`：847 项，840 通过、7 跳过、0 失败。跳过项不计为覆盖。
- 新增准入矩阵、图片限制/取消、历史一次资格和 reset 队列竞争、Markdown 示例排除、失败降级、成员身份、多个目标与 emoji offset 测试。原生加密 WS fixture 确认最终帧含 `mention.uids/entities`，控制回复不含 mention。
- 既有 Store 容量/TTL/关闭、两种渠道一万个会话的闲置调度回收、Codex 暂态重试与工具后不自动重放回归继续通过。

未新增上下文数据库或持久投递账本。图片校验检查签名、尺寸及必要尾部结构，不等同于完整图片解码；更深层文件损坏仍可能由 Provider 报告。

## 真实测试环境

目标仅为 `https://im-test.deepminer.com.cn/`，本机真实 Provider 为 `codex-cli 0.154.0`。用户指定的本机受保护账号文件提供两个既有测试 Bot，脚本先核对 verify-bot 的 Bot UID 和 API 地址。凭据只在进程内使用，不输出或提交；没有使用本机正式环境的 Gateway 配置，也没有重置 Home、身份或 Provider 数据。

第一次经 Bot API 建群被明确拒绝 `member_not_human`，随后通过已登录测试 Work App 的人类建群入口创建隔离群。该限制没有通过伪造真人或修改接收准入绕过。

隔离群 `0166f275fcb443cd830f1695788c0fdc`，名称 `Channel_QA_1792087413796`，保留供人工复核。本次运行结束已关闭临时 Bot WS 和 Host，并清除本机临时工作目录；没有将测试 Runtime 写进长期 Gateway 配置。后续调试需重新启动脚本，不宣称 Bot 持续由本次进程接待。

可复验脚本：[verify-channel-features-live.mjs](../../../scripts/verify-channel-features-live.mjs)。显式设置受保护账号文件路径 `OCTO_CHANNEL_QA_ACCOUNTS`；`OCTO_CHANNEL_QA_GROUP` 可复用上述测试群，省略则通过测试 Work App 新建隔离群。脚本会向该隔离群发送测试消息和图片，不用于正式环境。

| 验证 | 实测结果与证据边界 |
| --- | --- |
| 无真实点名 | 普通 @名字、原始标记正文、all/humans 广播和未 @ 图片均零 AgentRun；图片没有进入下载路径。 |
| 最近 15 条 | 先发 20 条顺序标记，首次真实 WS 触发后的 Context 仅含第 05..19 条，排除触发消息；确认 API pull_mode=0 与 start=触发序号-1 的真实分页语义。 |
| 续聊与 reset | AI 广播只产生一次接待，正常续聊不再注入历史；reset 后逻辑 session 换新，仍可补旧聊天，目录相同。此部分使用可控 Provider 终态验证业务编排。 |
| 话题隔离 | 新建话题并加入 Bot，真实话题消息触发；Context 只取话题历史，不混入父群文本。 |
| 出站真人点名 | 可控 final 经实际 WS 发回同一群；API 读回确认 mention.uids，测试 Work App CDP 确认 `QA_FINAL` 正文内渲染 `.tms-msg__mention[data-uid]`。没有另走 CLI 发送最终答案。 |
| 实际模型查身份再点名 | 图片执行后的同一真实 Codex 会话收到仅带真人名字的通知任务，产生 7 个工具事件，最终输出带正确 UID 的显式标记；终态 run.completed，实际 WS 最终消息 `QA_MODEL_MENTION_DONE` 读回含真人 mention.uids。由 Channel 提供的工具身份环境生效，不给模型预填目标 UID。 |
| 图片识别 | 上传上蓝下黄 PNG，经群图片消息、真实下载、inputs、实际 Codex Adapter/Provider 到最终回复；终态 run.completed，模型回答“上半部分是蓝色，下半部分是黄色”，Work App 中可见。不是 URL 占位或 fixture 模型输出。 |

测试环境服务端会给含 ais 的请求补出 Bot UID 列表，包括同时带 all 的请求。因此混合广播最终仍可能因明确 UID 命中；Gateway 按收到的最终协议判断，不推断 UID 的产生方式。不存在 UID 的纯 ais/混合标志边界由自动化直接验证。若需要改变服务端的广播归一化语义，应在服务端协议所有者处单独处理，不在 Gateway 添加正文猜测或来源猜测。

`cards=false` 的脚本仍记录一次 `IM_CARD_UNAVAILABLE` 诊断，文本与图片链路正常；本次没有声称完成进度卡验收。客户端高亮验证不等于后台推送或操作系统通知弹窗已验证。真实 DM 图片、客户端发送纯图片时附带 @ 的交互流程、Provider 恢复失败及持续一天执行没有单独实测。

新增失败终态反例在全仓测试后单独复验，Mention 文件 5 项全部通过；失败终态不进入 final 点名转换。OKF 使用仓库约定的 `uv run --with pyyaml python .octospec/scripts/lint.py` 通过，119 个知识单元、20 条规则、850 个本地链接；系统 Python 缺少 PyYAML，因此没有用其失败结果冒充文档校验通过。

## 重试证据

[verify-im-retry-live.mjs](../../../scripts/verify-im-retry-live.mjs) 复验：im-test 首页 200、无效 Bot 401；本地真实 Codex 首次上游受控 503，第二次尝试 run.completed，最终随机标记匹配，累计两次尝试、一次 retry notice。此脚本不发 IM 消息，不把它与上表正常图片执行拼成“真实 IM 限流注入已验收”。

不增加重复执行或补发流程来提高表面成功率。身份、权限、业务错误及执行结果未知继续遵循原边界；不宣称限流无条件恢复、跨重启恰好一次执行或通知必达。

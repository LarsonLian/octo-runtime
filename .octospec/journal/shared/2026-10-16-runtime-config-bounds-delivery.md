---
type: Journal
title: Channel 配置容量整改交付
description: 单 Extra 64 Bot、64 配置操作与复制前大小校验的实施和测试环境证据。
tags: [channel, storage, lifecycle, testing]
timestamp: 2026-10-16T00:00:00Z
---

# Channel 配置容量整改交付

本批在当前 main 工作区实施，未包含其他任务尚未提交的连接状态机和 Adapter 装配改动。Bot 上限在 Extra、文件配置校验和 manager 三处统一为 64；在途 upsert/remove 合计最多 64。单份 JSON 配置最多 256 KiB，不另设 1 MiB 总额门槛。

复制前检查关闭状态、队列名额、配置合法性和 JSON 字节。共享 JSON 字节计量器逐字符计算转义、Unicode 和 UTF-8，不先构造超大完整 JSON；循环引用、访问器和非 JSON 对象拒绝。Promise 结束归还名额；close 先 abort 再等待，不需要名额，也不后台重试。未增加配置持久化或热更新合同。

验证：`pnpm build` 通过；`node --test test/channel-config-bounds.test.js test/im-extra-disposal.test.js test/channel-packages.test.js` 共 19 项通过。覆盖 64/65 Bot、64/65 操作、1000 次拒绝不再复制、单份精确边界、失败释放及队列满关闭。

真实环境：运行 `scripts/verify-channel-capacity-live.mjs`，从受保护文件选择 im-test 测试账号，64 个槽位中 1 个真实 Bot 建联 online、63 个停用项 stopped，错误列表为空；卸载完成。没有用 64 个真实账号制造线上压力，没有执行模型或发送聊天消息。GC 压测和异常注入由本地测试承担，不能据此声称整个进程 RSS 上限为配置字节上限。全仓回归和推送结果在四批最终记录补充。

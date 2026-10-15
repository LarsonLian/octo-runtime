---
type: Journal
title: 通用执行渠道快照删除验收
description: 删除快照字段、类型、校验和转发，记录回归与真实执行结果。
tags: [protocol, context, testing]
timestamp: 2026-10-15T00:00:00Z
---

# 实施

按[任务](../../tasks/remove-context-snapshot/brief.md)删除 ChannelContextSnapshotRef schema、生成类型、导出、InvokeInput.contextSnapshot、专用格式校验、InvokeRequestWire.contextSnapshot 及 Core 克隆转发。有效输入样例删除旧字段；新增回归证明未知可选旧字段不影响输入校验、不进入执行请求、不改变本轮模型输入或业务 Context，也不修改原调用对象。

Channel Gateway Extra 未依赖该字段，本次未调整其业务逻辑。Work App 测试程序及业务内部同名配置保存未修改。不新增替代快照合同；Run=7、Context=v3、Adapter transport=2 保持不变。

用户补充的单一调用链目标写入 InvokeInput 规则和任务：RPC 只传输入，Host 统一解析并执行。当前仍存在内部请求转换及 prepare / invokeFrames 接口；本次没有实施该链路改造。

## 验证

- Runtime `pnpm typecheck` 通过，含所有包与应用构建。
- 全量 Node 测试 782 项：775 通过、7 跳过、0 失败。
- 修改的协议 index.ts、invoke-input.ts 和 Core invoke-input.ts ESLint 通过。
- 检索 packages / apps 确认无 contextSnapshot 或 ChannelContextSnapshotRef；schema 与生成 Node/browser 声明检查通过。旧字段只存在于删除回归测试，不再具有执行语义。
- `scripts/verify-playboard-live.mjs` 确认线上测试环境 https://im-test.deepminer.com.cn/ 返回 HTTP 200，并以新构建启动临时 daemon/Host 调用真实 Codex、OpenClaw。两者均 exitCode=0、run.completed、命中预期文本，分别输出 18 / 28 帧。临时实例使用独立目录并由脚本结束清理，未重置既有身份、Home、profile 或 Provider 状态。

本次未构建 Work App、未重启 Worker，也不声称完成远程 Worker 注册；桌面测试程序按用户要求不作为兼容约束。

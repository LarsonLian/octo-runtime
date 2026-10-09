# Context v2 与 FileBundle：Harness 验证记录

日期：2026-10-09（Asia/Shanghai）。状态：Context v2、FileBundle 准备与真实 Provider 压缩已验证；跨服务联合验收以工作应用基线记录为准。

合同以 [IPD-SE 基线](../../octo-harness-work-app/docs/context-simplification-ipd-se-baseline.md) 和 [FileBundle 基线](../../octo-harness-work-app/docs/file-bundle-design-baseline.md) 为准。

## 已实现

- Run schema 6、Context v2、Compiler/Catalog v2。公开信封只注册四类；旧版本和旧拆分类型拒绝。
- execution 按字段继承；互斥配置原子替换；limits 按字段继承；mandatory 约束原始请求。资源按 kind/UUID 合并，保留 invoke/components。
- Runtime 使用受租约约束的资源解析端点。Worker 返回首次冻结的 revision、真实字节摘要与完整文件。Runtime 写入二进制文件并保留执行位，独立维护插件运行数据。
- ContextCompiler 输出执行计划、已准备资源配置、参考材料和可信指令。Pipeline 只有封存成功后交付调用产物。频道连续性来自内部上下文，不进入公开信封。
- Codex 生产入口默认使用宿主 Responses Provider 自动计量和摘要；摘要请求 `tools: []`、`tool_choice: none`、`store: false`，不重发摘要或已接受的主 turn。最多 64 次摘要、8 轮、4 路并发；单块最多 65,536 个实际 token。
- 计量采用 `provider_native`：显式内容由 Responses 精确计量；历史、隐藏指令和工具由 Codex 原生容量管理。模型窗口来自可信宿主配置或已核实模型资料，未知容量明确失败。
- 摘要先持久化再封存；恢复重新计量，复用同一份摘要。准备、压缩、排队、主调用和输出归档共用 Run 总时限。跨进程取消发送 cancel RPC，AbortSignal 不进入 JSON。
- knowledge 完整落地为不可变文件树，只把目录清单加入不可信模型材料，不执行包内 Skill/MCP。Connector 继续使用标准 mcp.json。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck`（包括全仓构建） | 通过 |
| `node --test` | 837 项：833 通过、0 失败、4 跳过（含总时限与 RPC 取消） |
| 核心 Context 文件 ESLint | 通过 |
| `git diff --check` | 通过 |
| 全仓 `pnpm lint` | 18 项既有错误，未宣称全仓 lint 通过 |

测试覆盖：共享 Schema/配置/摘要 fixtures、旧协议拒绝、二进制与执行位、目录损坏和路径穿越、标准插件、内部频道续接、CAS 快照、材料恢复、取消、封存失败、可信指令隔离及压缩产物恢复。资源端点测试使用本地 HTTP fixture，不代表真实对象存储联调通过。

全仓 lint 的剩余分布：Codex app-server 1；Host experience 4；OpenClaw local-gateway 2；SDK acp-turn 1；core engine 1；daemon task-outputs 1；embedded-harness 3；embedded enrollment/runner/runtime-contract 各 1；protocol index 2。对应位置均在本次业务变更之外。

## 真实 Provider 验证

[脱敏证据](validation/context-compaction-live-2026-10-09.json)，模型 `gpt-6.1-sol`、Codex CLI `0.154.0`。

- 新材料 1,061,056 token，超过 1,050,000 窗口；18 次无工具摘要后为 3,342 token。真实 Codex 主调用完成，准确保留末尾标记和保留规则。
- 独立新进程恢复：重新调用 Provider 计量，摘要字节一致，未再次生成摘要。
- 真实摘要请求启动后取消：无摘要快照、无主调用。
- 原生历史产生 4 次 `compacted` 回执；前 3 个 turn 完成续接，唯一文件副作用只执行一次。第 4 个 turn 触发 120 秒取消，未重复文件写入。

手动复现：`node scripts/verify-material-compaction-live.mjs`。脚本使用宿主已配置的 Provider，会产生模型调用费用；输出仅写入忽略目录 `.run`，不保存或打印凭据。模型容量来源：[OpenAI 模型资料](https://developers.openai.com/api/docs/models/gpt-6.1-sol)。

## 验收边界

- 本记录中的大材料来自合成事实，知识目录与 Connector 的授权和双入口验收仍需对应 Worker/Access/Gateway 证据，不能用模型调用成功代替授权验证。
- 本地 core 仅提供 execution/config 子集，不隐式取得云端资源权限；云端资源由 Worker/Runtime 准备。
- 既有全仓 lint 错误仍需单独治理，本次没有将其计为通过。

# Context v2 与 FileBundle：Harness 验证记录

日期：2026-10-09（Asia/Shanghai）。状态：本地实现与自动化验证完成；真实 Provider 压缩、云端联合切换尚未验收。

合同以 [IPD-SE 基线](../../octo-harness-work-app/docs/context-simplification-ipd-se-baseline.md) 和 [FileBundle 基线](../../octo-harness-work-app/docs/file-bundle-design-baseline.md) 为准。

## 已实现

- Run schema 6、Context v2、Compiler/Catalog v2。公开信封只注册四类；旧版本和旧拆分类型拒绝。
- execution 按字段继承；互斥配置原子替换；limits 按字段继承；mandatory 约束原始请求。资源按 kind/UUID 合并，保留 invoke/components。
- Runtime 使用受租约约束的资源解析端点。Worker 返回首次冻结的 revision、真实字节摘要与完整文件。Runtime 写入二进制文件并保留执行位，独立维护插件运行数据。
- ContextCompiler 输出执行计划、已准备资源配置、参考材料和可信指令。Pipeline 只有封存成功后交付调用产物。频道连续性来自内部上下文，不进入公开信封。
- 材料压缩提供可信宿主 Port、持久摘要和恢复编排。压缩不得修改执行配置或可信指令；准备与封存默认 30 秒，压缩阶段默认 120 秒。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck`（包括全仓构建） | 通过 |
| `node --test` | 821 项：817 通过、0 失败、4 跳过 |
| 核心 Context 文件 ESLint | 通过 |
| `git diff --check` | 通过 |
| 全仓 `pnpm lint` | 18 项既有错误，未宣称全仓 lint 通过 |

测试覆盖：共享 Schema/配置/摘要 fixtures、旧协议拒绝、二进制与执行位、目录损坏和路径穿越、标准插件、内部频道续接、CAS 快照、材料恢复、取消、封存失败、可信指令隔离及压缩产物恢复。资源端点测试使用本地 HTTP fixture，不代表真实对象存储联调通过。

全仓 lint 的剩余分布：Codex app-server 1；Host experience 4；OpenClaw local-gateway 2；SDK acp-turn 1；core engine 1；daemon task-outputs 1；embedded-harness 3；embedded enrollment/runner/runtime-contract 各 1；protocol index 2。对应位置均在本次业务变更之外。

## 尚未完成的验收

- 生产宿主尚未注入通过资格验证的压缩 Port。需要可靠模型容量、整个主请求的准确计量，以及真正禁用业务工具的摘要调用；不得用字符估算或提示词约束伪装验证通过。AC07–AC11 与 M4 尚未完成。
- FileBundle 的 `knowledge` 类型能够存储，但 Harness 没有已确认的知识加载器；准备时明确拒绝。Connector 的云端 UUID 解析与授权需 Worker 独立验证。
- 本地 core 仅提供 execution/config 子集，不隐式取得云端资源权限。它不替代 Worker/Runtime 的资源准备入口。
- im-test、octo-auth、真实对象存储、真实 Adapter 加载和双入口联合切换未由本记录验收；M5 不得据本地测试标为完成。

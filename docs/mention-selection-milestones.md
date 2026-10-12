# Mention 选择上下文里程碑

日期：2026-10-12。当前 main。需求与模块分配见 [Work App IPD-SE](../../octo-harness-work-app/docs/mention-selection-context-ipd-se.md)。

## Milestone 1：纯构建合同

状态：纯构建合同已完成；尚未接入编辑器、业务授权工具和真实执行入口。

扩展对象选择快照与通用 Context 贡献构建，保留文档选区注册路径。材料必须是已采集文本或合法 MCP 引用；Skill 使用进入 resources 通道。Builder 不负责网络、文件读取或授权。Run=7、Context=v3 不变。

退出条件：混合选择、同名身份、版本范围、缺失材料、重复身份、错误意图、内容预算及 Compiler 信任边界测试通过；现有场景与选区回归通过。

### 实现合同

- `ObjectSelectionSnapshot` 保存结构化选择与对应材料。当前支持 task、discussion、discussion_comment、discussion_reply、skill、local_file、drive_file；未交付的扩展对象不进入允许类型。
- `buildObjectSelectionContext` 只输出 Context 贡献，不要求为个人会话添加新 scenario。Loop 可通过带 `snapshotKind: object_selection` 的现有场景 Builder 使用同一贡献函数。
- ContextBuilder 默认参数仍为文档选区类型；对象 Builder 必须声明输入判别值，不能把对象快照传给文档选区 Builder。
- 材料选择必须提供对应 inline 快照或 MCP reference；缺失、孤立、重复和身份冲突拒绝。普通材料只进入 content，使用 Skill 只进入 resources/skills。
- 本轮构建边界：每次最多 32 个选择节点，每条 inline 材料最多 32768 个 UTF-8 字节；完整 Context 继续执行 65536 字节总限制。这些是 Builder 的当前边界，不代表文件上传、解析或模型 token 预算。
- 完全相同的材料选择去重；类型、对象 ID、声明的对象 scope、版本意图或 selector 不同则保留。scope 只记录来源，不授予权限。重复节点对应不同内容或 resolver 计划时拒绝，不选择任意一份。
- 本地句柄不进入生成的模型事实 source。Builder 不读取文件、不授权 MCP 工具、不把解析成功当作 Provider 已使用材料。

### 验证记录

定向 Context、配置合并、场景、Pipeline 与新增对象选择测试共 256 项通过；Work App 定向回归 58 项通过。Harness 完整 `pnpm build`、Work App `pnpm typecheck` 与 `pnpm build` 通过。此次只新增纯构建能力，没有 UI 和业务接口改造，尚未进行业务材料的实机闭环验收。

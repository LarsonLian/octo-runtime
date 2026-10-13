# Event Context 改造里程碑

基线：[Event Context IPD-SE](../../docs/event-context-rendering-ipd-se.md)。当前分支直接修改并按里程碑提交；本文件记录本次验证，不引用历史结果作为通过依据。

## M1 共享协议与 Host renderer

日期：2026-10-13。状态：已完成源码与针对性自动验证，尚未完成跨项目和真实环境验收。

- ContextItem 增加可选 guidance，执行配置禁止 guidance；Run 7 / Context v3 保持。
- canonical/hash 保留 items 顺序，guidance 纳入快照身份；共享 fixtures 同步。
- Host 固定请求后统一渲染模型上下文，内部只输出换行纯文本“指引／数据”；执行配置、未知普通 namespace 和控制指令不进入 contexts 块。
- 覆盖文本、parts、fresh fallback 以及 native/canonical；冻结与重复接纳复用原始请求身份。
- 明确内置类型的 LLM 通道，以及 resume 后由发起方决定本轮上下文。

验证：Protocol 与 Adapter Host 构建通过；`node --test test/model-context.test.js test/context-protocol.test.js test/host.test.js test/native-host.test.js` 通过。

后续：Go 同源合同与 Event、Run 快照传递；旧调用方编译前缀退出；Pipeline、材料摘要与扩展投影删除；Work App/Loop 调用方同步；跨项目构建、重启和真实执行验证。

## M1.1 每轮输入归属与全局文档同步

日期：2026-10-13。范围：文档约束，不表示旧执行侧链路已退出。

- 每轮模型上下文的内容、顺序和发送时机由业务方决定，selection 等业务项非框架必填。
- 允许空模型上下文、只发送本轮需要的项及显式重复；必要 adapter 等执行配置仍独立校验，且不进入 LLM 上下文块。
- 底层不得按 sessionId、run 序号或 hash 缓存、补齐、合并、去重或省略本轮数据；原 Event 幂等重投仍复用原快照。
- reset、新建 Provider 会话或 resume 失败后，由业务方重新提供必要背景；底层返回真实结果，不自动补齐。
- 更新全局 AGENTS、生态 README/IPD-SE、Harness 架构及全部模块 README、Worker/Loop/Work App README，以及关联架构和历史 Context 文档入口。IPD-SE 增加 AC-21～25，明确三轮输入、重复、不发 selection、恢复失败与执行配置边界。

验证：文档差异与本次新增相对链接检查；本里程碑不修改运行时代码，不以文档同步宣称新增 AC 已通过。

## M2 本地入口退出调用前编译与 Go 合同同步

日期：2026-10-13。状态：源码与针对性自动验证完成；远端 Pipeline 退出仍待完成。

- Work App 和 IM 直接传递当轮结构化 Context 与原始模型输入，不再调用 compileRunContext 或拼接模型上下文前缀；可信控制指令独立传递。
- Work App 的 Provider 会话配置 hash 只覆盖执行配置及控制指令；业务 Context 变化、传空和显式重复均不阻断 resume。
- Worker / Loop 同步可选 guidance，Worker canonical/hash 及配置合并保留 item 顺序；同步共享正反 fixtures。
- Host 四轮集成测试验证同一 Provider 会话的背景、空上下文、显式重复均按当轮渲染；Work App 四轮回归验证原始输入、当轮 Context 和 Provider 会话复用。

验证：Protocol / IM 构建通过；Harness model-context、im-runtime、context-protocol 测试通过；Work App 会话服务 10 项测试及 TypeScript 检查通过；Worker `go test ./...`、Loop clients 测试通过。本记录不证明远端旧编译链路已删除或真实环境已验收。

## M3 破坏性删除执行侧上下文加工

日期：2026-10-13。源码删除及自动验证完成，真实业务写入验收单独记录。

- 删除 Compiler/Pipeline、执行侧场景追加、材料预取与缓存、三种材料压缩实现、扩展处理器与字段投影、context.applied 及编译版本/消费证据。
- Host renderer 只匹配白名单 pattern、保留 item 顺序并拼接文本，不执行业务校验；场景元数据不要求 selection。
- 工作区准备迁入 adapter-host，授权图片读取迁入 worker-access，执行计划一致性检查归 Protocol；保留执行身份、租约、fencing 和工作区确认。
- Worker 同步窄化准备回执及生成 OpenAPI；Work App 的 SDK 删除旧扩展与场景应用字段，不保留兼容路径。

验证：Harness 全量测试 820 项，815 通过、5 跳过、0 失败，构建通过；Worker 和 Loop `go test ./...` 通过，Worker 构建通过；Work App 类型检查和构建通过。Work App 全量测试有 1 项 project-notifications 异步用例失败，该文件单独重跑 5 项通过；不据此声明全量零失败。

## M4 本地问一问使用 Host 的 CLI 环境

日期：2026-10-13。使用本机已安装的 octo-cli 0.18.0 与 Codex skills，不新增工具安装或测试 MCP。

- Host main 进程从 App 当前配置 Host 的 runtime-onboarding 取得登录用户 UK，作为本次执行的 OCTO_BOT_TOKEN / OCTO_TOKEN；API_BASE_URL 取 App Host。环境值不写入提示词、IPC 或会话记录。
- 同会话只读目录请求成功返回 identity.bot_kind=user_key、identity.source=env:OCTO_TOKEN，证实真实 CLI 使用用户 UK；诊断 Run 为 run_c54a3fae-a784-4f8e-b2ee-5fbdbbc4bd29，completed。
- 问一问发起方直接构造 extra.ui/page 与 extra.drive/directory，不请求旧 MCP delegation，不携带其工具授权。目录指引由业务方提供，模型通过安装的 CLI 自行执行。
- 真实界面按“把我当前 skills 列表写入 Markdown，保存到当前网盘目录”发起，Codex 生成当前会话 53 项 skills 并上传。文件 skills-list-1c1d0dd9.md，网盘文件 ID 2031，个人空间根目录，22,213 字节；已独立下载核对内容，并检查个人空间文件行截图。Run 为 run_9fef5984-fcd8-4cf8-bdc4-f016c478ffdd，completed，9 次调用全部为 exec_command，无 MCP 工具调用。

验证：会话、Host 环境、问一问及本地发送相关 65 项测试通过，Work App 构建与类型检查通过；本次三个相关文件 33 项再次通过。验证脚本为 Work App 的 scripts/test-ask-cli-drive-live.mjs，按文件关联原执行，不受同一会话后续诊断影响。先前本机目录列表文件 skills-list-a47dcc30.md（ID 2028）保留为历史结果。另一次 Marketplace mode mine 查询返回 AUTH_REQUIRED，未通过，不将平台拥有的 skills 列表与当前会话列表混为同一结果。

中间一次补测遇到本地 daemon socket ECONNREFUSED，执行以 HOST_EXECUTION_FAILED 结束；该次不计为通过。daemon 断连修复 faeab97 后恢复运行，重新完成上述原句用例；末次检查 phase=running、cloudConnected=true，Runtime 为 runtime_73b443cb-29c0-4488-988d-ef7908d57f19。具体身份补核与接口限制见 [Work App 验收记录](../../octo-harness-work-app/docs/validation/event-context-cli-2026-10-13/README.md)。

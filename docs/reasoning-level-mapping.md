# Runtime 思考强度默认映射

2026-10-11 决定：Runtime 对外固定 `low / medium / high / xhigh`。用户选择与实际原生参数分开保存；不因某个 adapter 缺少原生档位而隐藏选择器或拒绝整次运行。

## 默认表

唯一维护点为 `packages/octo-runtime-adapter-sdk/src/reasoning.ts`。表随代码发布，不增加远端配置服务、UI 设置、运行时能力准入或协议协商。

| Adapter / 执行通道 | low | medium | high | xhigh |
| --- | --- | --- | --- | --- |
| Codex | low | medium | high | xhigh |
| Claude Code | low | medium | high | xhigh |
| Antigravity | low | medium | high | xhigh |
| OpenClaw Gateway | low | medium | high | high |
| OpenCode CLI（full_access） | low | medium | high | high |
| ACP（含 OpenCode ask）、CodeBuddy、ZCode | 原生默认 | 原生默认 | 原生默认 | 原生默认 |

OpenClaw、OpenCode 使用保守的三挡默认基线；这不声明所有底层模型只有三挡。其高级档位依赖底层模型，当前不动态发现、探测或重试切换档位。本机 Claude Code 帮助已列出 `xhigh`，因此保留四挡映射。

ACP 路径包含 Hermes、Kimi Code、MiniMax Code、Qoder 与 Qoder CN。目前 Runtime 未实现这些通道的原生强度 setter；“原生默认”不代表提供方产品永远不支持强度。

## 数据与执行边界

- UI 和 Context 继续保留统一档位。转换不改写 InvokeRequest 或执行快照。
- 各 adapter 在现有原生载体处调用共同 mapper：Codex `turn/start.effort`，Claude / Antigravity `--effort`，OpenCode `--variant`，OpenClaw `sessions.create.thinkingLevel` 和 `agent.thinking`。
- 缺少 effort 时不传参数，不产生额外提示。非法已知值（包括 `max`、拼错的 `xhight`、空字符串）在 adapter 边界拒绝，不当作“无接口”。公共 Context 类型暂仍使用 string，四挡检查在 Adapter SDK 执行边界完成。
- 无 setter 时，按用户授权保留选择、使用原生默认执行，不注入虚构 CLI 参数，不向提示词追加“请多思考”。
- 无 setter 时额外产生现有 `run.notice/config_warning`，`warningCode=REASONING_EFFORT_NOT_APPLIED`。降档时使用 `REASONING_EFFORT_DOWNGRADED`。Work App 展示具体说明；默认执行不冒充强度已应用。
- 不改变 Run schema_version=7、Context octo.context-envelope/v3、身份、授权、租约、fencing 或 mandatory 合并规则。

## 本轮验证

- 本次 Runtime 构建通过；全量自动化 908 通过、5 跳过。随后补充日志持久化字段，相关 87 项测试通过（含新增落盘测试）。
- 本次 Work App 构建与类型检查通过；相关 29 项测试通过。全量 1422 通过、1 跳过、1 失败：并行工作新增 IPC 后，contracts.test.ts 方法数量断言仍期待 149，实际 153；该项不记录为通过。
- 已重启桌面应用与内置 Runtime，通过真实 renderer / CDP 确认 Runtime 在线、cloudConnected=true。
- 实际环境：登录与 IM 为 https://im-test.deepminer.com.cn，Worker 为 http://127.0.0.1:8091/agentworker/api。这是本机服务与 im-test 身份联调，不是云端服务部署。
- MiniMax xhigh 请求已接受，真实 Run `arun_79660aec33d548ed82100cabfae354f1` 的 REASONING_EFFORT_NOT_APPLIED 提示经过 Worker 持久化，并在真实 renderer 显示。提供方运行最终 failed，未返回测试标记；只确认默认执行路径已启动和未应用提示链路，不记为提供方执行成功，失败根因未确认。
- Codex xhigh 真实 Run `arun_1a7b802605b34e62b275bac0f7b30908` completed，返回 OCTO_REASONING_XHIGH_OK。
- 最后一次重启后的 Codex Run `arun_261556efbee24131bc6dc4da4f9b232d` 已在真实 adapter-host 日志保存 `requested_effort=xhigh`、`native_effort=xhigh`、`outcome=mapped`，与早先缺少档位字段的记录明确区分。
- OpenClaw / OpenCode 降档已做原生载体自动化断言；未逐一运行所有提供方、底层模型与档位。自动化 fake provider 测试不等于真实提供方执行。

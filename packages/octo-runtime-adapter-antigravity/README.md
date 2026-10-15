# Antigravity Adapter

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../.octospec/rules/context-input.md) 与 [IPD-SE](../../.octospec/rules/context-input.md)。Host 仅按白名单 pattern 保序拼接，不做业务检查或编译。

通过本机 `agy` 的 stdin / stdout NDJSON 执行单轮请求。执行引擎类型为 `antigravity`，首期以 `agy 1.3.3` 为最低版本。

## 运行条件

1. 在本机安装并登录 Antigravity CLI，使 Runtime 的 PATH 能解析 `agy`。
2. 选择 `full_access`。此模式传递 `--dangerously-skip-permissions --mode accept-edits`；不支持 `ask` / `assisted`，不自动提升权限。
3. 使用 CLI 已配置的默认模型，或在设置页填写 CLI 可接受的原生模型 ID。模型值原样作为一个参数传入，不猜测模型别名。

探测只检查程序路径和版本，不代表账户登录、额度或模型调用已经通过。`command` 可指定实际程序路径；`agy-yolo` 是 shell 别名，不能作为后台程序名。

```js
import { createAntigravityAdapter } from "@mininglamp-oss/octo-runtime-adapter-antigravity";

const adapter = createAntigravityAdapter({ command: "/path/to/agy" });
```

## 输入与能力边界

使用 [官方 stdin 格式](https://antigravity.google/docs/cli/headless/)，发送一条 `event=user` 的消息，读取一轮 `result` 后回收本次 CLI 进程。会话续接只使用明确的 `--conversation`，不使用最近会话。

CLI 没有独立 system-prompt 参数。本 adapter 将可信控制指令和用户输入作为两个带标签的 text block 传入同一 user 消息。这是已记录的指令降级，不是原生 system role。不会创建或覆盖用户的 `AGENTS.md`，也不会修改全局 CLI 设置。

实现文本、工具、会话和用量事件。每次执行的 normalizer 独立；重复工具终态和已完成消息重放不重复输出。根成功要求有效 `SUCCESS` result 和非空回答，退出码 0 本身不能证明成功。

CLI result usage 可能覆盖整个会话，优先统计本轮 DONE step usage。恢复会话但没有 step usage 时不报告无法归属本轮的累计用量。私有或未知公开性的思考正文不转为公开事件。

`--print-timeout 0` 由本机 1.3.3 帮助确认可用；执行时限与取消仍由 Runtime watchdog 管理。取消通过 SDK 回收 POSIX 进程组，并在 1 秒后对仍运行的进程升级为 SIGKILL。Windows 的后代进程回收尚未做实机资格验证。

共享 InvokeRequest 已删除动态 MCP 与 Runtime 准备的技能字段，旧字段在协议边界直接拒绝。CLI 本机已有配置继续由 CLI 管理；Adapter 不安装或注入工具。图片输入目前不支持，启动前拒绝。命令构建接受合法 `--effort` 参数；Work App 首期只开放模型选择，推理强度控件待真实模型资格验证后开放。

## 验证

- `test/antigravity-adapter.test.js` 使用假 CLI 验证参数、事件、错误、续接、取消、日志清理与用户文件保留。
- [Adapter 开发指南](../../.octospec/guides/adapter-authoring.md) 说明接入合同与验收要求。
- 真实账户调用、工具执行、会话恢复与线上测试环境闭环须另行记录；自动测试通过不代表这些场景已通过。

## 模块责任边界

- 负责：将 antigravity 原生执行协议映射为 InvokeRequest / CanonicalEvent，由 adapter-host 调用。
- 不负责：Worker/IM WS、聊天历史、Event/AgentRun 登记。
- 协作边界：见 [根架构与包边界](../../README.md#模块责任边界)。所有执行来源共用 adapter-host IPC；模块按职责提供协议、执行或宿主能力。

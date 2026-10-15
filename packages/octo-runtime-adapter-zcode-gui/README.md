# ZCode GUI Adapter

> 全局 Context 约束：本轮模型上下文由业务方选择，selection 等业务项可不发送，可传空或显式重复。必要执行配置独立校验且不注入 LLM。底层只转发并渲染本轮数据，不按 sessionId 缓存、补齐、合并、去重或省略；reset／新 Provider 会话／resume 失败后由业务方重新提供必要背景。见 [分类矩阵](../../.octospec/rules/context-input.md) 与 [IPD-SE](../../.octospec/rules/context-input.md)。Host 仅按白名单 pattern 保序拼接，不做业务检查或编译。

`zcode-gui` 直接启动 ZCode Desktop 随附的 `zcode.cjs app-server --stdio`，通过 ZCode 私有的
逐行 JSON 双向协议执行 AgentRun。它不控制 Electron 窗口，也不依赖 `zcode-acp-server`；后者仅作为协议和事件映射的公开参考实现。

## 边界

- adapter 不感知 `octo-auth`，不接收或校验 Octo 用户、Runtime token。Agent Worker 完成业务授权后，通过既有 WSS Runtime 协议向 daemon 下发 `run.start`。
- ZCode 的模型登录态由 ZCode CLI 自己保存在用户目录。adapter 不把 API key 写入 argv、prompt、canonical event 或工作目录。
- ZCode 工具授权是 provider 内部回调。默认 `build` 模式 fail-closed；只有 Agent revision 显式设置 `autoApprove: true`、`dangerouslyBypassPermissions: true` 或 `permissionMode: "yolo"` 时，adapter 才回复 `{decision:"allow"}`。

## 进程与协议

每次 invocation 启动一个 app-server，依次执行：

```text
session/resume（有 provider session 时）或 session/create
  -> session/subscribe
  -> session/send
  -> session/event 流
  -> turn.completed / turn.failed
  -> 关闭整个子进程组
```

`session/requestRuntimePreferences` 会用禁用 memory、native search enhancement 和 AskUserQuestion 自动回答的默认值应答。`interaction/requestUserInput` 当前没有 Runtime canonical interaction 通道，因此除显式 auto-approve 的 plan approval 外一律 decline。Cron 工具默认从 app-server 的工具目录中禁用，因为 Runtime 尚未实现 ZCode 的 `automation/*` host 回调。

## 安装与登录

从 [ZCode 官方安装页](https://zcode.z.ai/cn/docs/install) 下载桌面应用，首次启动后连接 Z.ai、BigModel 或 API Key。adapter 会先查 `ZCODE_BIN`，再查 PATH，最后查各平台桌面安装目录。

macOS 可直接验证桌面包内 CLI：

```bash
node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs --version
node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs login
```

Linux/Windows 若安装器提供了 `zcode` 命令，可运行：

```bash
zcode --version
zcode login
```

当前 CLI 要求显式模型 provider 配置，登录成功后会写入 `~/.zcode/cli/config.json`。不要从 GUI 配置中手工复制或提交 API key。非标准安装位置只需给 daemon service 配置绝对路径：

```bash
export ZCODE_BIN=/absolute/path/to/zcode.cjs
```

## Runtime 配置

```bash
pnpm cli adapter probe zcode-gui
```

Agent revision 的 execution profile 使用 `adapter_type: "zcode-gui"`。常用 `agent_config`：

```json
{
  "workdir": "/absolute/workspace",
  "permissionMode": "build",
  "autoApprove": false,
  "providerOptions": {
    "appServerRequestTimeoutMs": 30000
  }
}
```

无人值守写操作必须由 Agent revision 明确开启，例如 `autoApprove: true`；`workdir` 和 permission 回包都不是安全沙箱，生产节点仍需使用独立 OS 用户、容器或 VM 限制文件、网络和凭据范围。

## 模型配置与环境变量

当前 `zcode-gui` **不支持** Revision 级 `execution_profile.agent_config.model`。实测版本的 app-server `session/create` 只接受 workspace/mode，CLI 虽可在交互会话中使用 `/model`，但没有已验证的 app-server 选模 RPC。管理端因此禁用该字段，API 也拒绝为此 adapter 保存非空模型值；执行时使用 ZCode 登录态/配置中的默认模型。

`ZCODE_BIN` 仅用于指定 `zcode.cjs` 的路径，不是模型变量。当前没有确认到可供 daemon 按 Agent 覆盖模型的 ZCode 环境变量。后续只有在 ZCode app-server 提供稳定的 per-session/per-turn 选模协议并补充 contract test 后，才能把此项改为支持。

## 模块责任边界

- 负责：将 zcode-gui 原生执行协议映射为 InvokeRequest / CanonicalEvent，由 adapter-host 调用。
- 不负责：Worker/IM WS、聊天历史、Event/AgentRun 登记。
- 协作边界：见 [根架构与包边界](../../README.md#模块责任边界)。所有执行来源共用 adapter-host IPC；模块按职责提供协议、执行或宿主能力。

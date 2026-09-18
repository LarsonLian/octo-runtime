# ZCode GUI Adapter

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

`session/requestRuntimePreferences` 会用禁用 memory、native search enhancement 和 AskUserQuestion 自动回答的默认值应答。`interaction/requestUserInput` 当前没有 Harness canonical interaction 通道，因此除显式 auto-approve 的 plan approval 外一律 decline。Cron 工具默认从 app-server 的工具目录中禁用，因为 Harness 尚未实现 ZCode 的 `automation/*` host 回调。

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

## Harness 配置

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

# OpenClaw 忽略 Harness 工作区验证

日期：2026-10-14。

OpenClaw Adapter 声明 `metadata.workspace: false`。Runtime 按声明跳过目录检查、创建、随机分配及 Provider 状态目录准备，提交 `workspace_mode: "none"` 的回执。指定工作区被忽略时回执记录 `CONTEXT_WORKSPACE_IGNORED`。Worker 接受 OpenClaw 的 none 回执，但仍校验 Context hash、Run、租约、fencing 和冻结计划；拒绝声称已准备本地工作区的回执。Adapter 不再拒绝 preset 的非空 workdir，Gateway 请求不传 cwd/workdir/workspace。

## 本次实测

- `pnpm build`：通过。
- Harness 相关测试两组：90 项和 318 项通过（两组包含部分重复测试）。覆盖 preset/provisioned × fixed/random、缺失目录、无目录副作用、Host 实际调用、Gateway 参数及其他 Provider 回归。
- Worker `go test ./internal/domain ./internal/service`：通过。
- Worker `go build ./cmd/server ./cmd/migrate`：通过。
- 修改的 TypeScript 实现文件 ESLint 与两个仓库 `git diff --check`：通过。
- 本机真实 OpenClaw Gateway：playboard 使用 main、preset、fixed workspace `/tmp/octo-openclaw-ignored-nonexistent-non-git`，请求仅回复 OK、不使用工具。Run `run_34cab827-5a14-4414-a86a-0f8b241232a0` 返回 OK 和 `run.completed`，进程退出码 0；调用后指定目录仍不存在。
- 本机测试 daemon `/tmp/octo-harness-im-codex-test` 按原 foreground run 方式重启，daemon PID 38634、Adapter Host PID 38635，均为 ready，IM 连接恢复 online，`draining: false`。该 Home 未安装 launchd service，使用进程重启而非安装新服务。

## 验证范围

真实 Gateway 验证通过本机 playboard 启动的新 Adapter Host 完成。Runtime 到 Worker 的准备回执通过 HTTP fixture 与 Worker service 测试分别验证；本次未执行线上 im-test 的 OpenClaw Run，也未部署 Worker 服务。Context 快照仍保留原工作区配置；忽略执行效果不等于跳过协议格式及冻结计划校验。

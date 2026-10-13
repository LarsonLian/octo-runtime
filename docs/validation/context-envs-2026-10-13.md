# envs Context 验证记录（2026-10-13）

最终格式为 `payload.env_variables: [{ key, value }]`，执行计划也保留列表结构。旧字典格式、重复 key、缺少 value 和未知字段均拒绝。

本次在当前分支修改 Harness 与相邻 Worker，协议保持 Context v3 / Run 7 / Adapter transport 2。桌面应用使用链接的 Harness 包，没有新增 UI 或变更桥接口。此前及并行产生的其他文档修改保持原样。

## 本次通过

| 检查 | 结果 |
| --- | --- |
| Harness `pnpm build` | 通过，生成协议类型并构建全部包与应用。 |
| Harness 根 `tsc --noEmit` | 通过。 |
| Harness 全量 Node 测试，concurrency=4，并开启原生 MCP live 测试 | 934 项：929 通过、5 条其他有条件 live 测试跳过、0 失败。 |
| Worker `go test ./...` | 通过。Go 与 TypeScript 使用相同 Context/configuration fixtures。 |
| Work App `pnpm build` | 通过，包含 Electron/Vite 构建与 TypeScript 校验。 |
| 并发 CLI 子进程 | 两次并发调用及各自工具子进程读取不同值；宿主 `process.env` 未改变。 |
| 真实 Codex app-server + 临时 stdio MCP | 使用列表请求，MCP 读取指定普通值和空字符串；未发起模型请求；用户原生配置没有写入。 |
| 真实 Codex 模型 Run + shell | 使用列表请求，Run 完成为 `run.completed`；shell 写出的临时文件匹配仅由 envs 提供的随机测试值，提示词中没有该值。临时工作目录已清理。 |
| Worker 重建与重启 | 通过 `make restart` 构建并重启；本地 8392 readiness 通过。 |
| 桌面及内置 Harness 重启 | 通过真实 renderer CDP 检查：已登录、serverUrl 为 `https://im-test.deepminer.com.cn`、内置 Runtime cloudConnected=true，服务端列表中状态为 online。 |
| 差异格式 | Harness/Worker `git diff --check` 通过。 |

真实模型验证只运行了本地 `node -e` 命令，将 `OCTO_ENVS_LIVE_PROBE` 写入临时文件并比较；未发送 IM、邮件或其他对外消息。

## 检查限制

- 全量 ESLint 未通过：仓库现有未修改逻辑包含 no-base-to-string、unbound-method、unused-vars 等错误。本次新增 environment 实现与修改的协议校验/合并文件的定向 ESLint 已通过，没有把全量 lint 记录为通过。
- 第一次高并发全量测试出现一次 Provider 版本探测的 2 秒超时；该测试独立复测通过，随后 concurrency=4 的完整回归通过。
- 本次验证了 im-test 登录身份和本地 Runtime 重新注册。没有部署云端 Worker，也没有把本地服务验证当作云端发布验证。
- 没有通过桌面用户会话提交带 envs 的完整 Worker→桌面 Run；Worker 合并/冻结由 Go 测试覆盖，真实 CLI/MCP 执行由 Harness 原生适配器验证。其他 Provider 的完整模型执行未逐一实测。
- 远程 MCP 进程不继承本机 envs；OpenClaw Gateway 非空 envs 明确拒绝。详见 [协议说明](../context-envs.md)。

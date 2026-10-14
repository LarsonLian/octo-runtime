# Run MCP Context 验证记录

日期：2026-10-14。协议见 [Run MCP 执行配置](../25-run-mcp-context.md)。以下均为本轮执行结果，不引用历史验收作为通过证据。

## 自动验证

| 范围 | 命令 / 方法 | 结果 |
| --- | --- | --- |
| Harness 构建与生成类型 | `pnpm build` | 通过 |
| Harness 完整测试 | `node --test test/*.test.js packages/octo-runtime-protocol/test/*.test.js` | 871 项，862 通过、9 跳过、0 失败；原生 MCP 测试默认跳过，另行运行 |
| MCP 合同 | Schema / TypeScript / Go 共用 Context fixtures | 通过；包含动态名称、模板 URL、非法结构、重复 header 和 transport 混合字段 |
| 执行行为 | `test/context-mcp.test.js` | 通过；覆盖 defaults / mandatory、冻结核对、单次变量展开、并发隔离、不注入模型、Adapter 映射与 ACP 恢复 / fallback |
| 修改的 TypeScript 实现 | ESLint | 通过 |
| Worker | `go test ./...`；最终 `go test ./internal/domain ./internal/service` | 通过 |
| Worker 构建 | `make build` | 通过 |
| Work App | `pnpm build`（包含 TypeScript 检查） | 通过 |

## 原生 MCP 连接

通过 `OCTO_RUN_MCP_LIVE=1 node --test test/context-mcp-live.test.js` 的测试入口分组执行。测试服务绑定本机回环地址，只使用合成 token；断言服务端收到的 `tools/list` 及鉴权 header，不根据模型回答推断连接成功。

- Codex：通过；app-server 会话级配置连接 HTTP MCP，正确展开 header，保留 `${…}` 字面量；原生配置文件及 `config/read` 结果未被持久修改。
- Claude Code：通过；临时配置连接 HTTP MCP，鉴权 header 正确。实测原生运行时会再次展开 `${…}`，所以 Adapter 拒绝无法保留的最终占位符文本；单测验证 `MCP_LITERAL_UNSUPPORTED`。
- Kimi：通过；ACP 声明 HTTP 能力，`session/new` 后收到正确鉴权的工具发现请求，保留字面量。
- MCode：通过工具发现；该版本延迟至 prompt 才连接。模型调用因账户额度失败，但服务端已收到正确鉴权的 `tools/list`，并保留字面量。

OpenCode 本轮验证配置转换，未做原生 HTTP 连接验证。模型实际 `tools/call`、原生 stdio 子进程连接、原生恢复后的凭据刷新，以及本地配置同名冲突的所有 Provider 行为，均未作为本轮实测通过项。

## 重启与内置运行时

- Worker 重新构建并重启，`http://127.0.0.1:8392/health/ready` 返回 ready。此次 MCP 使用现有 JSON 列，不改表、不删库；重启显式关闭自动迁移。
- Work App 重启开发进程，通过 CDP 调用真实 preload 接口：内置 Runtime `phase=running`、`cloudConnected=true`；远端可列出 1 个 Runtime，内置可列出 12 个 Adapter，其中 11 个可用。
- Work App 使用 `https://im-test.deepminer.com.cn` 身份环境和本机 `http://127.0.0.1:8091/agentworker/api` 入口。本轮未通过业务聊天创建云端 Run；上述原生 MCP 执行验证与桌面注册验证分别记录，不合并声称已完成云端端到端工具调用。

本轮只提交 MCP 相关文件；工作区已有的 IM、事件存储和其他并行改动不属于本次提交。

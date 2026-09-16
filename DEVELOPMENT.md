# Octo Harness Development

本文档说明如何在本地开发 `octo-harness`、通过 `npm link` 暴露全局 CLI，并连接
Octo 线上测试环境完成真实链路调试。

## 1. 开发原则

- 单元测试可以使用 fake provider 和临时 SQLite，但真实联调必须连接
  `https://im-test.deepminer.com.cn/`。
- 本地开发的是设备侧 Harness。Human 身份、Space membership 和 enrollment grant 由
  依赖 `octo-auth` 的 Agent Worker 验证，Harness 不自行实现或绕过 Human 鉴权。
- 测试环境的 Agent Worker API 根地址固定为
  `https://im-test.deepminer.com.cn/agentworker/api`。Octo Web/Nginx 去掉
  `/agentworker/api` 前缀后，再转发给 Worker 原生 `/v1/*` 接口。
- 开发时使用独立 Harness Home，避免覆盖正式安装产生的 Runtime 身份、credential、
  SQLite outbox、PID、socket 和日志。
- enrollment token、device credential、Human token 和 provider token 都不能写入 Git、
  日志、命令参数、adapter manifest 或 service definition。

## 2. 组件与鉴权链路

一次完整的 Runtime 注册链路如下：

```text
Octo Web
  -> POST /agentworker/api/v1/runtime_enrollments
  -> octo-auth 验证 Human Token 与 X-Space-ID
  -> 无需请求体，服务端从已验证 UID 生成 owner_ref
  -> 可选请求体 {"kind":"cloud"}，kind 不传默认 local，不影响归属
  -> 返回短期、单次 octo_enroll_ token

octo-harness login
  -> POST /agentworker/api/v1/runtimes/enroll
  -> 使用 octo_enroll_ 换取 octo_runtime_ credential
  -> POST /agentworker/api/v1/runtime/register
  -> 持久化 runtime_id 与 device credential

octo-harness daemon
  -> WSS /agentworker/api/v1/runtime/connect
  -> 接收 run.start/run.cancel
  -> 调用本机 Provider CLI
  -> 回传 canonical events
```

凭证不能互相替代：

| 凭证 | 用途 |
|---|---|
| Octo Human Token | Web 创建 enrollment grant，由 `octo-auth` 验证 |
| `octo_enroll_...` | 单次设备 enrollment，使用后失效 |
| `octo_runtime_...` | Runtime register/WSS，由 Harness 保存在 mode `0600` 文件中 |
| Provider credential | Codex、Claude Code、CodeBuddy 等 CLI 自己管理的模型凭证 |

## 3. 环境要求

- Node.js 24 或更高版本
- pnpm 11
- npm，与当前 Node.js 使用相同的安装前缀
- 需要测试的 Provider CLI 已安装并完成认证
- 可以访问 `https://im-test.deepminer.com.cn/`

检查版本：

```bash
node --version
pnpm --version
npm --version
npm prefix -g
```

本仓库声明的版本为 Node.js `>=24`、pnpm `>=11`。使用 nvm 时，全局 npm link
属于当前 Node.js 版本；切换 Node.js 后可能需要重新 link。

## 4. 安装依赖和构建

在 `octo-harness` 仓库根目录执行：

```bash
cd /Users/lvsijia/codex.mlamp.cn/agent-research/general-harness-research/octo-harness

corepack enable
pnpm install --frozen-lockfile
pnpm build
```

完整的本地质量检查：

```bash
pnpm typecheck
pnpm lint
pnpm test
```

`pnpm test` 会重新构建并执行 Node.js 测试。仓库测试默认不调用真实模型；它们不能替代
线上测试环境的端到端验收。

## 5. 本地 link CLI

在仓库根目录执行：

```bash
npm link --foreground-scripts
rehash
```

根包的 `prepare` lifecycle 会先运行完整的 `pnpm build`，然后 npm 创建全局 package
symlink 和两个命令：

```text
octo-harness          -> apps/cli/dist/index.js
octo-harness-daemon   -> apps/daemon/dist/launcher.js
```

验证 link：

```bash
command -v octo-harness
command -v octo-harness-daemon
npm ls -g @mininglamp-oss/octo-harness --depth=0
octo-harness help
```

link 指向当前 checkout，但 Node.js 实际加载的是已编译的 `dist/*.js`。修改 TypeScript
源码后只需要重新运行 `pnpm build` 并重启 daemon；只有 `package.json` 的 package/bin
元数据变化时才需要重新执行 `npm link`。

不需要全局命令时，也可以直接从源码运行：

```bash
pnpm cli -- --help
pnpm daemon -- --home "$PWD/.tmp/harness-home"
```

## 6. 检查线上测试环境是否就绪

本地登录前先验证线上部署，避免把 ingress 或版本问题误判成本地 Harness 问题。

安装脚本的第一行应为 `#!/bin/sh`，不能是 Octo Web 的 HTML：

```bash
curl -fsSL https://im-test.deepminer.com.cn/octo-harness/install.sh \
  | sed -n '1p'
```

无 credential 探测 Worker 路由时，应得到 Worker 的 JSON 鉴权/参数错误。若返回
`404`、`405` 或 `Content-Type: text/html`，说明请求落入了旧 Web SPA fallback，
`/agentworker/api` 代理尚未部署或没有生效。

```bash
curl -i \
  -X POST \
  -H 'Content-Type: application/json' \
  --data '{}' \
  https://im-test.deepminer.com.cn/agentworker/api/v1/runtimes/enroll
```

Octo Web 部署必须满足：

```text
AGENT_WORKER_API_URL=http://<test-agent-worker-service>:8092
```

Nginx 必须发布以下能力：

- `/octo-harness/install.sh` 和 `/octo-harness/install.ps1` 返回当前版本安装器；
- `/agentworker/*` 去掉公开前缀后转发到 Agent Worker；
- `/agentworker/api/v1/runtime/connect` 支持 WebSocket Upgrade。

### 当前测试环境状态

2026-09-10 实测：

- `/octo-harness/install.sh` 返回 Octo Web HTML，不是 shell 安装器；
- `/agentworker/api/v1/*` 返回 HTML/405，未进入 Agent Worker。

因此当前可以完成本地 build 和 link，但在部署新版 `octo-web`、配置
`AGENT_WORKER_API_URL` 并暴露 Agent Worker 前，不能完成线上 Runtime 注册和 WSS
端到端验收。

## 7. 创建开发用 Runtime 身份

先在测试环境的 Runtime Device onboarding 页面生成一次性 `octo_enroll_...` token。
每次重新 enrollment 都应使用新的 token。

在 zsh 中隐藏读取 token，并使用仓库内已忽略的 `.tmp/harness-home`：

```bash
cd /Users/lvsijia/codex.mlamp.cn/agent-research/general-harness-research/octo-harness

OCTO_HARNESS_DEV_HOME="$PWD/.tmp/harness-home"
read -rs "OCTO_ENROLL_TOKEN?Enrollment token: "
printf '\n'

printf '%s\n' "$OCTO_ENROLL_TOKEN" | octo-harness \
  --home "$OCTO_HARNESS_DEV_HOME" \
  login \
  --server-url https://im-test.deepminer.com.cn \
  --agent-work-url https://im-test.deepminer.com.cn/agentworker/api \
  --enroll-token-stdin

unset OCTO_ENROLL_TOKEN
```

同域部署时可以省略 `--agent-work-url`，CLI 默认使用
`SERVER_URL/agentworker/api`；只有 Worker 使用其他 origin 或 API 根路径时才需要显式覆盖。

After first login, the profile is bound to its trusted server, Agent Worker,
server-assigned `runtime_id`, and protected Runtime credential. Profiles share
the Home-global `machine_id` but not credentials or Runtime IDs. Use a new
profile for another binding; mutually untrusted users need separate OS accounts.

Runtime identity/configuration uses `octo_space_id` and `owner_ref` (for example
`uid:alice` or `org:engineering`), not `tenant_id` / `subject_id`. Human grant
ownership is derived from octo-auth, never from a request body. The daemon publishes
provider objects containing type, installed version/path, availability, and
adapter capabilities. See [the breaking owner/provider contract](docs/runtime-owner-provider-contract.md).

## 8. 前台启动和调试 daemon

开发阶段不要安装系统服务，直接以前台进程运行，便于看错误和重启：

```bash
cd /Users/lvsijia/codex.mlamp.cn/agent-research/general-harness-research/octo-harness
OCTO_HARNESS_DEV_HOME="$PWD/.tmp/harness-home"

octo-harness --home "$OCTO_HARNESS_DEV_HOME" daemon run
```

前台进程默认使用 Node.js 内置 `styleText()` 在 stderr 显示脱敏的生命周期状态：

```text
✓ Daemon ready pid=12345
✓ Local Agent Work runtime registered runtime=runtime_xxx
● Agent Work WebSocket connection starting attempt=1
✓ Agent Work WebSocket connection opened runtime=runtime_xxx attempt=1
✓ Agent Work runtime is online runtime=runtime_xxx
← Agent Work command received run=run_xxx type=run.start
→ Run execution started run=run_xxx
✓ Run execution completed run=run_xxx
```

需要完全静默时使用：

```bash
octo-harness --home "$OCTO_HARNESS_DEV_HOME" daemon run --quiet
```

启动失败时默认只输出一行适合日常使用的错误，例如：

```text
❌ Octo Harness daemon is already running with pid 12345
```

需要定位启动异常时使用 `--verbose` 查看完整错误堆栈：

```bash
octo-harness --verbose --home "$OCTO_HARNESS_DEV_HOME" daemon run
```

`--verbose` 同时启用 daemon 的 debug 日志、RPC trace 和完整 provider I/O capture，
只应在受控调试环境中使用；敏感 trace 写入受保护的 Harness 日志目录，不输出到普通终端。

另一个终端使用相同 Home 检查状态：

```bash
cd /Users/lvsijia/codex.mlamp.cn/agent-research/general-harness-research/octo-harness
OCTO_HARNESS_DEV_HOME="$PWD/.tmp/harness-home"

octo-harness --home "$OCTO_HARNESS_DEV_HOME" status
octo-harness --home "$OCTO_HARNESS_DEV_HOME" adapter list
octo-harness --home "$OCTO_HARNESS_DEV_HOME" adapter probe codex
octo-harness --home "$OCTO_HARNESS_DEV_HOME" logs path
octo-harness --home "$OCTO_HARNESS_DEV_HOME" agent-session list
octo-harness --home "$OCTO_HARNESS_DEV_HOME" agent-run list
```

通过标准：

- `status.agentWork.connected` 为 `true`；
- 返回的 `runtimeId` 与 login 持久化的 Runtime 一致；
- 目标 adapter probe 成功；
- 测试环境 Runtime 列表中显示该 Runtime Online；
- 从测试环境提交真实 AgentRun 后，本机收到 `run.start`，Provider 执行并回传终态事件。

仅仅看到本地 daemon Ready 不表示线上链路已经打通。

## 9. 日常开发循环

当前仓库没有统一 watch 脚本。每次修改源码后执行：

```bash
pnpm build
```

然后结束正在前台运行的 daemon，再重新启动：

```bash
octo-harness --home "$OCTO_HARNESS_DEV_HOME" daemon run
```

建议每次改动至少完成以下检查：

```bash
pnpm typecheck
pnpm lint
pnpm test
```

涉及 Runtime transport、enrollment、register、WSS、outbox 或 provider adapter 的改动，
还必须在 `im-test` 提交真实 AgentRun，验证完整事件链路。

## 10. 可选：安装当前用户服务

只有前台联调稳定后才安装用户服务。已有 identity 时不需要再次输入 enrollment token：

```bash
octo-harness --home "$OCTO_HARNESS_DEV_HOME" daemon install
octo-harness --home "$OCTO_HARNESS_DEV_HOME" daemon start --wait-online
```

源码更新并 `pnpm build` 后重启服务：

```bash
octo-harness --home "$OCTO_HARNESS_DEV_HOME" daemon restart
```

开发时优先使用前台 `daemon run`，因为系统服务可能继续运行旧进程，造成“代码已构建但
行为没有变化”的错觉。

## 11. 常见问题

### `octo-harness: command not found`

```bash
npm prefix -g
npm link --foreground-scripts
rehash
command -v octo-harness
```

如果刚切换过 nvm Node.js 版本，需要在新版本的 npm prefix 下重新 link。

### 修改源码后行为没有变化

link 不会直接执行 TypeScript 源码。重新运行 `pnpm build`，并重启前台 daemon 或用户服务。

### `ECONNREFUSED 127.0.0.1:8092`

当前 Home 仍绑定本地 Agent Worker。线上调试应使用：

```text
https://im-test.deepminer.com.cn/agentworker
```

不要覆盖已有身份；使用新的 `.tmp/harness-home` 和新的 enrollment token。

### 登录返回 404、405 或 HTML

检查是否传入了完整的 `--agent-work-url`，然后执行第 6 节的线上 readiness 检查。若
`/agentworker/api/*` 仍返回 SPA HTML，需要先修复测试环境部署，不是重复 npm link。

### profile 已绑定另一个 server/Worker

A Home may hold multiple trusted profiles, each with its own Runtime identity.
Use a new `--profile` for another binding; do not copy or modify credential files.

### Runtime 没有 Online

依次检查：

```bash
octo-harness --home "$OCTO_HARNESS_DEV_HOME" status
octo-harness --home "$OCTO_HARNESS_DEV_HOME" logs path
octo-harness --home "$OCTO_HARNESS_DEV_HOME" adapter list
```

同时确认测试环境 Nginx 支持 WebSocket Upgrade，Agent Worker 已启动，Runtime credential
未撤销。

### adapter probe 失败

确认对应 Provider CLI 在 daemon 所在 OS 用户下可执行并已认证。Provider credential 与
Octo Runtime credential 是两套独立凭证。

## 12. 清理

移除全局 link：

```bash
npm unlink --global @mininglamp-oss/octo-harness
rehash
```

开发 Home 包含 Runtime 身份、device credential 和本地执行状态。不要直接删除仍在使用的
Home；先停止 daemon，并确认该测试 Runtime 不再需要。需要撤销设备身份时，应先在服务端
撤销 credential，再按明确的清理流程处理本地 Home。

## 13. 相关文档

- [README.md](README.md)：架构边界、安装入口和 Runtime 基础用法
- [DEPLOYMENTS.md](DEPLOYMENTS.md)：本地 link、连接 Worker 和 npm 发布约定
- [apps/cli/README.md](apps/cli/README.md)：CLI、service、doctor 和诊断命令
- [docs/13-agent-work-runtime.md](docs/13-agent-work-runtime.md)：Agent Worker Runtime 协议
- `../octo-web/nginx.conf.template`：测试环境 `/agentworker/api` 反向代理
- `../octo-agent-worker/docs/01-http-api.md`：enrollment、register 和业务 API

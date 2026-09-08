# Octo Harness Deployment

本文档说明本地 `npm link`、连接 `octo-agent-worker` 和 npm 全局发行约定。最终用户的一键入口见根 [README](README.md) 与 [installers](installers/README.md)。

## 1. 本地编译并 link

要求 Node.js 24+、pnpm 11。首次 checkout 或依赖变化后先安装 workspace 依赖：

```bash
corepack enable
pnpm install --frozen-lockfile
```

在仓库根目录执行：

```bash
npm link --foreground-scripts
```

根包的 `prepare` lifecycle 会先执行完整的 `pnpm build`；构建成功后，npm 再创建全局
package symlink 和以下命令：

```text
octo-harness          -> apps/cli/dist/index.js
octo-harness-daemon   -> apps/daemon/dist/launcher.js
```

验证 link：

```bash
command -v octo-harness
command -v octo-harness-daemon
octo-harness help
```

link 指向当前 checkout，但运行的是编译后的 `dist/*.js`。修改 TypeScript 源码后执行
`pnpm build`；只有 `package.json` 的 bin/link 元数据发生变化时才需要重新执行 `npm link`。

移除全局 link：

```bash
npm unlink --global @mininglamp-oss/octo-harness
```

## 2. 连接 octo-agent-worker

`octo-harness daemon` 可以直接注册为 agent-worker 的 local Runtime 并建立 WSS 连接。先启动
agent-worker，并确认它的 `RUNTIME_AUTH_TOKEN`：

```bash
cd ../octo-agent-worker
cp .env.example .env
# 编辑 MYSQL_DSN；开发默认 RUNTIME_AUTH_TOKEN=dev-runtime-token。
./start.sh
```

再启动已 link 的 harness：

```bash
export OCTO_HARNESS_AGENT_WORK_RUNTIME_TOKEN=dev-runtime-token

octo-harness daemon \
  --agent-work-url http://127.0.0.1:8092 \
  --agent-work-tenant-id tenant-1 \
  --agent-work-subject-id device-local-1 \
  --agent-work-runtime-name octo-harness-local
```

另一个终端检查连接：

```bash
octo-harness status
```

`status.agentWork.connected` 应为 `true`，并返回已注册或复用的 `runtimeId`。默认不必指定
Runtime ID；daemon 会根据 fingerprint 向 worker 注册或复用 Runtime。需要绑定固定 ID 时增加：

```bash
--agent-work-runtime-id runtime_...
```

也可以完全使用环境变量，适合进程管理器和容器：

```bash
export OCTO_HARNESS_AGENT_WORK_URL=http://127.0.0.1:8092
export OCTO_HARNESS_AGENT_WORK_RUNTIME_TOKEN=dev-runtime-token
export OCTO_HARNESS_AGENT_WORK_TENANT_ID=tenant-1
export OCTO_HARNESS_AGENT_WORK_SUBJECT_ID=device-local-1
export OCTO_HARNESS_AGENT_WORK_RUNTIME_NAME=octo-harness-local

octo-harness daemon
```

CLI 参数覆盖对应的非敏感环境变量。Runtime token 没有 CLI 参数，只允许通过
`OCTO_HARNESS_AGENT_WORK_RUNTIME_TOKEN` 注入，避免 secret 出现在 shell history、`ps` 和服务
定义的 `ExecStart` 中。

## 3. Token 约定

agent-worker 与 harness 使用的是同一份 Runtime credential，但两端变量名不同：

| 进程 | 环境变量 | 作用 |
|---|---|---|
| `octo-agent-worker` | `RUNTIME_AUTH_TOKEN` | 校验 Runtime register 和 WSS connect |
| `octo-harness` | `OCTO_HARNESS_AGENT_WORK_RUNTIME_TOKEN` | 作为 Bearer token 发给 worker |

两者的值必须完全一致。`npm link` 不生成 token，harness 也不会从相邻仓库、
`~/.octo-harness` 或 agent-worker 的 `.env` 自动读取 token。

开发环境可以显式使用 worker 的 `dev-runtime-token` 默认值。生产环境必须给两端注入同一个
强随机 secret，并且不能使用以下凭证代替：

- `INTERNAL_CREDENTIALS_JSON` 中任一 namespace-scoped service token：agent-worker 业务执行 API 的凭证；
- Codex、Claude Code、CodeBuddy 等 provider token：模型执行凭证，由各 provider CLI 独立管理；
- IM/Bot token：消息通道凭证，与 Runtime transport 无关。

不要把 Runtime token 写入 `config/adapters.json`、Agent revision、workdir、命令参数或 Git。
生产部署应通过 secret manager、容器 Secret 或受限的 service environment file 注入，并在轮换后
重启 worker 和 harness。

## 4. 发布包结构

根包 `@mininglamp-oss/octo-harness` 是面向安装者的 CLI 包，只发布：

```text
apps/cli/dist/
apps/daemon/dist/
apps/adapter-host/dist/
config/adapters.json
README.md
DEPLOYMENTS.md
```

可复用的 `@mininglamp-oss/octo-harness-*` packages 是根包的运行时依赖。正式发布时应先发布
这些 workspace packages，再发布根 CLI 包；apps 自身保持 private，因为它们已经由根包承载。

发布前验证：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm pack --dry-run
```

发布顺序示例，registry 和 access 策略按实际环境配置：

```bash
pnpm --recursive --filter "./packages/**" publish
pnpm publish
```

workspace dependency protocol 由 pnpm 在 pack/publish 时转换为实际版本范围，因此正式发布使用
pnpm，不直接用 npm 发布 workspace。当前实现仍是 single-node reference deployment；多节点生产
部署还需要事务数据库、outbox、worker lease/fencing、控制面鉴权和完整可观测性，详见
[`ARCHITECTURE.md`](ARCHITECTURE.md) 与 [`docs/07-operations.md`](docs/07-operations.md)。

发布后全局安装并启动：

```bash
npm install --global @mininglamp-oss/octo-harness
octo-harness daemon
```

全局 npm prefix 管理 CLI 与 daemon 程序文件；`~/.octo-harness`（Windows 为 `%LOCALAPPDATA%\OctoHarness`）只保存 profile、`runtime_id`、credential、数据库、PID/socket 和日志。原生 service 必须保存绝对 Node 与 daemon entrypoint 路径，不依赖交互 shell PATH；Node/npm prefix 变化后重跑 installer 或 `setup --repair`。

项目内安装并启动：

```bash
npm install @mininglamp-oss/octo-harness
npx octo-harness daemon
```

包名用于安装和依赖声明；`octo-harness` 是稳定的可执行命令名。

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

`octo-harness login` 先以 `octo_enroll_` 向 agent-worker 换取设备凭证，再调用
`/api/v1/runtime/register`。先启动依赖 `octo-auth` 的 agent-worker：

```bash
cd ../octo-agent-worker
cp .env.example .env
# 编辑 MYSQL_DSN、OCTO_APP_SERVER_URL 和 DEVICE_CREDENTIAL_HMAC_KEY。
./start.sh
```

使用 Octo Web 生成的一次性 token 完成源码 profile；`server-url` 是 Octo Web 来源，
`agent-work-url` 是本机 Worker 调试地址：

```bash
printf '%s\n' 'octo_enroll_REPLACE_WITH_ONE_TIME_TOKEN' | octo-harness \
  --home "$PWD/.tmp/harness-home" login \
  --server-url https://im-test.deepminer.com.cn \
  --agent-work-url http://127.0.0.1:8092 \
  --enroll-token-stdin --no-install-service --no-start

octo-harness --home "$PWD/.tmp/harness-home" daemon run
```

另一个终端检查连接：

```bash
octo-harness status
```

`status.agentWork.connected` 应为 `true`，并返回 login 已写入的 `runtimeId`。daemon 从
Harness Home 读取 server URL、Runtime ID 和受保护的 device credential；service argv 与
环境变量都不携带 secret。一个 Home 只运行一个 daemon、一个 enabled profile 和一个 local Runtime，并持有唯一 `system_id`、credential、WSS 和 outbox。不同 profile 使用不同 Home；不同人或互不信任的身份必须使用不同 OS account。

## 3. Token 约定

凭证交换是单向的：Human token 只用于创建短期 enrollment，`octo_enroll_` 只用于一次
设备注册，最终 `octo_device_` 只保存在 Worker hash 与 Harness mode 0600 文件中。它不能用
以下凭证代替：

- `INTERNAL_CREDENTIALS_JSON` 中任一 namespace-scoped service token：agent-worker 业务执行 API 的凭证；
- Codex、Claude Code、CodeBuddy 等 provider token：模型执行凭证，由各 provider CLI 独立管理；
- IM/Bot token：消息通道凭证，与 Runtime transport 无关。

不要把 device token 写入 `config/adapters.json`、Agent revision、workdir、命令参数、service
definition 或 Git。重新授权时使用新的 Human enrollment；Worker 可以单独撤销一台设备凭证。

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
octo-harness daemon run
```

全局 npm prefix 管理 CLI 与 daemon 程序文件；`~/.octo-harness`（Windows 为 `%LOCALAPPDATA%\OctoHarness`）只保存 profile、`runtime_id`、credential、数据库、PID/socket 和日志。原生 service 保存绝对 Node 与 daemon entrypoint 路径，不依赖交互 shell PATH；Node/npm prefix 变化后重跑 installer/login 以重写 service definition。

项目内安装并启动：

```bash
npm install @mininglamp-oss/octo-harness
npx octo-harness daemon run
```

包名用于安装和依赖声明；`octo-harness` 是稳定的可执行命令名。

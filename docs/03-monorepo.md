# 03 Pnpm Monorepo

Octo Harness 使用 pnpm workspace 管理多项目。workspace 边界由根目录 [pnpm-workspace.yaml](../pnpm-workspace.yaml) 定义：

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

根目录的 `docs/`、`config/` 和 `test/` 是仓库级资源，不是独立发布项目。

## 目录职责

```text
apps/
  cli/                  面向用户的 Unix socket CLI
  daemon/               daemon executable 与装配根
  adapter-host/         manifest-driven adapter host executable

packages/
  octo-harness-protocol/             canonical protocol
  octo-harness-core/                 domain engine and stores
  octo-harness-daemon/               scheduling/runtime library
  octo-harness-adapter-host/         adapter lifecycle and RPC library
  octo-harness-adapter-sdk/          adapter authoring helpers
  octo-harness-acp-client/           reusable ACP client
  octo-harness-adapter-*/            provider adapter definitions
```

依赖方向：

```text
apps -> packages
octo-harness-adapter-* -> octo-harness-adapter-sdk / provider protocol helpers
octo-harness-daemon -> octo-harness-core -> octo-harness-protocol
octo-harness-adapter-host -> octo-harness-protocol
```

`packages/*` 不应 import `apps/*`。provider 命令构造、native event parser、session codec 和权限适配必须留在 `packages/octo-harness-adapter-*`；apps 只做配置、进程启动和 I/O 装配。

发布型 package 的目录名与 npm 非 scope 部分完全一致。例如目录 `packages/octo-harness-core` 发布为 `@mininglamp-oss/octo-harness-core`，目录 `packages/octo-harness-adapter-openclaw` 发布为 `@mininglamp-oss/octo-harness-adapter-openclaw`。这样仓库导航、workspace filter、依赖列表和 registry 搜索使用同一名称。

## TypeScript 构建约定

所有 app 和 package 的实现源码均为 `src/*.ts`，统一继承根目录的 [tsconfig.base.json](../tsconfig.base.json)。当前采用 `strict`、`NodeNext` module/module resolution，并开启 declaration 与 source map 输出。

每个 workspace 只把 `src/` 当作源码，把编译结果写到未提交 Git 的 `dist/`：

```text
src/index.ts
   | pnpm build
   v
dist/index.js
dist/index.js.map
dist/index.d.ts
dist/index.d.ts.map
```

可发布 package 的 `exports` 指向 `dist/index.js`，`types` 指向 `dist/index.d.ts`。因此本地 workspace 链接和 npm 安装使用同一套公开入口，不依赖 TypeScript 源文件或 ts-node loader。

VS Code 配置位于 [.vscode/settings.json](../.vscode/settings.json)，固定使用 workspace TypeScript SDK 和 flat-config ESLint。安装推荐的 ESLint 扩展后，编辑器诊断应与命令行一致。

## 安装与常用命令

根 [package.json](../package.json) 固定 `pnpm@11.19.0`：

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm daemon
pnpm cli status
```

查看 workspace：

```bash
pnpm --recursive list --depth -1
```

运行单个 app：

```bash
pnpm --filter @mininglamp-oss/octo-harness-adapter-host-app start
```

查看单个 package 的依赖：

```bash
pnpm --filter @mininglamp-oss/octo-harness-adapter-codex list
```

内部依赖必须使用 `workspace:*`：

```json
{
  "dependencies": {
    "@mininglamp-oss/octo-harness-adapter-sdk": "workspace:*"
  }
}
```

这样 pnpm 安装时只会链接当前 workspace package，不会意外从 registry 拉取同名旧版本。

## 新增 Adapter Package

以 `foo` provider 为例：

1. 创建 `packages/octo-harness-adapter-foo/package.json`、`src/index.ts` 和 `README.md`。
2. 包名使用 `@mininglamp-oss/octo-harness-adapter-foo`，依赖 `@mininglamp-oss/octo-harness-adapter-sdk: workspace:*`。
3. 实现 metadata、probe、invoke、session 和 canonical event mapping。
4. 在 [config/adapters.json](../config/adapters.json) 注册 adapter type/module/export。
5. 在 `apps/adapter-host/package.json` 增加 workspace dependency，确保运行 host 能 import 它。
6. 若根测试直接 import 该包，在根 `devDependencies` 增加 workspace dependency。
7. 在 `test/` 添加 native event、success/error/cancel/session resume 契约测试。
8. README 至少说明包的作用、设计原则、适用场景、明确边界和最小用法，并在 [Packages And Adapter Guide](../packages/README.md) 与 provider matrix 中建立入口。

Core、daemon 和 CLI 不应增加 `if adapterType === "foo"`。新增 provider 差异必须终止在 adapter contract 边界。

## 新增 App

1. 创建 `apps/<name>/package.json` 和 `src/index.ts`。
2. package 标记 `private: true`，命名为 `@octo-harness-ai/<name>` 或 `@octo-harness-ai/<name>-app`。
3. 使用 `workspace:*` 依赖需要的 runtime packages。
4. 在 app package 中提供 `start` script；需要统一入口时再加入根 scripts。

App 可以选择不同 transport 或部署形式，但不能复制一份 Core/Adapter 业务逻辑。

## Lockfile 与 CI

仓库只提交根 `pnpm-lock.yaml`，不提交 `package-lock.json` 或子项目 lockfile。CI 推荐：

```bash
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
```

升级 pnpm 时应同时更新根 `packageManager`、CI 版本和 lockfile；升级 provider CLI 不需要修改 workspace lock，但必须重跑 adapter contract 和受控 live smoke test。

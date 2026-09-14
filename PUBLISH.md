# Octo Harness 发布规则

本文定义 workspace package、根发行包和 private app 的版本与发布规则。

## 发布单元

- `packages/*` 是可独立发布的 npm package，各自维护版本。
- 根包 `@mininglamp-oss/octo-harness` 是用户安装的产品包，提供 CLI 和 daemon 命令。
- `apps/cli`、`apps/daemon`、`apps/adapter-host` 保持 `private: true`。它们与核心 fixed group 统一
  版本，但不单独发布、不创建 package tag；编译后的 `dist` 由根包直接携带。

用户只需要安装根包：

```bash
npm install --global @mininglamp-oss/octo-harness
```

## 版本含义

`octo-harness version` 只报告根包版本。根包与 CLI、daemon、adapter-host app 属于同一个 fixed
group，因此这个版本也表示实际运行的 app 版本。它不等于任一 provider adapter 的版本，也不
要求所有 `packages/*` 使用同一个版本。

根包使用普通的 `^0.1.0` 范围引用可独立加载的 provider adapters。例如：

```json
"@mininglamp-oss/octo-harness-adapter-codex": "^0.1.0"
```

仓库通过 `linkWorkspacePackages: true` 和 `preferWorkspacePackages: true` 在本地自动链接满足范围的
workspace package；根 `package.json` 不需要为此使用 `workspace:` 协议。发布后 npm 从 registry
解析同一兼容范围内的版本。

当前项目仍处于 `0.x`，`^0.1.0` 接受 `0.1.x`，但不接受 `0.2.0`。因此 provider adapter 可以在
`0.1.x` 内独立修复和发布，同时避免未经验证地跨越兼容性边界。

daemon、core、protocol、adapter-host、adapter-acp、observability、cross-service 等 Runtime 内部
packages 在根包中使用显式精确版本，例如 `"0.1.0"`。这些组件共同构成 Harness 的运行时兼容
边界；不能在根版本不变时浮动升级，否则同一个 `octo-harness` 版本会在不同安装时间解析出不同
的核心组件组合。内部 package 升级时必须更新并发布根包。

workspace 子包之间使用 `workspace:^`。pnpm 发布子包时会把它转换为对应依赖的兼容 `^` 范围，
本地开发则始终链接 workspace 源码。这样核心 patch 升级不会迫使所有未修改的 provider adapter
发布新版本；跨出兼容范围时 Changesets 才会把受影响的依赖方加入发布计划。

## 版本升级规则

### 核心固定版本组

`.changeset/config.json` 将根包、三个 private apps、core、protocol、daemon、adapter-host、
observability 和 cross-service 配置为 fixed group。组内任一 package 被 changeset 标记后，整个
核心组统一升级到同一个版本。公开核心 packages 一起发布；private apps 只更新版本和 CHANGELOG，
不发布也不创建 tag。provider adapters、adapter-sdk、adapter-acp 和 acp-client 不属于该组。

### 只修改一个 adapter

兼容范围内只升级并发布该 adapter；根包和其他未修改的 packages 不升级。例如 Codex adapter
修复：

```text
octo-harness-adapter-codex  0.1.0 -> 0.1.1
octo-harness                保持 0.1.0
其他 packages               保持原版本
private apps                与核心根包保持相同版本
```

新安装或更新依赖时，npm 可以在根包声明的 `^0.1.0` 范围内解析到 `0.1.1`。已经安装的环境不会
因为 registry 出现新版本而自动改变，仍需执行产品规定的更新流程。

当 adapter 升级到 `0.2.0`，或者需要改变根包允许的 adapter 范围时，必须同时升级并发布根包，
以建立新的兼容性边界。

### 只修改 CLI、daemon 或 adapter-host app

核心 fixed group 统一升级，只发布根包与公开核心 packages。private app 不单独发布，其版本和
CHANGELOG 会更新，变更随根包中的 `apps/*/dist` 交付。

### 修改共享 package

升级共享 package，并升级真正需要使用新版共享 package 的直接或间接依赖包；最后升级根包。
按照依赖拓扑从底层到上层发布，例如：

```text
protocol / adapter-sdk -> affected adapters -> octo-harness
```

没有受到变更影响的 adapter 不需要为了对齐版本而升级。

### 破坏兼容性的变更

协议、adapter SDK 或 host 接口发生破坏性变化时，必须升级所有受影响的 packages 和根包，并在
发布根包前完成整套兼容性测试。根包版本是经过验证的兼容组合边界。

## 发布流程

开发者不直接修改 `package.json` 版本。每个需要发布的变更执行：

```bash
pnpm changeset
```

选择发生变化的 package 和 SemVer 级别，并提交生成的 `.changeset/*.md`。一个 PR 可以包含多个
changeset；发布时 Changesets 会合并它们并采用每个 package 所需的最高升级级别。

发布负责人执行：

```bash
pnpm changeset status
pnpm changeset version
pnpm install --lockfile-only
```

`changeset version` 统一修改 package 版本、内部依赖范围和 CHANGELOG，并消费已经应用的
changeset 文件。检查 release plan 和 diff 后再完成构建、静态检查、测试与打包检查。

### `pnpm changeset version` 的版本计算

`pnpm changeset version` 不是每执行一次就无条件把版本加一。它只处理尚未消费的
`.changeset/*.md`，并根据文件中声明的 SemVer 级别计算下一版本：

```text
当前版本 0.1.1 + patch = 0.1.2
当前版本 0.1.1 + minor = 0.2.0
当前版本 0.1.1 + major = 1.0.0
```

例如：

```md
---
"@mininglamp-oss/octo-harness": patch
---

修复 profile setup。
```

当当前核心版本为 `0.1.1` 时，执行 `pnpm changeset version` 会把整个核心 fixed group 统一升级为
`0.1.2`。三个 private apps 也会更新为 `0.1.2`，但不会被发布或创建 tag；不属于 fixed group 的
provider adapters 不会因此升级。

命令成功后，上述 changeset 文件会被删除，并把内容写入相关 CHANGELOG。此时再次执行
`pnpm changeset version`，如果没有新的 `.changeset/*.md`，版本不会从 `0.1.2` 继续变为 `0.1.3`。
下一次版本升级必须来自下一份真实变更的 changeset。

`pnpm changeset version` 只生成版本变更，不会发布 npm package。版本结果、CHANGELOG 和 lockfile
应作为 release commit 一起提交；只有后续 `pnpm changeset publish` 才会真正发布 package 并创建
允许创建的 tags。

发布前至少执行：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm pack --dry-run
```

确认待发布内容后统一发布：

```bash
pnpm changeset publish
```

Changesets 按 workspace 依赖关系发布需要发布的新版本并创建 package tags。registry、dist-tag 和
access 参数必须使用目标环境明确配置。禁止重复发布已有版本，也禁止在依赖 package 尚未发布时
先发布引用它的上层 package。发布完成后，从 registry 全局安装刚发布的根包，执行 setup、daemon
启动和线上测试环境连通验证。

## 发布后验证

发布后不要只验证 monorepo link。必须从目标 registry 安装实际发布物，并连接线上测试环境：

```text
https://im-test.deepminer.com.cn/
```

至少验证：

- `octo-harness version` 等于新根包版本。
- npm 实际安装的 adapter 版本等于根包锁定版本。
- `setup --profile=<tenantId>-<userId>` 能完成登录和服务安装。
- daemon 能启动，并且相应 profile 的 Runtime 能连接 Agent Worker。
- 被修改的 adapter 能完成一次真实调用。

更完整的部署结构、凭证约束和安装方式见 [`DEPLOYMENTS.md`](DEPLOYMENTS.md)。

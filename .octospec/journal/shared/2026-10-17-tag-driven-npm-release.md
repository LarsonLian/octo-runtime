---
type: Journal
title: Tag 驱动的单一 npm 发行实施记录
description: 记录占位版本、动态打包、commit 证据、自动发布工作流及本地发行验收。
tags: [release, installation, testing]
timestamp: 2026-10-17T00:00:00Z
---

# Tag 驱动的单一 npm 发行实施记录

## 实施结果

源码根清单和 25 个内部 workspace 清单统一使用 `0.0.0` 非发行占位版本；内部 apps 与
packages 全部 `private: true`。对外仍只发布 `@mininglamp-oss/octo-runtime`，生成包的根
`bin` 保留 `octo-runtime` 与 `octo-runtime-daemon`，内部生产依赖继续通过
`bundleDependencies` 实体化，不访问内部 package registry。

`pack-release.mjs` 接受可选的稳定版 `--version X.Y.Z`，只在临时打包目录中将根包和内部
workspace 版本统一写成发行版本，不修改源码清单。`verify-release.mjs` 新增完整 commit 与
clean 构建门禁；CI 用实际 checkout SHA 验证发行包的 `build-info.commit`，并拒绝正式 dirty
产物。

`Release Publish` 在稳定版 tag push 时自动调用可复用的 `npm Publish`。发布链路要求
annotated tag、严格稳定 SemVer、`main` 祖先和 `0.0.0` 源码模板，随后对 tag SHA 执行完整
Linux/macOS/Windows CI，以 tag 版本生成 artifact，发布 npm 并创建或修复携带同一 tgz 的 GitHub
Release。手工 dry-run 与 Release 故障恢复统一从 `Release Publish` 进入，不存在绕过 Release
的独立 npm 正式发布入口。同版本重跑先比较 registry
`dist.integrity` 与本次 tgz；一致时跳过不可变 npm 版本，不一致时拒绝把另一个产物归入该
tag。不可变版本先使用版本专属 dist-tag，Release 资产完成后由包级协调器重新读取两端状态，
只把最高完整稳定版提升为 npm 与 GitHub latest。历史版本恢复不会降级 latest，不同 tag 并发
完成也会收敛到最高版本。两个现有 latest 指针是不可回退下界；每个 tag 的 Release 资产独立
交付，当前资产短暂缺失时协调器零写并有界重读，替换失败也不会回退；`v0.0.0` 明确保留为
源码占位版本，不能发布。

## 验证证据

- `pnpm typecheck`、`pnpm lint`、`pnpm lint:names`、`pnpm format:check` 通过。
- `pnpm test` 通过：Node 测试 1142 项中 1133 通过、9 项按既有条件跳过、0 失败；WebUI
  Vitest 35 项通过。
- `node scripts/pack-release.mjs --version 1.0.0` 成功生成约 1.4 MiB 的 tgz；连续两次生成的
  SHA-512 相同。
- tgz 根清单为 `@mininglamp-oss/octo-runtime@1.0.0`，包含两个 bin，68 个 bundled
  dependencies 中不存在 `workspace:`、`link:` 或 `file:`；25 个内部 Mininglamp 清单均为
  `1.0.0` 与 `private: true`。
- `verify-release.mjs` 完成空缓存离线全局安装、CLI、daemon、公开类型、外部 Extra、三个内置
  Extra、私有入口阻断和卸载保留 Home 验证；commit 精确为基线
  `957c9b40ec9910b302a5e5b3ed96e0dab72104bf`。本地工作树有本任务改动，故诚实记录
  `dirty: true`；正式 CI 在提交后的干净 checkout 强制 `dirty: false`。
- 双轴代码审查后，手工入口已统一收口到 `Release Publish`，daemon 验收改为真正调用全局
  `octo-runtime-daemon` bin，并补充占位版本与 latest 防回退门禁。在审查修复里程碑
  `d91ba9b58e6a3729404c43ecc2286da7ead60846` 的干净工作树重新打包验证，最终记录
  `version: 1.0.0`、该完整 commit、`dirty: false`、`globalCli: true` 与
  `daemonReady: true`。
- Workflow 与任务 YAML 语法、Prettier 和 `git diff --check` 通过。本机没有 `actionlint`；PR
  上的 Workflow Sanity 仍是 GitHub 语义检查门禁。
- PR review 指出的跨 tag latest 竞态、同版本恢复降级和 Windows daemon 包装进程残留风险均已
  修正。状态与命令边界 fixture 覆盖首次发布、升级、相等恢复、历史恢复、两种并发完成顺序、
  dry-run 零写入、写入期间状态变化及缺少 Release 资产的更高版本；CI 新增 Windows runner，
  停止流程使用 `taskkill /T /F` 回收全局 `.cmd` shim 的整棵进程树。
- Octospec lint 能解析本次任务，但全库链接检查因 worktree 不与 `octo-work-app`、
  `octo-daemon-old` 等兄弟仓库同目录而报告 14 个既有仓外链接失效；没有报出本次新增或修改
  OKF 的格式、规则 ID 或仓内链接问题。

## 首次真实发布恢复

`v1.0.0` annotated tag 已推送并指向合并后的 `main` 提交
`62d10ac46e7c2c3505b42c362229f7b91f328e5b`。首次 `Release Publish` 运行
`39075690718` 在 `Resolve release commit` 阶段失败：`actions/checkout` 将 runner 本地的同名
tag ref 压平成目标 commit，后续 `git cat-file -t` 因此误报 lightweight tag。失败发生在构建、
npm publish 和 GitHub Release 之前，没有产生 registry 或 Release 写入。

修复在类型校验前通过显式远端 refspec 恢复 annotated tag 对象，并使用真实 Git 仓库 fixture
覆盖“本地 ref 已是 commit、远端仍是 annotated tag”的回归场景。修复合并后必须保留现有
`v1.0.0`，从 `Release Publish` 的 `recover` 入口继续同 tag 发布；不得移动或重建 tag。

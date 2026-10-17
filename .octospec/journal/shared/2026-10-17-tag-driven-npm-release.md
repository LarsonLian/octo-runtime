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
Linux/macOS CI，以 tag 版本生成 artifact，发布 npm 并创建或修复携带同一 tgz 的 GitHub
Release。手工 dry-run 与 Release 故障恢复统一从 `Release Publish` 进入，不存在绕过 Release
的独立 npm 正式发布入口。同版本重跑先比较 registry
`dist.integrity` 与本次 tgz；一致时跳过不可变 npm 版本，不一致时拒绝把另一个产物归入该
tag。恢复旧版本使用独立 dist-tag，避免回退 npm 和 GitHub 的 latest 标记；`v0.0.0` 明确
保留为源码占位版本，不能发布。

## 验证证据

- `pnpm typecheck`、`pnpm lint`、`pnpm lint:names`、`pnpm format:check` 通过。
- `pnpm test` 通过：Node 测试 1125 项中 1116 通过、9 项按既有条件跳过、0 失败；WebUI
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
- Octospec lint 能解析本次任务，但全库链接检查因 worktree 不与 `octo-work-app`、
  `octo-daemon-old` 等兄弟仓库同目录而报告 14 个既有仓外链接失效；没有报出本次新增或修改
  OKF 的格式、规则 ID 或仓内链接问题。

本记录不表示已经创建或推送 `v1.0.0` tag，也不表示 npm 或 GitHub Release 已实际发布。
真实发布必须在 PR 合并、tag 指向干净 `main` 提交后由托管工作流完成。

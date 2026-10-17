# GitHub Checks and Releases

This repository publishes one npm distribution: `@mininglamp-oss/octo-runtime`.
Common workflows reuse `Mininglamp-OSS/.github@v1`; directly referenced Actions are
pinned to commits and updated through Dependabot.

## Pull Request Checks

The `CI` workflow runs for every PR targeting `main`, including draft and documentation
PRs, pushes to `main`, manual dispatches and validated release calls. It has no path
filter that could leave its required check waiting indefinitely.

Ubuntu, macOS, and Windows use **Node.js 24.x**, read from `.nvmrc`, and the pnpm version
declared in `package.json#packageManager`. CI explicitly installs ripgrep for the
naming check rather than relying on the runner image. The Ubuntu/macOS matrix executes:

1. `pnpm install --frozen-lockfile`.
2. `pnpm lint`, `pnpm lint:names` and `pnpm format:check`.
3. `pnpm typecheck`, including the workspace build.
4. A lockfile and generated protocol type drift check.
5. `pnpm test:suites`, the same suites used by local `pnpm test` without another build.
6. Single-distribution packaging and offline installation/public API verification.

The complete test entry point includes the existing local debugging WebUI plugin
tests. No production UI or new browser end-to-end gate is introduced. Provider tests
use fakes unless their existing live-test opt-in is explicitly enabled. A dedicated
Windows job builds and packs the distribution, then executes the installed `.cmd`
daemon shim and terminates its full process tree before uninstalling the package.
It also proves that the installed CLI and daemon derive the same named pipe from one
Runtime Home. Platform-independent contract tests exercise the same production path
functions with an explicit Windows platform, but only the hosted Windows job proves
that `.cmd`, PowerShell, named-pipe and `taskkill` behavior works natively. Readiness
uses a bounded overall deadline and reports the last CLI status failure plus bounded
daemon stderr on failure.

`CI Gate` is the stable required check. It runs after the Ubuntu/macOS matrix and the
Windows release verification, including on failure, and rejects any aggregate result other than `success`. Branch protection
requires this check from the GitHub Actions app and an up-to-date branch.

Formatting covers owned source, tests, scripts, JSON/YAML configuration, `.github`
collaboration files and `CONTRIBUTING.md`. Generated output, the lockfile, pinned
upstream browser sources, architecture documentation and historical Octospec records
are outside this formatting gate. `pnpm format` and `pnpm format:check` use identical
file patterns and `.prettierignore`.

Linux uploads the verified `octo-runtime-release` artifact for seven days. Verification
covers empty-cache offline global installation, CLI/daemon entry points, third-party
Extra compilation/loading, and unloading without deleting Home. It does not install
Providers automatically.

Additional workflows provide common-history validation, secret scanning, dependency
review, weekly CodeQL, workflow sanity, PR title checks, labels and release drafting.
Project/Sprint automation is not configured in this repository.

## Main Protection and First-PR Bootstrap

`main` requires a PR, one approval, resolved review conversations, and `CI Gate` from
GitHub Actions. New commits dismiss prior approvals. Administrators follow the same
rules; force pushes and branch deletion are disabled.

The first PR introduces these workflow files into `main`. Its `pull_request` CI can
produce `CI Gate`; metadata workflows using `pull_request_target`, such as title lint,
depend on the base branch already containing their workflow. Do not make those checks
required before they can actually run. A missing, failed or cancelled `CI Gate` blocks
merging; do not bypass protection to compensate for a failed bootstrap.

Hosted results must be verified on the actual PR. Local checks do not establish that
Linux, macOS, Windows or organization reusable workflows have succeeded.

## Automatic Review Requests

[CODEOWNERS](CODEOWNERS) assigns every path to `Jerry-Xin`, `yujiawei` and
`mochashanyao`. GitHub automatically requests these owners for non-draft PRs and
when a draft becomes ready for review, excluding the PR author. No custom workflow
or token is needed. Automatic owner requests use the base branch's file: request
reviewers manually for the initial PR, then merge the file through normal review
before relying on automatic requests for subsequent PRs.

Reviewer requests and approval requirements are separate. The three owners are
requested, while `main` currently requires at least one approval.

## npm 发行

源码清单始终使用非发行占位版本 `0.0.0`。稳定版 annotated tag `vX.Y.Z` 是唯一发行版本
来源，发行时不得提交清单版本变更。`Release Publish` 的手工 `dry-run` 仅适用于已经存在的
tag，例如自动运行在 npm 上传前被取消或失败时进行诊断；创建 tag 会立即触发正式发布，不能
把同一个 tag 用于事前演练。

推送 tag 后，`Release Publish` 校验 tag 及其 `main` 祖先关系，在该提交上调用完整 CI 矩阵，
把 `X.Y.Z` 写入生成包，发布已验证的归档到 npm，再用同一归档创建或修复 GitHub Release。
失败后可通过手工 tag 输入选择 `recover` 重试。npm 已存在的不可变版本会先核对完整性，一致
则跳过而不是覆盖。新版本先使用版本专属 dist-tag 交付，GitHub Release 就绪后由包级
promotion 协调器重新读取两端状态，把 npm 与 GitHub latest 收敛到已完整交付的最高稳定版。
因此恢复当前或旧版本、不同 tag 并发完成以及 promotion 等待项被取代都不会回退 latest。
npm 与 GitHub 的现有 latest 指针同时作为单调下界；每个 tag 的 Release 资产保持独立交付，
不进入可能替换 pending 运行的全局 concurrency group。资产替换期间短暂缺失时，promotion
保持零写并有界重读；替换失败也不会把任一指针降到旧版本。
`dry-run` 读取同一份 npm 与 GitHub 状态，并把本次已验证版本作为只读候选执行相同决策；它只
输出拟执行的 promotion，不创建版本、dist-tag、Release 或资产。dry-run 使用独立的运行级
并发组，不能替换等待中的正式 promotion。

发布需要具备 package publish 权限的 `NPM_TOKEN`，job 同时获得生成 provenance 所需的 OIDC
权限。普通 PR 检查不读取该 secret。所有内部 app 和 package 都是 private，永不独立发布；
生产依赖随唯一的公开根包捆绑。不得在仓库根目录直接执行 `npm publish`，现有 prepack 门禁会
拒绝该路径。

## GitHub Release

Release Drafter 继续在版本之间准备说明。tag 触发的发布工作流仅在 npm 发布成功后创建正式
Release，并上传同一个已验证 tgz。如果 npm 已发布而 Release 创建失败，选择 `recover` 重跑
会跳过一致的 npm 不可变版本并修复 Release；修复现有 Release 不主动清除 latest，最终状态由
包级协调器统一复核。

仓库使用 Apache-2.0，并保留第三方许可证通知。远端发布与 Release 创建仍需单独核验，参见
[初始 CI 记录](../.octospec/journal/shared/2026-10-15-github-open-source-ci.md)。

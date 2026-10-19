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
把 `X.Y.Z` 写入生成包，通过两个独立 matrix job 直接执行 `npm publish`，把同一份已验证的
tgz 分别上传到 npmjs (`registry.npmjs.org`) 和 GitHub Packages (`npm.pkg.github.com`)，
再用同一归档创建或修复 GitHub Release。不使用 `npm stage`、审批或二次转正流程；GitHub
Packages 是真正的 npm registry，与 Release 附件及 Actions artifact 都不是同一功能。
失败后可通过手工 tag 输入选择 `recover` 重试。任一 registry 已存在的不可变版本会先核对
SHA-512，一致则跳过而不是覆盖；恢复时从 npm 或 GitHub Packages 已发布归档复用构建时间，
并核对源码 commit 和 clean 标记，避免另一端缺包时重建出不同归档。
新版本先使用版本专属 `release-X.Y.Z` dist-tag 交付，GitHub Release 就绪后由包级
promotion 协调器重新读取三端状态，把两个 registry 与 GitHub Release 的 latest 收敛到已
完整交付的最高稳定版。完整候选必须存在于两个 registry，并下载对应 Release 附件核对三份
归档的 SHA-512 相同，不能只依赖同名附件判断完整。
因此恢复当前或旧版本、不同 tag 并发完成以及 promotion 等待项被取代都不会回退 latest。
三端的现有 latest 指针同时作为单调下界；每个 tag 的 Release 资产保持独立交付，
不进入可能替换 pending 运行的全局 concurrency group。资产替换期间短暂缺失时，promotion
保持零写并有界重读；替换失败也不会把任一指针降到旧版本。
`dry-run` 读取同一份三端状态，并把本次已验证版本作为只读候选执行相同决策；它只
输出拟执行的 promotion，不创建版本、dist-tag、Release 或资产。dry-run 使用独立的运行级
并发组，不能替换等待中的正式 promotion。

每个 registry 上传后最多等待 20 分钟，并校验可读版本的归档 SHA-512，而不只判断版本号
是否存在。只有 E404 视为不存在；鉴权、网络和完整性错误直接失败。上传请求成功不等于
版本已经公开可读，超时会明确提示检查 registry 处理状态或 staged-version 冲突，不会自动
切换到 stage 或盲目重传。后续恢复仍先检查不可变版本。

npm 发布需要具备 package publish 权限的 `NPM_TOKEN`，job 同时获得生成 provenance 所需的
OIDC 权限。GitHub Packages 使用当前仓库 `GITHUB_TOKEN` 的 `packages: write` 权限，不需要
另配 PAT，且不向该 registry 请求 npm provenance。首次创建的 GitHub package 默认可能是
private；需要公开分发时，应在 package 设置中确认可见性及当前仓库的 Actions 访问权限。
组织策略限制创建 package 时也需要先由管理员放行，workflow 不修改这些安全设置。
普通 PR 检查不读取发布 secret。所有内部 app 和 package 都是 private，永不独立发布；
生产依赖随唯一的公开根包捆绑。不得在仓库根目录直接执行 `npm publish`，现有 prepack 门禁会
拒绝该路径。

## GitHub Release

Release Drafter 继续在版本之间准备说明。tag 触发的发布工作流仅在两个 registry 发布成功后创建正式
Release，并上传同一个已验证 tgz。这里的前置条件是 npm 和 GitHub Packages 两个发布 job
均成功。如果任一 registry 已发布而另一端或 Release 创建失败，选择 `recover` 重跑会跳过
一致的不可变版本并补齐缺失交付；修复现有 Release 不主动清除 latest，最终状态由
包级协调器统一复核。

仓库使用 Apache-2.0，并保留第三方许可证通知。远端发布与 Release 创建仍需单独核验，参见
[初始 CI 记录](../.octospec/journal/shared/2026-10-15-github-open-source-ci.md)。

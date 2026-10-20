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

## Secret Scan：历史告警与精确例外

共享工作流在 PR 中扫描 `BASE_SHA..HEAD_SHA`，在 main push 中扫描完整 Git 历史。
本次 Gitleaks 为 `8.30.1`，`@v1` 解析为 `8feb64b77fcd794571ba9a959f7f745bc7a0650c`；
后续排查应重新记录实际版本。PR 通过不能证明完整历史通过，删除当前文件也不会移除历史版本。

从待扫描仓库根目录运行，保持与工作流一致的命令和工作目录。先确认 `gitleaks version`，
记录完整 SHA、refs、是否浅克隆；不同 ref 集合的扫描计数不能直接比较。
本地复现还应检查 Gitleaks 配置环境变量是否改变了内置规则，CI 未配置这些变量。

```sh
# main push：完整历史
gitleaks git --redact --verbose .

# PR：将两个占位符换成实际完整 SHA，确保提交对象可达
gitleaks git --log-opts="BASE_SHA..HEAD_SHA" --redact --verbose .
```

根目录 `.gitleaksignore` 仅保存核验过的 `commit:file:rule:line` 指纹，由当前工作目录加载；
从父目录指定另一个仓库路径不等同于先进入该仓库根目录。本仓没有新增 `.gitleaks.toml`，
继续使用完整内置规则。Issue #22 的逐条依据见[历史告警台账](../.octospec/tasks/gitleaks-history-triage/findings.md)。

新增告警先分为真实凭据、确认误报和待确认。真实凭据先私下撤销/轮换并核查影响；
待确认及未处置真实凭据继续阻塞，Issue 保持开放，不能为通过检查而提前添加例外。
确认非秘密内容后记录原提交、文件、行号、规则和依据，再添加对应完整指纹。
历史指纹和核验台账中的原始路径不可随包名迁移改写。命名检查只接受这两份已核验文件的
固定 SHA256 内容快照（统一 CRLF/LF）；内容变化仍须重新审核并更新命名检查中的摘要，
同时运行命名回归和扫描验收，不能按文件或目录放宽排除。
禁止忽略整个测试/文档目录、所有 key 字段、整个提交或关闭检测规则。
确需定制 TOML 时保留内置规则（`[extend]` / `useDefault = true`）并重新验证。

获取 JSON 证据可附加 `--report-format json --report-path <仓库外报告路径>`，始终保留 `--redact`。
共享材料只摘录必要元数据，不发布候选值或完整内部日志。非零退出须区分告警、配置错误、
缺失 Git 对象和扫描器故障，不能强制转换为成功。缺失显式 `--config` 路径和无效 TOML 必须失败；
没有可选 TOML 本身是使用内置规则的合法情况。

例外变更应在保留原始 SHA 的隔离历史仓库验收：先证明旧指纹实际排除，再新增非功能性 canary 提交，
验证同文件、原行号及邻近行的新密钥样式仍被完整历史和 PR 扫描拦截。
重新创建或 cherry-pick 原始历史会改变 SHA，不能证明原指纹生效。

专项验收脚本使用 Python 3 标准库、Git 和已校验的 Gitleaks 8.30.1；`--scratch` 指定尚不存在的新目录。
`--reuse-evidence` 复用原完整历史与 19 条 canary，不重复分类；省略该参数才重新生成历史验证仓库。
脚本只在隔离仓库创建合成测试提交和脱敏证据，不提交/推送源仓库，也不调用 canary 对应服务：

```sh
python3 .octospec/tasks/gitleaks-history-triage/verify.py --gitleaks /absolute/path/to/gitleaks --reuse-evidence /previous/verification-directory --scratch /new/verification-directory
```

Windows 使用实际 Python 和 `gitleaks.exe` 路径运行同一脚本。脚本固定 Issue #22 的两条基线与 45 个指纹；
后续新增历史处置要更新独立验收依据，不能把台账自动当作新告警的放行名单。

完整结果见[本地交付记录](../.octospec/journal/shared/2026-10-19-gitleaks-history-triage.md)。

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
把 `X.Y.Z` 写入生成包，通过单一 publish job 直接执行 `npm publish`，把已验证的 tgz
上传到唯一 registry：npm 官方仓库 `https://registry.npmjs.org`，再用同一归档创建或修复
GitHub Release。不发布或查询 GitHub Packages；GitHub Release 附件和 Actions artifact
仍保留，它们不是 npm registry。不使用 `npm stage`、审批或二次转正流程。
失败后可通过手工 tag 输入选择 `recover` 重试。npm 已存在的不可变版本会先核对
SHA-512，一致则跳过而不是覆盖；恢复时只从 npm 已发布归档复用构建时间，并核对源码
commit 和 clean 标记，避免重建出不同归档。
新版本先使用版本专属 `release-X.Y.Z` dist-tag 交付，GitHub Release 就绪后由包级
promotion 协调器重新读取 npm 与 GitHub Release 状态，把两端 latest 自动收敛到已完整
交付的最高稳定版。例如成功交付 `v1.0.2` 后，npm `latest` 自动指向 `1.0.2`。RC 等预发布
不进入稳定版候选集，不调整 latest；当前 tag 发布入口只接受稳定版本。完整候选必须存在于
npm，并下载对应 Release 附件核对两份归档的 SHA-512 相同，不能只依赖同名附件判断完整。
因此恢复当前或旧版本、不同 tag 并发完成以及 promotion 等待项被取代都不会回退 latest。
两端的现有稳定版 latest 指针同时作为单调下界；每个 tag 的 Release 资产保持独立交付，
不进入可能替换 pending 运行的全局 concurrency group。资产替换期间短暂缺失时，promotion
保持零写并有界重读；替换失败也不会把任一指针降到旧版本。
`dry-run` 读取同一份两端状态，并把本次已验证版本作为只读候选执行相同决策；它只
输出拟执行的 promotion，不创建版本、dist-tag、Release 或资产。dry-run 使用独立的运行级
并发组，不能替换等待中的正式 promotion。

npm 上传后最多等待 20 分钟，并校验可读版本的归档 SHA-512，而不只判断版本号
是否存在。只有 E404 视为不存在；鉴权、网络和完整性错误直接失败。上传请求成功不等于
版本已经公开可读，超时会明确提示检查 registry 处理状态或 staged-version 冲突，不会自动
切换到 stage 或盲目重传。后续恢复仍先检查不可变版本。

npm 发布需要具备 package publish 权限的 `NPM_TOKEN`，job 同时获得生成 provenance 所需的
OIDC 权限。workflow 不请求 GitHub Packages 的读写权限，也不配置其 token 或 registry。
普通 PR 检查不读取发布 secret。所有内部 app 和 package 都是 private，永不独立发布；
生产依赖随唯一的公开根包捆绑。不得在仓库根目录直接执行 `npm publish`，现有 prepack 门禁会
拒绝该路径。

## GitHub Release

Release Drafter 继续在版本之间准备说明。tag 触发的发布工作流仅在 npm 发布成功后创建正式
Release，并上传同一个已验证 tgz。如果 npm 已发布而 Release 创建失败，选择 `recover`
重跑会跳过一致的不可变版本并补齐缺失交付；修复现有 Release 不主动清除 latest，最终状态由
包级协调器统一复核。

仓库使用 Apache-2.0，并保留第三方许可证通知。远端发布与 Release 创建仍需单独核验，参见
[初始 CI 记录](../.octospec/journal/shared/2026-10-15-github-open-source-ci.md)。

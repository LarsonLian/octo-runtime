# GitHub Checks and Releases

This repository publishes one npm distribution: `@mininglamp-oss/octo-runtime`.
Common workflows reuse `Mininglamp-OSS/.github@v1`; directly referenced Actions are
pinned to commits and updated through Dependabot.

## Pull Request Checks

The `CI` workflow runs for every PR targeting `main`, including draft and documentation
PRs, pushes to `main`, manual dispatches and validated release calls. It has no path
filter that could leave its required check waiting indefinitely.

Both Ubuntu and macOS use **Node.js 24.x**, read from `.nvmrc`, and the pnpm version
declared in `package.json#packageManager`. CI explicitly installs ripgrep for the
naming check rather than relying on the runner image. Each runner executes:

1. `pnpm install --frozen-lockfile`.
2. `pnpm lint`, `pnpm lint:names` and `pnpm format:check`.
3. `pnpm typecheck`, including the workspace build.
4. A lockfile and generated protocol type drift check.
5. `pnpm test:suites`, the same suites used by local `pnpm test` without another build.
6. Single-distribution packaging and offline installation/public API verification.

The complete test entry point includes the existing local debugging WebUI plugin
tests. No production UI or new browser end-to-end gate is introduced. Provider tests
use fakes unless their existing live-test opt-in is explicitly enabled. Windows is
not included in this runner matrix.

`CI Gate` is the stable required check. It runs after the entire matrix, including
on failure, and rejects any aggregate result other than `success`. Branch protection
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
Linux/macOS hosted runners or organization reusable workflows have succeeded.

## Automatic Review Requests

[CODEOWNERS](CODEOWNERS) assigns every path to `Jerry-Xin`, `yujiawei` and
`mochashanyao`. GitHub automatically requests these owners for non-draft PRs and
when a draft becomes ready for review, excluding the PR author. No custom workflow
or token is needed. Automatic owner requests use the base branch's file: request
reviewers manually for the initial PR, then merge the file through normal review
before relying on automatic requests for subsequent PRs.

Reviewer requests and approval requirements are separate. The three owners are
requested, while `main` currently requires at least one approval.

## npm Release

Source manifests keep the non-release placeholder version `0.0.0`. A stable annotated
`vX.Y.Z` tag is the sole release-version source; do not commit version bumps for a
release. Before the first production tag, `npm Publish` may be run manually with
`dry_run=true` to exercise the exact tag build without uploading it.

Pushing the tag starts `Release Publish`, which validates the tag and its `main`
ancestry, calls the complete CI matrix at that exact commit, stamps `X.Y.Z` into the
generated package, publishes the verified archive to npm, and then creates or repairs
the matching GitHub Release with the same archive. A failed run can be retried through
the workflow's manual tag input. Existing immutable npm versions are verified and
skipped rather than overwritten.

Publishing requires an `NPM_TOKEN` with package publish access; the job also receives
OIDC permission for provenance. Ordinary PR checks do not read this secret. Every
internal app and package is private and is never published separately. Production
dependencies are bundled into the one public root package. Do not invoke `npm publish`
directly in the repository root; the existing prepack guard rejects that path.

## GitHub Release

Release Drafter continues preparing notes between versions. The tag-triggered release
workflow creates the final release only after npm publication succeeds and uploads the
same verified tgz. If npm was already published but Release creation failed, rerunning
the workflow skips the immutable npm version and repairs the Release.

The repository uses Apache-2.0 and preserves third-party license notices. Remote
publishing and release creation require separate verification; see the
[initial CI record](../.octospec/journal/shared/2026-10-15-github-open-source-ci.md).

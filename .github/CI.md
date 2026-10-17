# GitHub Checks and Releases

This repository publishes one npm distribution: `@mininglamp-oss/octo-runtime`.
Common workflows reuse `Mininglamp-OSS/.github@v1`; directly referenced Actions are
pinned to commits and updated through Dependabot.

## Pull Request Checks

The `CI` workflow runs for every PR targeting `main`, including draft and documentation
PRs, pushes to `main`, manual dispatches and validated release calls. It has no path
filter that could leave its required check waiting indefinitely.

Both Ubuntu and macOS use **Node.js 24.x**, read from `.nvmrc`, and the pnpm version
declared in `package.json#packageManager`. Each runner executes:

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

## npm Release

1. Update the root package version, merge into `main`, and push a stable `vX.Y.Z` tag.
2. Run `npm Publish` against that tag with `dry_run=true`.
3. After checking the result, run with `dry_run=false` to publish the verified archive.

Publishing requires an `NPM_TOKEN` with package publish access and OIDC permission
for provenance. Ordinary PR checks do not read this secret. The workflow verifies
the tag's main ancestry and package version, then runs CI at the exact release SHA.
Internal workspace packages are not published separately. Do not invoke `npm publish`
directly in the repository root; the existing prepack guard rejects that path.

## GitHub Release

Release Drafter prepares release notes. Run `Release Publish` with the stable tag
and a successful top-level `CI` run ID for that commit; it defaults to a draft.
GitHub Release creation and npm publishing are independent operations.

The repository uses Apache-2.0 and preserves third-party license notices. Remote
publishing and release creation require separate verification; see the
[initial CI record](../.octospec/journal/shared/2026-10-15-github-open-source-ci.md).

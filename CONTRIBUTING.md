# Contributing to Octo Runtime

Octo Runtime provides a shared execution kernel for SDK hosts and Extra plugins.
Read [ARCHITECTURE.md](ARCHITECTURE.md) and the
[engineering rules](.octospec/rules/engineering.md) before changing execution contracts.

## Development Setup

- **Node.js 24.x** is required. Use `nvm use` with the checked-in `.nvmrc`.
- Use the exact pnpm version declared in `package.json#packageManager`.
- Install ripgrep (`rg`) for the naming check: `brew install ripgrep` on macOS or
  `sudo apt-get install ripgrep` on Ubuntu. CI installs this prerequisite explicitly.
- Install and authenticate a Provider CLI only for explicitly requested live runs.
  Automated tests use fake Providers and do not require real models.

From the repository root:

```bash
nvm use
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm lint:names
pnpm typecheck
pnpm test:suites
```

`pnpm typecheck` builds the workspace before checking root types. After that build,
`pnpm test:suites` runs the complete automated suite without rebuilding.
Use `pnpm test` to build and run the same suites in one command.

## Project Structure and Responsibilities

| Location                                      | Responsibility                                                       |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `apps/cli`                                    | The bundled `octo-runtime` host, configuration and service commands  |
| `apps/daemon`                                 | Daemon entry points and process composition                          |
| `packages/octo-runtime-daemon`                | SDK, local IPC and shared process lifecycle                          |
| `packages/octo-runtime-executor-core`         | Single AgentExecutor implementation and explicit in-process API      |
| `packages/octo-runtime-adapter-host`          | Transitional isolated worker, NDJSON transport and standalone runner |
| `packages/octo-runtime-adapter-*`             | Provider-specific protocol translation                               |
| `packages/octo-runtime-protocol`              | Execution contracts, schemas and generated types                     |
| `packages/octo-runtime-extra-channel-gateway` | Octo IM admission, sessions and replies                              |
| `public`                                      | Published Extra and protocol entry points                            |
| `test`, `test-support`                        | Cross-package tests, fixtures and fake Providers                     |
| `.octospec`                                   | Current rules, task plans and verification records                   |

SDK integration is the primary application entry point. The bundled Runtime CLI
is one SDK host; it is distinct from the `octo-cli` business API tool.
Host applications own configuration sources, credential storage and installation
decisions. Extras own their business integrations and load/unload as whole plugins.
Prioritize stability: recommend SDK access over IPC to an independent Executor
Kernel, especially for Electron and other long-running hosts. The new Kernel,
IPC and supervision implementation belongs to issue #47; the existing isolated
worker and NDJSON path remain in place during this transition. Explicit in-process
Core embedding is allowed as a simpler SDK integration option. Its host owns the
lifecycle and shares the execution process failure domain. Both paths reuse the
same AgentExecutor implementation. Keep business workflows out of the kernel and
Provider differences inside adapters.

## Code Style and Formatting

- Use strict TypeScript and ES modules. Avoid explicit `any`; narrow `unknown` instead.
- Use type-only imports where required by ESLint. Handle failures explicitly.
- Edit protocol schemas and regenerate types through the build; do not edit generated
  protocol types by hand.
- Run `pnpm format` to format owned source, tests, scripts, JSON/YAML configuration,
  GitHub collaboration files and this guide. `pnpm format:check` checks the same scope.
- Generated output, the lockfile and pinned upstream browser sources are excluded.
  Architecture documents and historical Octospec records are outside this formatting
  gate; maintain their content and links through the existing documentation checks.

Public PR titles and descriptions use English and Conventional Commit prefixes.
Repository-internal plans, explanatory code comments and commit descriptions retain
the Chinese collaboration convention in [AGENTS.md](AGENTS.md) and
[the repository collaboration rule](.octospec/rules/collaboration.md).

## Testing and CI

`pnpm test:suites` is the shared local/CI test entry point. It includes root Node
tests, protocol package tests and the existing local debugging WebUI plugin tests.
The debugging plugin is not a production UI; this does not introduce a desktop or
browser end-to-end acceptance requirement.

Add focused regression coverage for behavior changes. Protocol and shared lifecycle
changes require cross-package verification. Explicit live API debugging must use
the IM test environment and report its evidence separately from fake-Provider tests.
Never commit credentials or include them in logs, screenshots or test reports.

Linux and macOS CI run the frozen dependency install, ESLint, naming checks, formatting,
type checking/build, generated-file drift checks, complete test suites, package creation
and offline installation verification. A dedicated Windows job builds the package and
verifies real global installation, daemon process-tree cleanup and uninstall. The final
`CI Gate` succeeds only when both paths succeed.
See [GitHub CI and release operations](.github/CI.md) for workflow details.

## Commits and Pull Requests

1. Use a focused `feat/`, `fix/`, `docs/`, `refactor/`, `test/` or `chore/` branch.
2. Record substantial work in an Octospec task and follow the applicable rules.
3. Run the relevant checks and inspect the staged diff for unrelated files or secrets.
4. Use `type(scope): subject` for commit and PR titles. Repository-internal commit
   subjects follow the collaboration rule; public PR titles and bodies use English.
5. Target `main` and rebase onto its latest state before requesting review.
6. Explain the problem, resulting behavior, architecture impact, validation and any
   migration requirements. Link actual task or issue references, not placeholders.
7. Obtain at least one approval, resolve review conversations and pass required checks.
   New commits invalidate previous approvals. The protection also applies to admins.

Direct pushes, force pushes and branch deletion are blocked for `main`. Local hooks
are not installed automatically; run the checks above before pushing.

[CODEOWNERS](.github/CODEOWNERS) automatically requests `Jerry-Xin`, `yujiawei` and
`mochashanyao` when a non-draft PR is opened or a draft becomes ready for review.
GitHub uses the base branch's ownership file, so this starts after the initial PR
merges into `main`. The initial PR requests these reviewers manually. A PR author
cannot review their own PR. Requesting three reviewers does not require three
approvals; the branch protection above requires at least one.

## Security and Local State

Preserve existing Runtime Home, identities, profiles and configuration during updates.
Historical reset or destructive migration notes do not authorize new deletion.
The working directory is not an operating-system sandbox. Respect the execution
permission contract and the host's installation decisions.

Report vulnerabilities privately using the organization's
[security policy](https://github.com/Mininglamp-OSS/.github/blob/main/SECURITY.md).

# Contributing to Octo Harness

Thanks for your interest in contributing. This document covers everything you
need to get productive.

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Code Style](#code-style)
- [Testing](#testing)
- [Commits and Pull Requests](#commits-and-pull-requests)
- [Adding a Provider Adapter](#adding-a-provider-adapter)
- [Security](#security)

## Development Setup

### Prerequisites

- **Node.js** ≥ 20
- **pnpm** ≥ 11
- For real provider runs: the corresponding provider CLI installed and
  authenticated (Codex, Claude Code, CodeBuddy, OpenCode, OpenClaw). Tests do
  **not** call real models.

### Getting Started

```bash
# From the repository root
cd octo-harness
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

`pnpm test` builds every workspace first, then runs the suite with Node's
built-in test runner (`node --test`). Tests use an in-test adapter, native event
samples, a standalone adapter-host process and a temporary JSON store — no real
model is invoked.

### Useful Commands

| Command | Description |
|---|---|
| `pnpm build` | Recursively build every `packages/**` and `apps/**` workspace to `dist/` |
| `pnpm typecheck` | Build, then `tsc --noEmit` against `tsconfig.json` |
| `pnpm lint` | ESLint over `apps` and `packages` |
| `pnpm test` | Build, then `node --test` |
| `pnpm daemon` | Start the daemon (Unix socket control plane + worker) |
| `pnpm cli <args>` | Run the CLI against a running daemon |
| `pnpm host` | Start a standalone adapter-host with `config/adapters.json` |

### Running Locally

```bash
# Terminal A
pnpm daemon      # state at ~/.octo-harness/state.db (override with OCTO_HARNESS_HOME)

# Terminal B
pnpm cli status
pnpm cli adapter list
pnpm cli adapter probe codex
```

## Project Structure

```
octo-harness/
├── apps/
│   ├── cli/                 # Unix socket CLI client
│   ├── daemon/              # composition root + control plane + worker
│   └── adapter-host/        # standalone provider host process
├── packages/
│   ├── octo-harness-protocol/            # canonical event / invoke contract (JSON Schema → TS)
│   ├── octo-harness-core/                # HarnessEngine + Store (domain core)
│   ├── octo-harness-daemon/              # queue, scheduler, recovery
│   ├── octo-harness-adapter-host/        # host lifecycle + NDJSON RPC
│   ├── octo-harness-adapter-sdk/         # adapter helpers + subprocess runtime
│   ├── octo-harness-acp-client/          # CodeBuddy ACP JSON-RPC client
│   └── octo-harness-adapter-*/           # per-provider adapters
├── config/adapters.json     # adapter manifest
├── test/                    # contract and integration tests
├── ARCHITECTURE.md          # design document
└── CLAUDE.md                # instructions for Claude Code / coding agents
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design, and
[docs/](./docs) for the deep-dive guides.

## Code Style

### Language

- All code, comments, commit messages, PR titles and PR descriptions **must be
  in English**.

### TypeScript

- **Strict mode**, ES modules (`"type": "module"`). Build from `src/*.ts`, run
  from `dist/*.js`, publish matching `*.d.ts`.
- **No `any`** — `@typescript-eslint/no-explicit-any` is an **error**, not a
  warning. Use `unknown` + type guards when the shape is genuinely unknown.
- **`consistent-type-imports` is enforced** — use `import type { … }` for
  type-only imports.
- Prefer `const`; never `var`.
- Handle errors explicitly. Do not swallow with an empty `catch`.

### Boundaries

- The domain core (`octo-harness-core`) must not import IPC, stdio, child
  processes or a concrete provider. It depends only on the `Store` and
  `HarnessHost` ports.
- Provider differences live inside adapters. Do not add
  `if (adapterType === "…")` branches to the core.

## Testing

- Tests live in `test/*.test.js` and use Node's built-in runner (`node --test`).
- Tests must not call real models — use the in-test adapter and native event
  samples.
- Every change to source behavior should carry a test for the changed behavior.
- Cover edge cases: empty inputs, boundary values, error paths, idempotency
  (`(agentSessionId, triggerOccurrenceId)`, `(runId, seq)`), cancellation and restart
  recovery.

### Pre-submit Checklist

There are no git hooks in this repo yet, so run these manually before pushing:

1. `pnpm typecheck` — zero errors
2. `pnpm lint` — zero errors (lint is zero-tolerance on `any`)
3. `pnpm test` — all tests pass
4. `git add <specific files>` — never `git add -A`
5. `git status` — verify only intended files are staged
6. `git branch --show-current` — confirm the right branch

## Commits and Pull Requests

- **Conventional Commits.** `type(scope): subject` — e.g.
  `fix(protocol): formalize canonical tool inputs`. The `!` marker (`feat!:`)
  denotes a breaking change. Scopes are free-form technical identifiers
  (`core`, `daemon`, `protocol`, `runtime`, `codex`, …).
- **One concern per PR.** Don't mix unrelated changes.
- **Rebase on `main`** before pushing.
- **PR description** should state: what changed and why, files modified, test
  results (`pnpm typecheck && pnpm lint && pnpm test`), and any breaking changes
  or migration notes.
- **All checks must pass** before review.

## Adding a Provider Adapter

Adapters are the only place provider specifics may live. In brief:

1. Create `packages/octo-harness-adapter-<name>/` and depend on
   `octo-harness-adapter-sdk` (for CLI providers) or the relevant client.
2. Implement `build*Command` (generic `InvokeRequest` → provider input) and
   `normalize*Event` (native stream → `CanonicalEvent`). Report the opaque
   provider session through a `session.update` event so continuations resume.
3. Register the module in `config/adapters.json`.
4. Add a contract test with representative native events.

The full walkthrough is in
[docs/08-adapter-authoring.md](./docs/08-adapter-authoring.md).

## Security

- **Never** hardcode secrets, tokens or credentials in source. Local provider
  CLIs are authenticated out-of-band by the operator. A remote adapter that
  requires a runtime credential must store it in the profile credential store
  with owner-only permissions; credentials must never enter AgentRevision,
  process argv, prompts, provider observations or operational logs.
- The workdir is the process `cwd`, **not** a chroot. Sandboxing is delegated to
  the runtime. Do not enable dangerous permission modes
  (`--dangerously-bypass-permissions`, `--auto-approve`, Claude Code's bypass)
  without an external container/VM sandbox.
- The Unix socket (`0600`) is the current local access boundary — there is no
  RBAC. Treat the daemon as a trusted local process.
- If you find a security issue, do **not** open a public issue; contact the
  maintainers privately.

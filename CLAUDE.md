# CLAUDE.md — Octo Harness

## Project

Octo Harness: a provider-neutral agent harness reference implementation. It
unifies Codex, Claude Code, CodeBuddy, OpenCode, OpenClaw (local) and Dify
(remote) behind one domain model, keeping Chat, Task, Trigger, Run, provider
session and streamed events as explicit domain objects. Runnable single-node
baseline — not a multi-node production scheduler.

## Tech Stack

- TypeScript (strict, ES modules, `"type": "module"`)
- pnpm workspace (`apps/*` + `packages/*`)
- Node's built-in test runner (`node --test`)
- ESLint 10 + typescript-eslint (`no-explicit-any` and `consistent-type-imports`
  are errors)
- Protocol types generated from a JSON Schema source of truth

## Commands

- `pnpm build` — recursively build all workspaces to `dist/`
- `pnpm typecheck` — build, then `tsc --noEmit`
- `pnpm lint` — ESLint over `apps` and `packages`
- `pnpm test` — build, then `node --test`
- `pnpm daemon` — start the daemon (Unix socket control plane + worker)
- `pnpm cli <args>` — CLI client against a running daemon
- `pnpm host` — standalone adapter-host with `config/adapters.json`
- `pnpm demo` — in-process Codex example

## Code Style

- All code, comments, commit messages and PR descriptions in **English**.
- Build from `src/*.ts`, run from `dist/*.js`.
- **No `any`** (`@typescript-eslint/no-explicit-any` is error-level — an `any`
  fails the build). Use `unknown` + type guards instead.
- Use `import type { … }` for type-only imports (enforced).
- Prefer explicit error handling over silent catch.
- Conventional Commits: `type(scope): subject`; `feat!:` for breaking changes.

## Architecture

Full document in [ARCHITECTURE.md](./ARCHITECTURE.md); deep dives in
[docs/](./docs). The layering:

- **`octo-harness-core` — `HarnessEngine`** is the domain core. It owns
  Chat/Task/Trigger/Session/Attempt/Run state transitions, `InvokeRequest`
  assembly and event envelopes. It depends only on two ports: `Store` and
  `HarnessHost`. **No IPC, no stdio, no child process, no concrete provider.**
- **`octo-harness-protocol`** is the stable contract: `InvokeRequest`,
  `CanonicalEvent`, provider session, persisted `EventEnvelope`.
- **`octo-harness-daemon` — `HarnessDaemon`** is the background orchestrator:
  queueing, `setImmediate` background execution, trigger matching, interval
  timers, wait, cancel, restart recovery.
- **`octo-harness-adapter-host` — `AdapterHost`** is the execution boundary: it
  selects the adapter, controls the invocation, propagates cancellation, fixes
  message lifecycle and guarantees a single terminal event.
- **Provider differences terminate in `octo-harness-adapter-*`.** The core has
  no `if (adapterType === "codex")` branch.

Transports differ by boundary (do NOT assume "everything is JSON-RPC"):
CLI→daemon is a one-line JSON request/response over a Unix socket (not
JSON-RPC); daemon→adapter-host is NDJSON JSON-RPC 2.0 over stdio;
host→provider is a per-invocation subprocess (CodeBuddy is ACP JSON-RPC 2.0,
Dify is HTTPS+SSE). Unification lives at the `HarnessHost` port and the canonical
event contract, not at the wire.

## Testing

- Tests live in `test/*.test.js`, run with `node --test`.
- Tests must **not** call real models — use the adapter fixture, native event
  fixtures and the fake ACP subprocess.
- `pnpm test` builds first, so a build/type error fails the test command.

## Gotchas

- **Three IDs never merge.** Harness Session ID (stable conversation), Harness
  Run ID (one turn/attempt) and Provider Session ID (Codex thread / Claude UUID
  / ACP / OpenCode / OpenClaw local session) are distinct. Adapters report the
  opaque `providerSession` via a `session.update` side channel; the engine saves
  it on the Session and replays it in the next `InvokeRequest`.

- **Terminal events are exactly-once, and event levels are layered.** The host
  stages an adapter terminal until cleanup succeeds, synthesizes
  `run.stopped`/`run.error` when an adapter misbehaves, and collapses
  cancellation into one `run.stopped`. Three levels — provider-native →
  `CanonicalEvent` (`type + payload`) → `EventEnvelope` (adds
  `id/seq/tsMs/sessionId/runId`). The store appends idempotently on
  `(runId, seq)`. When adding/changing terminal states, remember the terminal
  set is currently duplicated across protocol/engine/daemon/server — keep them
  in sync.

- **Single-writer SQLite store.** `SqliteStore` persists each state transition
  incrementally to a SQLite (WAL) database (`state.db`, mode `0600`) via
  repository methods wrapped in one `transaction`; the daemon is the sole writer.
  Reads/writes go through `get*/list*/put*` + `appendEvent` — the `Store`
  interface no longer exposes mutable Maps. Cross-run session fields
  (`providerSession`, `activeRunId`) rely on check-then-set, not a lock. Treat the
  `Store` interface (not adapters) as the production replacement point.

- **Agent Work durable outbox.** The Agent Work runtime writes each produced
  event to a local SQLite outbox (`agent-work.db`) inside a transaction before it
  is sent, then a sender loop drains it; a cumulative `event.ack{run_id, seq}`
  advances the per-run watermark and deletes confirmed rows. Unacked events
  survive restart and are replayed with a stable `event_id`; they are never
  deleted by time, only backpressured at the soft/hard capacity watermark.

- **Idempotency keys.** Trigger materialization dedupes on
  `(triggerId, externalEventId)`; event append dedupes on `(runId, seq)`. Event
  triggers only match and interval triggers only produce an occurrence — neither
  may invoke the host directly.

- **Security: workdir is `cwd`, not a chroot.** Sandboxing is delegated to the
  runtime (container/VM). Claude Code defaults to bypassing permission prompts
  for unattended runs and therefore *requires* external isolation. Codex
  (`--dangerously-bypass-permissions`) and OpenCode (`--auto-approve`) dangerous
  modes must be opted into explicitly. The harness handles no provider
  credentials — the operator authenticates each CLI out-of-band. The Unix socket
  (`0600`) is the only local access boundary; there is no RBAC, and adapter
  `capabilities` are metadata only.

- **`Task.status` currently mirrors `RunStatus`** — a known simplification. The
  concept model distinguishes Task business status
  (todo/in_progress/in_review/blocked/done) from Run execution status; do not
  assume "execution finished" equals "business done" when extending Tasks.

- **No AgentRevision / AgentKind yet.** A Run freezes the live agent config, not
  an immutable version snapshot; Assistant/Expert capability profiles are not
  modeled. Cross-node WSS transport is design-only (docs/09).

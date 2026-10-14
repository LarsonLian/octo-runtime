# CLAUDE.md - Octo Runtime

## Project

Provider-neutral Agent Runtime for Agent Worker. The unified execution model is
`AgentSession -> AgentRun -> Invocation -> CanonicalEvent`. Chat, Loop Task,
TaskAttempt, Trigger scheduling and IM delivery belong to upstream business
services and must not be introduced into Runtime persistence or APIs.

## Commands

- `pnpm build`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm daemon`
- `pnpm cli <args>`
- `pnpm host`

## Engineering Rules

- Strict TypeScript ES modules; no explicit `any`.
- Use type-only imports and explicit error handling.
- Protocol wire types are generated from JSON Schema.
- CLI to daemon is one-line JSON over Unix socket, not JSON-RPC.
- daemon to adapter-host is NDJSON JSON-RPC 2.0 over stdio.
- Provider differences stop inside `octo-runtime-adapter-*`.
- Tests use fake providers and must not call real models.

## Architecture Invariants

- Agent Worker owns production AgentSession/AgentRun state, lease and fencing.
- Business services own namespace-specific scheduling and state.
- Runtime owns local invocation, provider subprocesses and reliable event outbox.
- `(namespace, agentId, sessionKey)` identifies a session.
- `(agentSessionId, triggerOccurrenceId)` deduplicates run submission.
- Agent session ID, Agent run ID, invocation ID and provider session ID never merge.
- Provider session is opaque and is returned through `session.update`.
- Events are ordered/deduplicated by `(runId, seq)`.
- A run emits exactly one terminal event.
- Workdir is a cwd, not a security boundary.
- Runtime credentials are stored only in the owner-protected Runtime
  Home credential file (POSIX mode 0600); they never enter argv, service
  definitions, environment variables, logs, or provider input.

The local Core/SQLite model is a reference profile, not a second production
authority. It contains only Agent, AgentSession, AgentRun and EventEnvelope.

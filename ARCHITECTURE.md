# Architecture

This document describes the internal architecture of **Octo Harness**: a
provider-neutral agent harness reference implementation. It unifies Codex,
Claude Code, CodeBuddy, OpenCode, OpenClaw (local) and Dify (remote) behind one
domain model, while keeping Chat, Task, Trigger, Run, provider session and
streamed events as explicit domain objects.

This is a runnable single-node baseline, **not** a multi-node production
scheduler. The SQLite (WAL) store and local Agent Work outbox assume a single
daemon writer; a production deployment should still replace them with a
distributed transactional database, worker lease/fencing and an authenticated
control plane. The target design for
cross-node operation is described in
[docs/09-transport-and-multinode.md](docs/09-transport-and-multinode.md); it is
a next-phase design, not current capability.

## Design Goals

1. **Provider-neutral core.** `HarnessEngine` depends only on two ports —
   `Store` and `HarnessHost` — never on a Unix socket, stdio, a child process
   or a concrete provider. There is no `if (adapterType === "codex")` branch in
   the core; every provider difference terminates inside an adapter.
2. **Stable contract, not stable wire.** Unification happens at the
   `HarnessHost` port and the canonical event contract, not by forcing every
   transport to look the same. CLI↔daemon is a one-line JSON request/response
   over a Unix socket; daemon↔adapter-host is NDJSON JSON-RPC 2.0 over stdio.
3. **One writer, atomic persistence.** The daemon is the sole authoritative
   writer of Chat/Task/Trigger/Run. State is persisted incrementally to a SQLite
   (WAL) database (`state.db`, mode `0600`); each state transition is one
   transaction rather than a full-snapshot rewrite. Agent Work events are written
   to a local durable outbox before they are sent and deleted only after the
   cloud durably ACKs them.
4. **Exactly-once terminal events.** The host stages an adapter's terminal event
   until cleanup succeeds, synthesizes `run.stopped`/`run.error` when an adapter
   misbehaves, and collapses cancellation into a single terminal event. The
   store appends envelopes idempotently on `(runId, seq)`.

## System Overview

```
┌──────────────┐   Unix socket    ┌──────────────────────────────┐
│ CLI / event  │  request/response │           daemon              │
│  producer     │◀────────────────▶│  (authoritative control plane │
└──────────────┘                   │   + background worker)        │
                                   │                               │
                                   │  ┌──────────┐  ┌────────────┐ │
                                   │  │HarnessDae│  │HarnessEngine│ │
                                   │  │mon (queue│─▶│ (domain     │ │
                                   │  │/schedule/│  │  core)      │ │
                                   │  │recover)  │  └─────┬───────┘ │
                                   │  └──────────┘        │         │
                                   │              single-writer     │
                                   │              SQLite store      │
                                   └───────────────┬───────────────┘
                                                   │ NDJSON JSON-RPC 2.0
                                                   │ (stdio)
                                   ┌───────────────▼───────────────┐
                                   │        adapter-host process    │
                                   │  (adapter registry + invocation│
                                   │   lifecycle + provider procs)   │
                                   └───────────────┬───────────────┘
                                                   │ one subprocess per invocation
        ┌──────────┬──────────┬──────────┬────────┴───┬──────────┬──────────┐
        ▼          ▼          ▼          ▼            ▼          ▼          ▼
      Codex   Claude Code  CodeBuddy  OpenCode   OpenClaw     Dify        Dify
                            (ACP)                (local CLI) Chatflow    Workflow
                                                            (HTTPS+SSE) (HTTPS+SSE)
```

Solid boundaries are process boundaries. The CLI never reads or writes state
files in a workdir and never launches a provider directly. The manifest
(`config/adapters.json`) decides which adapters the host loads; the daemon
depends only on the public host client.

## Domain Model

```
AGENT ||--o{ CHAT_SESSION : serves
AGENT ||--o{ TRIGGER      : owns
TRIGGER ||--o{ OCCURRENCE : matches
OCCURRENCE ||--|| TASK     : materializes
TASK ||--o{ ATTEMPT        : retries
ATTEMPT ||--|| RUN         : bridges
CHAT_SESSION ||--o{ RUN    : turns
SESSION ||--o{ RUN         : contains
RUN ||--o{ EVENT_ENVELOPE  : emits
```

- **Chat Session** — continuous conversation + provider-session binding; carries
  no Task orchestration fields.
- **Task** — durable work item, produced or continued by a trigger occurrence.
- **Attempt** — the Nth execution of a Task; stores the trigger/comment source.
- **Run** — a single provider invocation, shared by Chat and Task.
- **Session** — `chat|task` kind, a single active run, an opaque provider
  session.
- **Trigger / Occurrence** — the rule definition is separated from a concrete
  firing; the occurrence carries the idempotency key.

Three IDs must never be merged (see [docs/01-architecture.md](docs/01-architecture.md)):

| ID | Meaning |
|---|---|
| Harness Session ID | The stable Chat/Task conversation |
| Harness Run ID | A single turn / attempt |
| Provider Session ID | Codex thread, Claude UUID, ACP/OpenCode session, OpenClaw local session |

Adapters report the opaque `providerSession` through a `session.update` side
channel; the core saves it on the Session and replays it in the next
`InvokeRequest`, so a Task continuation or a Chat next turn resumes provider
context while owning a fresh Harness Run and event sequence.

## Module Reference

The system splits into an executable assembly layer (`apps/*`) and reusable
domain/runtime/adapter packages (`packages/*`). Imports below are TypeScript
package imports, not runtime network connections.

### Domain and scheduling

| Package | Core class / fn | Owns | Does NOT own |
|---|---|---|---|
| `octo-harness-core` | `HarnessEngine` | Domain objects, state machine, `InvokeRequest` assembly, event envelopes, persistence | IPC, provider-native protocols |
| `octo-harness-core/store` | `MemoryStore`, `SqliteStore` | Repository methods, idempotent event append, incremental SQLite (WAL) writes | Multi-writer transactions, distributed lease |
| `octo-harness-protocol` | `InvokeRequest`, `CanonicalEvent`, `EventEnvelope` | Shared types + minimal runtime validation (generated from a JSON Schema source of truth) | Scheduling policy, I/O |
| `octo-harness-daemon` | `HarnessDaemon` | Trigger matching, queueing, `setImmediate` background execution, interval timers, wait, cancel, restart recovery | Building provider commands |

### Execution and provider adaptation

| Package | Core class / fn | Owns | Does NOT own |
|---|---|---|---|
| `octo-harness-adapter-host` | `AdapterHost` | Adapter registry, invoke, cancel, message/terminal lifecycle correction, single-terminal guarantee | Task/Chat business state |
| `octo-harness-adapter-host/rpc` | `AdapterHostRpcClient/Server` | stdio NDJSON JSON-RPC; ACK + event notifications | Building provider commands |
| `octo-harness-adapter-sdk` | `createJsonCliAdapter`, `spawnJsonLines` | Common subprocess + JSONL template for CLI providers | Provider field semantics |
| `octo-harness-acp-client` | `AcpClient` | CodeBuddy ACP initialize/session/prompt/update/cancel | Canonical event semantics |
| `octo-harness-dify-client` | Dify HTTP/SSE client | Dify remote HTTPS + SSE transport | Canonical event semantics |
| `octo-harness-adapter-*` | `build*Command`, `normalize*Event` | Generic request → provider input; native stream → canonical events | Mutating global Run/Task |

### Executable apps

| App | Responsibility |
|---|---|
| `apps/daemon` | Composition root: wires Store/Engine/Daemon/Host; Unix socket server; method dispatch |
| `apps/cli` | Turns CLI args into a daemon method; one socket request/response per command |
| `apps/adapter-host` | Manifest loader: dynamically imports adapter modules, registers them into one host, starts the RPC server |
| `apps/example-basic` | In-process Codex example (Engine + MemoryStore + in-process host) |

Why `HarnessEngine` is the core and not the daemon: the engine runs directly
with `MemoryStore` + an in-process host (as `example-basic` and the core tests
do); the daemon only adds async queueing, timers and recovery around it.
Deleting the daemon does not delete the domain model.

## Canonical Event Contract

```
run.queued -> run.running
session.update?
message.create -> message.delta* -> message.update
tool_call.create -> tool_call.delta* -> tool_call.update
usage.update*
run.finished | run.error | run.stopped
```

Three event levels must not be conflated:

1. **Provider-native event** — Codex `thread.started`, Claude `assistant/result`,
   ACP `session/update`, Dify SSE, etc. Exists only inside an adapter.
2. **CanonicalEvent** — `type + payload` only; shared by host and engine.
3. **EventEnvelope** — the engine adds `id/seq/tsMs/sessionId/runId` before
   writing to the store. CLI/UI read this level.

Host invariants:

- An adapter terminal is staged and only published after stream/cleanup succeeds.
- An adapter that exits without a terminal event gets a synthesized `run.stopped`.
- A provider/cleanup exception is collapsed into `run.error`.
- Cancellation collapses into a single `run.stopped`.
- `final` and `analysis` channels each own a stable `messageId`.
- A `delta` with no preceding `create` gets a synthesized `create`; an open
  message before a terminal gets an auto `update`.

The store appends by `(runId, seq)` idempotently. The core treats
`run.finished`, `run.error` and `run.stopped` as terminal, projecting them to
`completed`, `failed` and `cancelled` respectively.

## Trigger To Run

1. `materializeTrigger` checks `(triggerId, externalEventId)` for idempotency.
2. A new Occurrence, Task and Task Session are persisted in one store commit.
3. `queueTask` creates the Attempt/Run and writes `run.queued`.
4. The daemon returns `taskId/runId`, then executes in the background via
   `setImmediate` (so the model never blocks the command ACK).
5. `executeRun` writes `run.running` and assembles an explicit `InvokeRequest`.
6. The host iterates the adapter stream; the daemon appends envelopes by `seq`.
7. The terminal event updates Run/Attempt/Task and releases the session's
   active run.

Event triggers only match; interval triggers only produce an occurrence.
Neither may invoke the host directly. Chat differs only *before* `executeRun`
(prompt comes from `Run.prompt`, the session stores `agentId` directly);
afterward Chat and Task both become the same `InvokeRequest → CanonicalEvent`
stream.

## Transport Matrix

| Boundary | Physical transport | Application protocol | Lifecycle |
|---|---|---|---|
| CLI → daemon | Unix domain socket | One JSON request line + one JSON response line (**not** JSON-RPC 2.0) | New connection per command; server reads only the first line |
| daemon → adapter-host | child stdin/stdout | NDJSON JSON-RPC 2.0 | One long-lived host subprocess created at daemon start |
| host → Codex / Claude | child stdin/stdout | Prompt via stdin; native JSONL via stdout | One subprocess per invocation |
| host → OpenCode | argv/env/temp file + stdout | Prompt as positional argv; native JSONL via stdout | One subprocess per invocation |
| host → OpenClaw | argv/message file + stdout JSON | OpenClaw local CLI | One subprocess per invocation |
| host → CodeBuddy | child stdin/stdout | ACP JSON-RPC 2.0 | One ACP subprocess/client per invocation |
| host → Dify | HTTPS + SSE | Dify remote API | Per-invocation HTTP request |
| UI/Runtime → remote node | not implemented | WSS (target design only) | — |

The daemon-to-host stdio path carries two independent ACKs: the daemon ACKs the
CLI once `run.queued` is committed, and the host ACKs the daemon with an
`invocationId` immediately on `invoke`, then streams events as notifications.
Neither ACK provides cross-process reconnect/replay; host notifications carry no
transport seq today.

## Persistence And Recovery

`SqliteStore` persists each state transition incrementally to a SQLite (WAL)
database via repository methods wrapped in a transaction. Default state lives at
`~/.octo-harness/state.db` (overridable via `OCTO_HARNESS_HOME`); the socket
lives at `~/.octo-harness/sockets/octo-harness-daemon.sock`. The daemon is the
single writer. On restart:

- Queued runs are re-enqueued.
- A materialized-but-run-less queued Task rebuilds its Attempt/Run and enqueues.
- A running run that lost its provider process is terminated as
  `run.error(code=daemon_restarted)`.
- Terminal runs are preserved as-is.

The production replacement point is the `Store` interface, not the adapters:
using a relational-database transaction, an outbox, worker lease/fencing and an
event bus preserves the same domain boundaries.

## Security Model

Octo Harness executes real coding agents against a working directory. The
workdir is the process `cwd`, **not** a chroot; sandboxing is delegated to the
runtime (container, VM or equivalent), not enforced by the harness.

- **Claude Code** defaults to bypassing provider permission prompts to support
  unattended execution — it therefore *requires* an externally isolated runtime
  to constrain filesystem, network and credentials.
- **Codex** (`--dangerously-bypass-permissions`) and **OpenCode**
  (`--auto-approve`) dangerous modes must still be opted into explicitly. Do not
  enable dangerous permissions without an external sandbox.
- The Unix socket at `0600` is the current local access boundary; there is no
  user/runtime role RBAC. Allowed methods are the hardcoded `dispatch` switch in
  `apps/daemon/src/server.ts` and the `list/probe/invoke/cancel` branches in
  `AdapterHostRpcServer`. Adapter `capabilities` are metadata only and do not
  yet gate scheduling.

## Known Limitations

Honest current-state caveats (tracked, not hidden):

- **Single-writer SQLite store.** No multi-writer transactions, no lease/fencing.
  A single daemon owns `state.db` (WAL); cross-run session fields
  (`providerSession`, `activeRunId`) are protected only by check-then-set at
  `await` boundaries, not by a lock. This is safe enough for a single local
  daemon but is a real replacement point for production.
- **Local durability, not cloud durability.** The Agent Work outbox guarantees a
  produced event survives daemon restart and is replayed until the cloud ACKs it,
  but the daemon is still a single node. Distributed durability, lease/fencing and
  large-payload blob externalization remain hardening targets before production use.
- **`Task.status` currently mirrors `RunStatus`.** The concept model
  ([docs/12](docs/12-aily-task-agent-run-concept-model.md)) distinguishes Task
  *business* status (todo/in_progress/in_review/blocked/done) from Run
  *execution* status; the reference implementation collapses them for now.
- **No AgentRevision / AgentKind.** The design's immutable-config version layer
  (AgentRevision) and Assistant/Expert capability profiles are not yet modeled;
  a Run currently freezes the live agent config rather than a version snapshot.
- **No cross-node transport.** WSS run protocol, event ACK/replay and multi-node
  lease are design only ([docs/09](docs/09-transport-and-multinode.md)).

## Further Reading

- [docs/01-architecture.md](docs/01-architecture.md) — single-node architecture and invariants
- [docs/02-module-and-transport-flow.md](docs/02-module-and-transport-flow.md) — modules, transport and message flow
- [docs/09-transport-and-multinode.md](docs/09-transport-and-multinode.md) — target multi-node design
- [docs/10-protocol-schema-codegen.md](docs/10-protocol-schema-codegen.md) — protocol schema and codegen
- [docs/13-agent-work-runtime.md](docs/13-agent-work-runtime.md) — Agent Work runtime mode
- [packages/README.md](packages/README.md) — packages and adapter guide

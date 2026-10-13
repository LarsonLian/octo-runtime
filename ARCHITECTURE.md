# Architecture

Octo Harness is a provider-neutral execution runtime. Agent Worker is the control-plane authority for Agent/Team coordination, `AgentSession`, and `AgentRun`; Harness maps a leased run to one provider invocation and streams canonical events back. Product Task, Conversation, projection, and delivery state remain outside both Worker coordination and Harness.

## Invariants

1. There is no Chat/Task execution split. Every invocation belongs to one `AgentRun` and one `AgentSession`.
2. Product schedulers own business state. Loop owns Task/Attempt/parent-child state; IM owns channel occurrences and delivery; AutoPilot owns schedules; Webhook owns endpoint events.
3. `(namespace, agent_id, session_key)` identifies a durable AgentSession. `(agent_session_id, trigger_occurrence_id)` identifies a submission occurrence.
4. Provider resume data is opaque. Harness forwards `providerSession`; it does not parse or synthesize provider thread IDs.
5. A run has one ordered event stream and one terminal outcome.
6. The production Harness outbox is a delivery/recovery ledger, not a second cloud authority.

## Per-Run Context Ownership

The Event producer decides which model context items to send on each run, including selection, project background, task state, or extra items. It may send necessary background initially, an empty model context on subsequent runs, only the items needed now, or explicit repetitions. Required adapter and other execution settings remain subject to execution validation and defaults/mandatory rules; they do not enter the LLM context block or make business context mandatory.

Worker, daemon, worker-access, Host, and adapters validate and forward the current Event snapshot. Host renders only its injectable items, preserving their content and order. They must not cache, supplement, merge, deduplicate, or suppress model context based on session IDs, run numbers, or hashes. Identical items explicitly sent in distinct Events are sent in both runs; Event idempotency remains unchanged.

A provider `sessionId` does not prove resume succeeded. After reset, a new Provider session, or resume failure, the business producer provides the necessary background again. The execution layer reports actual session/recovery results and does not reconstruct background from previous Events. See [Context injection rules](docs/context-llm-injection.md) and the [ecosystem IPD-SE baseline](../docs/event-context-rendering-ipd-se.md). The renderer is implemented in M1; retirement of the old execution pipeline remains pending.

## Production Flow

```text
IM / Loop / AutoPilot / Webhook
        | submit AgentRun(namespace, agent_id, session_key,
        |                 trigger_occurrence_id, input)
        v
Agent Worker
  AgentSession -> AgentRun -> lease/fencing -> run.start
        |
        | authenticated WSS command
        v
Octo Harness daemon
  durable inbox/outbox -> adapter-host -> provider process
        |
        | run.event(seq), provider session update, terminal event
        v
Agent Worker -> business projection / Channel delivery
```

The daemon acknowledges command acceptance before model completion. Event ACKs separately distinguish received and durably committed sequence numbers. Reconnect reports active run IDs so Worker can reconcile accepted-but-lost invocations.

## Identity

| Identity | Owner | Lifetime |
|---|---|---|
| `session_key` | business namespace | stable logical context key |
| `agent_session_id` | Agent Worker | one session generation lineage |
| `agent_run_id` | Agent Worker | one execution |
| `invocation_id` | Harness | one local provider process/call |
| provider `sessionId` | provider | opaque resume identity |

`/reset` never rewrites a provider ID. Worker advances generation/epochs and clears the binding; the next invocation starts without resume state and a later `session.update` installs the new provider ID.

## Runtime Modules

| Module | Responsibility |
|---|---|
| `octo-harness-protocol` | `InvokeRequest`, provider session, canonical events |
| `octo-harness-adapter-host` | adapter registry, invoke/cancel, event lifecycle correction |
| `octo-harness-adapter-*` | provider command construction and native event normalization |
| `apps/daemon/agent-work-runtime` | Worker WSS, command acceptance, durable outbox, ACK/reconnect |
| `octo-harness-core` | single-node AgentSession/AgentRun reference engine |
| `octo-harness-daemon` | reference FIFO execution and recovery |

Provider adapters never create AgentSessions, AgentRuns, Loop Tasks, trigger occurrences, delivery intents, or business retries.

## Canonical Events

```text
run.queued -> run.running
session.update?
message.create -> message.delta* -> message.update
tool_call.create -> tool_call.delta* -> tool_call.update
usage.update*
run.finished | run.error | run.stopped
```

Provider-native events are translated to `CanonicalEvent`. The runtime adds `runId`, `agentSessionId`, monotonic `seq`, timestamp and envelope ID before persistence/transmission. Consumers deduplicate on `(run_id, seq)`. Terminal normalization guarantees exactly one terminal event.

## Reference Profile

The repository includes an in-process Core and SQLite store for adapter tests and standalone diagnosis. Its model is only `Agent`, `AgentSession`, `AgentRun`, and `EventEnvelope`. It intentionally contains no Trigger, Chat, Task, or TaskAttempt tables. In integrated deployments, Worker remains authoritative even when the local diagnostic store is enabled.

## Security And Availability

- Runtime tokens are environment-only secrets.
- Workdir is a provider cwd, not an operating-system boundary.
- Provider bypass modes require external sandboxing.
- Local SQLite assumes one daemon writer.
- Production placement uses Worker leases/fencing; a provider subprocess cannot claim cloud ownership.
- Event outbox rows are removed only after durable ACK.

See [docs/13-agent-work-runtime.md](docs/13-agent-work-runtime.md) for the concrete Worker transport.

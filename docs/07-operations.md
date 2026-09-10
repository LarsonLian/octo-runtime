# Operations

## Start

```bash
export OCTO_HARNESS_HOME=/absolute/runtime/state
export OCTO_HARNESS_AGENT_WORK_URL=http://127.0.0.1:8092
export OCTO_HARNESS_AGENT_WORK_RUNTIME_TOKEN=runtime-token
export OCTO_HARNESS_AGENT_WORK_TENANT_ID=tenant-1
export OCTO_HARNESS_AGENT_WORK_SUBJECT_ID=device-1
pnpm daemon
```

The daemon and CLI must use the same `OCTO_HARNESS_HOME`.

## Inspect

```bash
pnpm cli status
pnpm cli adapter list
pnpm cli adapter probe opencode
pnpm cli logs path
pnpm cli logs query <agent-run-id>
pnpm cli logs query <agent-run-id> --follow
pnpm cli events --run-id <agent-run-id>
pnpm cli events --follow
pnpm cli inspect
pnpm cli inspect url
pnpm cli agent-session list
pnpm cli agent-run list
pnpm cli agent-run get <agent-run-id>
pnpm cli agent-run cancel <agent-run-id> --reason operator_cancel
```

The local bounded event stream is non-durable and does not reconstruct a complete
trajectory. Local AgentSession/AgentRun views are reference diagnostics. Query
Worker for the authoritative production lifecycle and complete trajectory.
The live event sink is process-local and always applies credential redaction and
private-reasoning removal. Sensitive RPC/provider persistence remains explicitly
controlled by the trace and provider-capture settings.

## Health Signals

- Worker WSS connected state and runtime ID.
- active invocation count and command ACK sequence.
- event outbox bytes/rows and durable ACK lag.
- adapter-host PID/readiness.
- channel context cache size/gap state when enabled.
- provider process duration, terminal event and cancellation latency.

Never place Runtime tokens, IM bot tokens, prompts or full provider I/O in
ordinary support output. Restricted traces require explicit local enablement and
retention controls.

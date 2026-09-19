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
pnpm cli diagnostics
pnpm cli events --run-id <agent-run-id>
pnpm cli events --follow
pnpm cli inspect
pnpm cli daemon run --inspect-host 127.0.0.1 --inspect-port 23456
pnpm cli daemon install --inspect-host 127.0.0.1 --inspect-port 23456
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

`diagnostics` builds a metadata-only support bundle from an explicit field
allowlist. It contains package versions, connection state, sequence and ACK
watermarks, store/outbox watermarks, timestamps, bounded error codes, and a
redacted evidence timeline. It never includes credentials, prompts, model
output, tool input/output, provider I/O, outbox payloads, or local filesystem
paths. The inspect server exposes the same bundle at `/api/diagnostics` behind
the capability token. Provider I/O remains a separate restricted capture path
and is never added to this bundle.

The capability-protected `/api/metrics` endpoint exposes local Runtime
connection state, latest recovery duration, outbox watermarks, and store
health. Its `profile` label is intentionally local and high-cardinality; do not
send this endpoint directly to a central metrics store. A management layer must
aggregate by bounded state, trigger, outcome, and health labels first.

Inspect starts with the daemon and defaults to `127.0.0.1` and a random port in
`20001–65535`. It keeps listening even with no browser connected so container and
cloud-image port mappings remain stable. With no WebSocket client there are zero
subscribers; only the byte-bounded daemon event ring remains resident. The
`inspect` command only prints the daemon-owned capability URL. The React SPA
independently retains at most 6000 events or about 6 MiB, prepends the newest frames, and uses TanStack Virtual
to render only visible rows; its recent AgentRuns index retains 100 IDs without
copying event payloads. Changing the local QL filter never reconnects the socket.
Pausing, scrolling away from the top, or expanding an event closes the current
WebSocket and freezes the view. Resume follows from the daemon ring's current
tail, intentionally skipping frames emitted during the pause.
After a disconnect the browser retries after 1, 2, 5, 10 and 30 seconds, then
stops until manual retry. `daemon run` consumes explicit
`--inspect-host` / `--inspect-port` values directly. `daemon install` persists
them in the native service definition and Harness Home. A non-loopback listener
requires TLS and network access control supplied by the deployment; the
capability URL alone is not transport security. Reverse proxies, WAFs and access
logs must not record its `?token=...` query parameter.

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

## Recovery Runbook

Run `octo-harness doctor`, `octo-harness status`, and
`octo-harness diagnostics` first. Keep the bundle's `generatedAt` timestamp and
timeline order as the common clock when correlating Worker and channel evidence.

| Incident | Evidence | Recovery decision |
| --- | --- | --- |
| Local database unavailable | `storeHealth`, `dbBytes`, `walBytes`, error code | Stop new Run admission. Preserve a corrupt database under its quarantine name, restart after storage repair, and confirm `storeHealth.state=healthy`. |
| Orphan provider execution | adapter-host restart count, invocation ID, terminal timestamp | Confirm the old process group was reaped before retrying. Use the authoritative Worker terminal state to avoid duplicate execution. |
| Reconnect storm | `connectionState`, reconnect attempt, connected profile counts | Verify randomized backoff is increasing and dependency health is stable. Do not restart the whole fleet simultaneously. |
| DNS, TLS, or clock failure | `connectionReason`, recovery trigger, bounded error code | Treat `dns`, `tls`, `clock_change`, and `auth` separately. Never bypass certificate validation; repair name resolution, trust, system time, or credentials before retrying. |
| Offline budget exhausted | oldest outbox age, pending rows/bytes, last ACK | Restore connectivity or free local storage. Acknowledge or replay only through the protocol; never edit outbox rows manually. |
| Dependency degradation | HTTP status, bounded error code, timeout stage | Identify whether auth, Worker, Redis, MySQL, or the provider is degraded. Recover that dependency before raising retry limits. |
| Outbox watermark pressure | pending bytes/rows, oldest age, database and WAL bytes | Remove the upstream ACK blockage. New work remains rejected at the hard watermark until durable ACK cleanup lowers usage. |
| Evidence timeline disagreement | generation, server sequence, ACK, occurrence/run/invocation IDs | Order facts by source timestamp and sequence, then accept Worker terminal authority. Escalate only with the metadata bundle and separately approved restricted capture. |

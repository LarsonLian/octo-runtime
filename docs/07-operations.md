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
pnpm cli agent-session list
pnpm cli agent-run list
pnpm cli agent-run get <agent-run-id>
pnpm cli agent-run cancel <agent-run-id> --reason operator_cancel
```

For local Host debugging, set the environment variable before starting Harness:

```bash
OCTO_RUNTIME_DEBUG=1 octo-harness daemon run
# With a custom Home:
OCTO_RUNTIME_DEBUG=1 octo-harness --home /absolute/runtime/state daemon run
tail -f /absolute/runtime/state/logs/adapter-host.log
```

Only the exact value `1` enables file logging. Otherwise no debug log directory or
file is created. The Host appends lifecycle, watchdog and stdio RPC records to
`<Harness Home>/logs/adapter-host.log`; restarted Host processes use the same file.
The default Home is `~/.octo-harness` (or `%LOCALAPPDATA%/OctoHarness` on Windows).
Set the variable in the service environment when running Harness as a native service.
Changing a shell environment does not change an already running daemon.

The file is local debug output and may contain invocation input and output. It is
created with owner-only permissions. There is no automatic rotation or retention;
remove the file when no longer needed. A write failure reports once on stderr and
does not interrupt execution. There is no Provider-native capture, observation ring,
subscriber transport, Inspect HTTP/WebSocket server or support-bundle service.
Use Worker for the authoritative production lifecycle and complete trajectory.

## Health Signals

- Worker WSS connected state and runtime ID.
- active invocation count and command ACK sequence.
- event outbox bytes/rows and durable ACK lag.
- adapter-host PID/readiness.
- channel context cache size/gap state when enabled.
- provider process duration, terminal event and cancellation latency.

Keep local debug logs private because they can contain execution data.

## Recovery Runbook

Run `octo-harness doctor` and `octo-harness status` first. Enable Host debug logging
when reproducing a problem, and correlate its timestamps and invocation IDs with Worker.

| Incident | Evidence | Recovery decision |
| --- | --- | --- |
| Local database unavailable | `storeHealth`, `dbBytes`, `walBytes`, error code | Stop new Run admission. Preserve a corrupt database under its quarantine name, restart after storage repair, and confirm `storeHealth.state=healthy`. |
| Orphan provider execution | adapter-host restart count, invocation ID, terminal timestamp | Confirm the old process group was reaped before retrying. Use the authoritative Worker terminal state to avoid duplicate execution. |
| Reconnect storm | `connectionState`, reconnect attempt, connected profile counts | Verify randomized backoff is increasing and dependency health is stable. Do not restart the whole fleet simultaneously. |
| DNS, TLS, or clock failure | `connectionReason`, recovery trigger, bounded error code | Treat `dns`, `tls`, `clock_change`, and `auth` separately. Never bypass certificate validation; repair name resolution, trust, system time, or credentials before retrying. |
| Offline budget exhausted | oldest outbox age, pending rows/bytes, last ACK | Restore connectivity or free local storage. Acknowledge or replay only through the protocol; never edit outbox rows manually. |
| Dependency degradation | HTTP status, bounded error code, timeout stage | Identify whether auth, Worker, Redis, MySQL, or the provider is degraded. Recover that dependency before raising retry limits. |
| Outbox watermark pressure | pending bytes/rows, oldest age, database and WAL bytes | Remove the upstream ACK blockage. New work remains rejected at the hard watermark until durable ACK cleanup lowers usage. |
| Evidence timeline disagreement | generation, server sequence, ACK, occurrence/run/invocation IDs | Order facts by source timestamp and sequence, then accept Worker terminal authority. Use the Host debug log when additional execution evidence is needed. |

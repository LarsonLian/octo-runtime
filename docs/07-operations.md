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
